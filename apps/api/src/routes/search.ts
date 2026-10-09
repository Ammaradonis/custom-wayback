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

export const searchRouter = new Hono<{ Bindings: Env }>();

searchRouter.use("/*", async (c, next) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
});

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
