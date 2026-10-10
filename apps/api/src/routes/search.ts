/**
 * Cross-domain search over crawled snapshots (plan.md §15).
 *
 *  GET /v1/search?q=…            — full-text search across every crawled domain
 *  GET /v1/search?q=…&domain=…   — scoped to one domain
 *  GET /v1/search?q=…&month=YYYY-MM
 *
 * Results are always scoped to the domains the asking user owns, applied by a
 * join in `lib/search.ts` rather than a filter here — so there is exactly one
 * place where ownership is decided.
 *
 * This route is throttled on the *read* budget. A search hits two aggregate
 * queries over an FTS index, which is the most D1 work any single request in this
 * app does, so it is the one read endpoint where a runaway client could actually
 * cost something.
 */

import { Hono } from "hono";
import type { Env } from "../env.js";
import { authenticateRequest } from "../lib/auth.js";
import { consumeRateLimit, userBucket } from "../lib/ratelimit.js";
import { SearchInputError, searchSnapshots } from "../lib/search.js";
import { indexStatements } from "../lib/index-page.js";

export const searchRouter = new Hono<{ Bindings: Env }>();

searchRouter.use("/*", async (c, next) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
});

/**
 * Rebuild the search index for the caller's own snapshots.
 *
 * Why this exists rather than "the next crawl will fix it": almost every real
 * archive has pages that were crawled **before** search existed. Without a
 * backfill, search silently returns nothing for exactly the content you care
 * most about, and the natural conclusion is that search is broken.
 *
 * It reads the rewritten HTML back out of R2 rather than re-fetching from
 * archive.org. That is deliberate on two counts: it costs zero archive.org
 * requests (plan.md §12), and it indexes the *rewritten* page — the same bytes
 * the viewer serves — so the index and the rendered page cannot disagree.
 *
 * Pages whose R2 blob has already been purged by the post-serve job are reported
 * as skipped, not silently omitted. That number is the honest one: it is the
 * amount of your archive that search cannot see, and the fix is a re-crawl.
 */
searchRouter.post("/reindex", async (c) => {
  const userId = c.get("userId" as never) as string;

  // Writing an index is expensive, so it comes out of the crawl budget rather
  // than the read budget.
  const limit = await consumeRateLimit(c.env, userBucket(userId, "jobs"), "jobs");
  if (!limit.allowed) {
    return c.json(
      { error: "rate_limited", message: `Too many reindex requests. Try again in ${limit.retryAfter}s.`, retryAfter: limit.retryAfter },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  const domain = c.req.query("domain");
  const month = c.req.query("month");
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ error: "month must be YYYY-MM" }, 400);
  }

  // Bound the work per request. A full re-index of a large archive is a job, not
  // a request; callers repeat until `remaining` reaches zero.
  const batch = 200;

  const filters = ["d.user_id = ?", "s.r2_key IS NOT NULL"];
  const params: unknown[] = [userId];
  if (domain) {
    filters.push("s.domain = ?");
    params.push(domain);
  }
  if (month) {
    filters.push("s.day LIKE ?");
    params.push(`${month}-%`);
  }

  const candidates = await c.env.DB.prepare(
    `SELECT s.id AS id, s.domain AS domain, s.url AS url, s.day AS day,
            s.ts AS ts, s.r2_key AS r2_key, s.bytes AS bytes
     FROM snapshots s
     JOIN ingests i ON i.id = s.ingest_id
     JOIN domains d ON d.id = i.domain_id
     LEFT JOIN search_docs sd ON sd.snapshot_id = s.id
     WHERE ${filters.join(" AND ")} AND sd.snapshot_id IS NULL
     ORDER BY s.day DESC
     LIMIT ?`,
  )
    .bind(...params, batch)
    .all<{ id: string; domain: string; url: string; day: string; ts: string; r2_key: string; bytes: number | null }>();

  const rows = candidates.results ?? [];
  let indexed = 0;
  let skipped = 0;
  let empty = 0;

  for (const row of rows) {
    const object = await c.env.STORAGE.get(row.r2_key);
    if (!object) {
      // Purged since the crawl. Counted, never silently dropped.
      skipped += 1;
      continue;
    }
    const html = await object.text();
    const statements = indexStatements(c.env, {
      snapshotId: row.id,
      domain: row.domain,
      url: row.url,
      day: row.day,
      ts: row.ts,
      html,
      bytes: row.bytes ?? html.length,
    });
    if (statements.length === 0) {
      empty += 1;
      continue;
    }
    try {
      await c.env.DB.batch(statements);
      indexed += 1;
    } catch (err) {
      console.error(`[search] reindex failed for ${row.url}: ${err instanceof Error ? err.message : String(err)}`);
      skipped += 1;
    }
  }

  const remaining = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM snapshots s
     JOIN ingests i ON i.id = s.ingest_id
     JOIN domains d ON d.id = i.domain_id
     LEFT JOIN search_docs sd ON sd.snapshot_id = s.id
     WHERE ${filters.join(" AND ")} AND sd.snapshot_id IS NULL`,
  )
    .bind(...params)
    .first<{ n: number }>();

  return c.json({
    indexed,
    skipped,
    /** Stored pages that yielded no indexable text (JS shells, image-only pages). */
    empty,
    remaining: remaining?.n ?? 0,
    done: (remaining?.n ?? 0) === 0,
  });
});

/** Search the index. Always scoped to the caller's own domains. */
searchRouter.get("/", async (c) => {
  const userId = c.get("userId" as never) as string;

  const limit = await consumeRateLimit(c.env, userBucket(userId, "read"), "read");
  c.header("X-RateLimit-Remaining", String(limit.remaining));
  if (!limit.allowed) {
    return c.json(
      { error: "rate_limited", retryAfter: limit.retryAfter },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  const q = c.req.query("q") ?? "";
  const domain = c.req.query("domain") || undefined;
  const month = c.req.query("month") || undefined;
  const day = c.req.query("day") || undefined;

  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ error: "month must be YYYY-MM" }, 400);
  }
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return c.json({ error: "day must be YYYY-MM-DD" }, 400);
  }

  const limitParam = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const pageSize = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;
  const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

  try {
    const result = await searchSnapshots(c.env, userId, {
      q,
      limit: pageSize,
      offset,
      ...(domain !== undefined ? { domain } : {}),
      ...(month !== undefined ? { month } : {}),
      ...(day !== undefined ? { day } : {}),
    });

    return c.json({
      ...result,
      limit: pageSize,
      offset,
      hasMore: offset + result.hits.length < result.total,
    });
  } catch (err) {
    if (err instanceof SearchInputError) {
      // User input we refuse to search on. A 400 with the reason, never a 500:
      // an unparseable FTS5 expression must not look like a server fault.
      return c.json({ error: "invalid_query", message: err.message }, 400);
    }
    const message = err instanceof Error ? err.message : String(err);
    // A malformed FTS5 expression reaching the database is a bug in the query
    // builder, not the caller's fault — say so plainly instead of returning an
    // empty result set that looks like "no matches".
    if (/fts5|malformed MATCH|syntax error/i.test(message)) {
      console.error(`[search] FTS5 rejected a built expression: ${message}`);
      return c.json(
        {
          error: "search_unavailable",
          message: "The search index rejected this query. Try different words.",
        },
        422,
      );
    }
    console.error(`[search] failed: ${message}`);
    return c.json({ error: "search_failed", message: "Search is temporarily unavailable." }, 503);
  }
});
