/**
 * Share links (plan.md §2.1 "Every view is shareable", §15).
 *
 *  POST   /v1/shares        — mint a link for a domain+month (or one page)
 *  GET    /v1/shares        — list the caller's links
 *  DELETE /v1/shares/:id    — revoke one
 *  GET    /v1/shares/resolve?token=…  — resolve a token (used by the viewer)
 *
 * ## What a share link is, and what it is not
 *
 * It is a **capability**, not an account. `plan.md` §12 rule 7 keeps this personal
 * and §13 keeps it behind Cloudflare Access; a share link does **not** bypass
 * that. It reuses the same `/a/...` viewer route, so it is protected by whatever
 * protects the app. What the token adds is a stable, revocable URL for a scope the
 * viewer already knows how to serve — so a link kept in notes survives a
 * re-crawl, and stops working the instant it is revoked.
 *
 * Being honest about that matters: someone who reads "share link" and assumes it
 * is publicly reachable will paste it somewhere public. The response therefore
 * carries an explicit `accessNote` rather than leaving the reader to infer it.
 *
 * ## Why the token is stored hashed
 *
 * A leaked database should not hand out working links, for the same reason it
 * should not hand out passwords. Resolution only ever looks a token *up*, so the
 * plaintext is shown once at creation and never needed again.
 *
 * ## Why the token has 128 bits of entropy
 *
 * It is a bearer credential in a URL: it will end up in browser history, in a
 * chat log, in a screenshot. 32 hex characters of `crypto.getRandomValues` makes
 * guessing hopeless, which is the only defence a capability URL has.
 */

import { Hono } from "hono";
import type { Env } from "../env.js";
import { authenticateRequest } from "../lib/auth.js";
import { consumeRateLimit, userBucket } from "../lib/ratelimit.js";
import { ulid } from "../lib/ulid.js";

export const sharesRouter = new Hono<{ Bindings: Env }>();

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 128 bits, hex. Long enough that guessing is not a threat model. */
function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const ACCESS_NOTE =
  "This link is protected by the same access control as the app itself " +
  "(plan.md §13: Cloudflare Access). It is a stable, revocable reference to a " +
  "snapshot — not a public URL. Anyone who can open the app can open it; anyone " +
  "who cannot, cannot.";

// ── Authenticated management ─────────────────────────────────────────────────
//
// Scoped `/*`, not `/`: a bare `/` pattern does not match parameterised child
// routes, so `DELETE /:id` would run with no user set.
//
// The resolve endpoint is exempt because it is the one route a share recipient
// hits with only the token. Everything else needs a bearer token.

sharesRouter.use("/*", async (c, next) => {
  if (c.req.path.endsWith("/resolve")) return next();
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
});

sharesRouter.post("/", async (c) => {
  const userId = c.get("userId" as never) as string;

  // Minting is cheap, but an unbounded pile of live capabilities is not something
  // to create by accident, so it shares the crawl budget rather than being free.
  const limit = await consumeRateLimit(c.env, userBucket(userId, "jobs"), "jobs");
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retryAfter: limit.retryAfter }, 429, {
      "Retry-After": String(limit.retryAfter),
    });
  }

  let body: { domain?: string; month?: string; day?: string; url?: string; label?: string; expiresInDays?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body" }, 400);
  }

  const domain = body.domain?.trim();
  if (!domain) return c.json({ error: "domain is required" }, 400);
  if (body.month && !MONTH.test(body.month)) return c.json({ error: "month must be YYYY-MM" }, 400);
  if (body.day && !DAY.test(body.day)) return c.json({ error: "day must be YYYY-MM-DD" }, 400);
  // A day or a url without a month would scope a link to something the viewer
  // cannot resolve, so refuse rather than mint a link that 404s.
  if ((body.day || body.url) && !body.month) {
    return c.json({ error: "month is required when day or url is given" }, 400);
  }

  const owned = await c.env.DB.prepare(
    `SELECT id FROM domains WHERE domain = ? AND user_id = ? AND tracking_status != 'deleted'`,
  )
    .bind(domain, userId)
    .first<{ id: string }>();
  if (!owned) return c.json({ error: "Domain not found" }, 404);

  const token = mintToken();
  const tokenHash = await hashToken(token);
  const id = ulid();
  const now = Math.floor(Date.now() / 1000);
  const days = Number.isFinite(body.expiresInDays) ? Math.max(1, Math.min(365, body.expiresInDays as number)) : null;
  const expiresAt = days === null ? null : now + days * 86_400;

  await c.env.DB.prepare(
    `INSERT INTO share_links
       (id, user_id, token_hash, domain, month, day, url, label, created_at, expires_at, view_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
  )
    .bind(
      id,
      userId,
      tokenHash,
      domain,
      body.month ?? null,
      body.day ?? null,
      body.url ?? null,
      body.label ?? null,
      now,
      expiresAt,
    )
    .run();

  // The viewer route the link resolves to. Building it here means the client does
  // not have to know the route shape, and a route change cannot silently break
  // every link already handed out.
  const target = body.url && body.month && body.day
    ? `/a/${domain}/${body.day}${pathOf(body.url)}`
    : `/s/${token}`;

  return c.json(
    {
      id,
      /** Shown once. Only the hash is stored, so this cannot be recovered later. */
      token,
      shareUrl: `/s/${token}`,
      resolvesTo: target,
      domain,
      month: body.month ?? null,
      day: body.day ?? null,
      url: body.url ?? null,
      label: body.label ?? null,
      createdAt: now,
      expiresAt,
      accessNote: ACCESS_NOTE,
    },
    201,
  );
});

sharesRouter.get("/", async (c) => {
  const userId = c.get("userId" as never) as string;
  const rows = await c.env.DB.prepare(
    `SELECT id, domain, month, day, url, label, created_at, expires_at, revoked_at, view_count, last_viewed_at
     FROM share_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(userId)
    .all();
  return c.json({
    shares: rows.results,
    // State the token is never returned after creation, so a UI does not promise
    // a "copy link" button it cannot honour for older entries.
    note: "Tokens are stored hashed and shown only at creation. Revoke and re-create to get a new link.",
  });
});

sharesRouter.delete("/:id", async (c) => {
  const userId = c.get("userId" as never) as string;
  // `c.req.param()` types as possibly-undefined, and a missing id reaching D1 as
  // `undefined` is a hard error ("Type 'undefined' not supported") rather than a
  // no-op match. Validate here so a malformed path is a 400, not a 500.
  const id = c.req.param("id");
  if (typeof id !== "string" || id.length === 0) {
    return c.json({ error: "A share id is required" }, 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE share_links SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
  )
    .bind(Math.floor(Date.now() / 1000), id, userId)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return c.json({ error: "Not found or already revoked" }, 404);
  }
  return c.json({ ok: true });
});

// ── Public resolution ────────────────────────────────────────────────────────
//
// Registered last so the authenticated routes above take precedence. Hono matches
// in registration order, and "resolve" must not be read as a share id.

sharesRouter.get("/resolve", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "token is required" }, 400);

  const tokenHash = await hashToken(token);
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, s.domain, s.month, s.day, s.url, s.label, s.expires_at, s.revoked_at, s.view_count
     FROM share_links s WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{
      id: string;
      user_id: string;
      domain: string;
      month: string | null;
      day: string | null;
      url: string | null;
      label: string | null;
      expires_at: number | null;
      revoked_at: number | null;
      view_count: number;
    }>();

  if (!row) return c.json({ error: "Unknown or expired link" }, 404);
  if (row.revoked_at !== null) return c.json({ error: "This link has been revoked" }, 410);

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at !== null && row.expires_at < now) {
    return c.json({ error: "This link has expired" }, 410);
  }

  // Record the view. Fire-and-forget: a failed counter must never deny access to
  // a link the owner legitimately created.
  c.executionCtx.waitUntil(
    c.env.DB.prepare(`UPDATE share_links SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?`)
      .bind(now, row.id)
      .run()
      .catch(() => void 0),
  );

  const route =
    row.url && row.day
      ? `/a/${row.domain}/${row.day}${pathOf(row.url)}`
      : `/viewer?domain=${encodeURIComponent(row.domain)}${row.month ? `&month=${row.month}` : ""}`;

  return c.json({
    shareId: row.id,
    domain: row.domain,
    month: row.month,
    day: row.day,
    url: row.url,
    label: row.label,
    route,
    expiresAt: row.expires_at,
    viewCount: row.view_count + 1,
    accessNote: ACCESS_NOTE,
  });
});

/** Path (+ encoded query) of an absolute URL, for a viewer route. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    if (!path.startsWith("/")) path = `/${path}`;
    const suffix = parsed.search ? `%3F${encodeURIComponent(parsed.search.slice(1))}` : "";
    return `${path}${suffix}`;
  } catch {
    return "/";
  }
}
