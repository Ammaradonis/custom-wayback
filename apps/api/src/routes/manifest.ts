/**
 * Manifest API — powers the day-strip and page list in the viewer shell.
 *
 * GET /v1/sites                                 — all crawled domain+month pairs
 * GET /v1/manifest?domain=<d>&month=<YYYY-MM>   — full manifest for a mirror
 *
 * These mirror the local viewer's /api/sites and /api/manifest routes so the
 * React shell and the local Node viewer share the same data contract.
 */

import { Hono } from "hono";
import type { Env } from "../env.js";
import { authenticateRequest } from "../lib/auth.js";

export const manifestRouter = new Hono<{ Bindings: Env }>();

// ── Auth middleware ───────────────────────────────────────────────────────────

manifestRouter.use("/*", async (c, next) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
});

// ── Sites list ─────────────────────────────────────────────────────────────────

manifestRouter.get("/sites", async (c) => {
  const userId = c.get("userId" as never) as string;

  // Return all ready/partial ingests for domains the user owns.
  const rows = await c.env.DB.prepare(
    `SELECT d.domain, substr(i.month, 1, 7) AS month,
            COUNT(s.id) AS pages,
            COUNT(DISTINCT s.day) AS days
     FROM ingests i
     JOIN domains d ON d.id = i.domain_id AND d.user_id = ?
     LEFT JOIN snapshots s ON s.ingest_id = i.id
     WHERE i.status IN ('ready', 'partial')
     GROUP BY d.domain, i.month
     ORDER BY d.domain, i.month`,
  )
    .bind(userId)
    .all();

  return c.json({ sites: rows.results });
});

// ── Manifest for a domain+month ───────────────────────────────────────────────

manifestRouter.get("/manifest", async (c) => {
  const userId = c.get("userId" as never) as string;
  const domain = c.req.query("domain");
  const month = c.req.query("month");

  if (!domain || !month) {
    return c.json({ error: "domain and month are required" }, 400);
  }

  // Verify ownership.
  const domainRow = await c.env.DB.prepare(
    "SELECT id FROM domains WHERE domain = ? AND user_id = ? AND tracking_status != 'deleted'",
  )
    .bind(domain, userId)
    .first<{ id: string }>();
  if (!domainRow) return c.json({ error: "Not found" }, 404);

  // Check for a cached manifest in R2.
  const metaKey = `meta/${domain}/${month}/manifest.json.gz`;
  const cached = await c.env.STORAGE.get(metaKey);
  if (cached) {
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      "Cache-Control": "public, max-age=300",
    });
    return new Response(cached.body, { headers });
  }

  // Build live from D1.
  const ingest = await c.env.DB.prepare(
    `SELECT i.id, i.status, i.budget_json
     FROM ingests i
     JOIN domains d ON d.id = i.domain_id
     WHERE d.domain = ? AND d.user_id = ? AND i.month = ?
     ORDER BY i.started_at DESC LIMIT 1`,
  )
    .bind(domain, userId, month)
    .first<{ id: string; status: string; budget_json: string }>();

  if (!ingest) return c.json({ error: "No ingest found" }, 404);

  const snapshots = await c.env.DB.prepare(
    `SELECT url, day, ts, page_id AS route, resolved_day, delta_days,
            r2_key IS NOT NULL AS stored, purged_at IS NOT NULL AS purged
     FROM snapshots
     WHERE ingest_id = ?
     ORDER BY day, url`,
  )
    .bind(ingest.id)
    .all();

  const days = [...new Set(
    (snapshots.results as { day: string }[]).map((r) => r.day),
  )].sort();

  const pages = (snapshots.results as {
    url: string; day: string; ts: string; route: string | null;
    resolved_day: string | null; delta_days: number | null;
    stored: number; purged: number;
  }[]).map((r) => ({
    url: r.url,
    day: r.day,
    ts: r.ts,
    title: null, // titles not stored in D1; available via the rewritten HTML
    bytes: null,
    route: r.route ? `/a/${domain}/${r.day}/${r.route}` : `/a/${domain}/${r.day}/`,
    resolvedDay: r.resolved_day,
    deltaDays: r.delta_days,
    stored: Boolean(r.stored),
    purged: Boolean(r.purged),
  }));

  return c.json({
    version: 1,
    domain,
    month,
    days,
    pages,
    stats: null,
    note: "assembled live from D1",
  });
});
