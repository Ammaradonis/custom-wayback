/**
 * Viewer Worker route: /a/:domain/:day/*
 *
 * Fast plane: Workers Cache API → R2 → on-demand id_ fetch.
 * After serving, records served_at in D1 so the purge job can delete the R2 blob.
 *
 * Nearest-capture resolution:
 *  If the requested day has no snapshot, the link_resolutions table is consulted
 *  and we redirect to the nearest captured day.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../env.js";
import { serveCachedPage, markServed } from "../lib/r2.js";
import { WAYBACK_RAW_BASE } from "@custom-wayback/shared";

type HonoCtx = Context<{ Bindings: Env }>;

export const viewerRouter = new Hono<{ Bindings: Env }>();

// ── Serve archived page ───────────────────────────────────────────────────────

viewerRouter.get("/:domain/:day/*", async (c) => {
  const { domain, day } = c.req.param();
  const path = "/" + c.req.param("*");

  // 1. Look up the snapshot ledger.
  const snap = await c.env.DB.prepare(
    `SELECT id, r2_key, ts, resolved_day, delta_days, purged_at, served_at
     FROM snapshots
     WHERE domain = ? AND day = ? AND url LIKE ?
     LIMIT 1`,
  )
    .bind(domain, day, `%${path}`)
    .first<{
      id: string;
      r2_key: string | null;
      ts: string;
      resolved_day: string | null;
      delta_days: number | null;
      purged_at: number | null;
      served_at: number | null;
    }>();

  // 2. Nearest-capture redirect if no snapshot for this exact day.
  if (!snap) {
    if (c.env.SNAPSHOT_BEHAVIOR === "nearest") {
      const nearest = await c.env.DB.prepare(
        `SELECT resolved_day FROM link_resolutions
         WHERE domain = ? AND to_url LIKE ? AND resolved_day IS NOT NULL
         ORDER BY ABS(delta_days) ASC LIMIT 1`,
      )
        .bind(domain, `%${path}`)
        .first<{ resolved_day: string }>();
      if (nearest) {
        return c.redirect(`/a/${domain}/${nearest.resolved_day}${path}`, 302);
      }
    }
    return new Response("No capture found for this page.", { status: 404 });
  }

  // 3. If content already purged, do an on-demand id_ fetch.
  if (snap.purged_at !== null || !snap.r2_key) {
    return fetchOnDemand(domain, day, path, snap.ts, c.env);
  }

  // 4. Try Workers Cache API → R2.
  const cacheKey = `https://cache.internal/a/${domain}/${day}${path}`;
  const response = await serveCachedPage(snap.r2_key, cacheKey, c.env, c.executionCtx as unknown as ExecutionContext);
  if (response) {
    // Record served_at (fire-and-forget) so purge job can act.
    c.executionCtx.waitUntil(markServed(c.env, snap.id));
    injectToolbarHeaders(response, snap.resolved_day, snap.delta_days);
    return response;
  }

  // 5. Full cache miss — on-demand fetch.
  return fetchOnDemand(domain, day, path, snap.ts, c.env);
});

// ── On-demand id_ fetch ───────────────────────────────────────────────────────

async function fetchOnDemand(
  domain: string,
  day: string,
  path: string,
  ts: string,
  env: Env,
): Promise<Response> {
  const originalUrl = `https://${domain}${path}`;
  const rawUrl = `${WAYBACK_RAW_BASE}/${ts}id_/${originalUrl}`;

  const upstream = await fetch(rawUrl, {
    headers: { "User-Agent": env.CRAWLER_USER_AGENT },
  });

  if (!upstream.ok) {
    return new Response(`Archive fetch failed: ${upstream.status}`, {
      status: 502,
    });
  }

  // Stream with minimal rewrite (base href + CSP).
  const rewritten = new HTMLRewriter()
    .on("head", {
      element(el) {
        el.prepend(
          `<base href="/a/${domain}/${day}/">
           <meta http-equiv="Content-Security-Policy"
                 content="default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self';">`,
          { html: true },
        );
      },
    })
    .transform(upstream);

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "X-Custom-Wayback-Source": "on-demand",
    "X-Robots-Tag": "noindex",
  });
  return new Response(rewritten.body, { status: 200, headers });
}

// ── Toolbar headers ───────────────────────────────────────────────────────────

function injectToolbarHeaders(
  response: Response,
  resolvedDay: string | null,
  deltaDays: number | null,
): void {
  if (resolvedDay) {
    response.headers.set("X-Wayback-Resolved-Day", resolvedDay);
  }
  if (deltaDays !== null) {
    response.headers.set("X-Wayback-Delta-Days", String(deltaDays));
  }
}
