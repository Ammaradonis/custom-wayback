/**
 * Throttling for our own API.
 *
 * Three distinct limits, because they protect three different things:
 *
 *  1. **Circuit breaker** (in the queue consumer, see `src/queue/`) protects
 *     *archive.org* from us. That is the important one — plan.md §12.
 *  2. **Request rate limits** (this file) protect *our own* Worker and D1 from a
 *     runaway client or a leaked token. Fixed-window counters live in D1, so
 *     this needs no extra service and no Redis.
 *  3. **Crawl quota** (this file) protects the *bill*. Starting a crawl is the
 *     only expensive operation a user can trigger, so it is counted per day and
 *     refused at the cap with a message that says when it resets.
 *
 * Everything here fails **open**: if D1 is having a bad minute, we serve the
 * request rather than locking the owner out of their own tool. A rate limiter
 * that turns a database blip into an outage is worse than no rate limiter.
 */

import type { Env } from "../env.js";
import {
  DEFAULT_CRAWL_QUOTA_PER_DAY,
  RATE_LIMITS,
  type RateLimitPolicy,
} from "@custom-wayback/shared";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the window resets. */
  resetAt: number;
  /** Seconds to wait — only meaningful when `allowed` is false. */
  retryAfter: number;
  /** The policy that was applied. */
  policy: RateLimitPolicy;
}

function policyFor(name: string): RateLimitPolicy {
  return RATE_LIMITS[name] ?? { windowSeconds: 60, limit: 60 };
}

/**
 * Consume one token from `bucket`.
 *
 * Uses a single UPSERT with `RETURNING count`, so a check-and-increment is one
 * D1 round trip and cannot race with a concurrent request from the same user.
 */
export async function consumeRateLimit(
  env: Env,
  bucket: string,
  policyName: string,
): Promise<RateLimitResult> {
  const policy = policyFor(policyName);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % policy.windowSeconds);
  const resetAt = windowStart + policy.windowSeconds;

  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, window_start, count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
       RETURNING count`,
    )
      .bind(bucket, windowStart, now)
      .first<{ count: number }>();

    const count = row?.count ?? 1;
    const allowed = count <= policy.limit;
    return {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      resetAt,
      retryAfter: allowed ? 0 : Math.max(1, resetAt - now),
      policy,
    };
  } catch {
    // Fail open — see the module comment.
    return {
      allowed: true,
      limit: policy.limit,
      remaining: policy.limit,
      resetAt,
      retryAfter: 0,
      policy,
    };
  }
}

/**
 * Crawl quota: how many crawls this user may start in the current UTC day.
 * Counted by summing the `jobs` rate-limit bucket would be wrong (that bucket
 * is hourly), so the day counter lives on `usage_ledger`, which already records
 * one `ia_fetch` row per archive.org request and is the natural home for it.
 */
export async function crawlQuota(
  env: Env,
  userId: string,
): Promise<{ limit: number; used: number; remaining: number; resetsAt: number }> {
  const limit = Number.parseInt(env.CRAWL_QUOTA_PER_DAY ?? "", 10) || DEFAULT_CRAWL_QUOTA_PER_DAY;
  const now = new Date();
  const dayStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
  const resetsAt = dayStart + 86_400;

  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS used FROM ingests i
       JOIN domains d ON d.id = i.domain_id
       WHERE d.user_id = ? AND i.started_at >= ?`,
    )
      .bind(userId, dayStart)
      .first<{ used: number }>();
    const used = row?.used ?? 0;
    return { limit, used, remaining: Math.max(0, limit - used), resetsAt };
  } catch {
    return { limit, used: 0, remaining: limit, resetsAt };
  }
}

/** Identity for a rate-limit bucket. Users are keyed by id; anonymous callers by IP hash. */
export function userBucket(userId: string, scope: string): string {
  return `user:${userId}:${scope}`;
}

export function ipBucket(ipHash: string, scope: string): string {
  return `ip:${ipHash}:${scope}`;
}

/**
 * Prune expired rate-limit windows. Called from the cron trigger — an unbounded
 * counter table is the classic way a "free" rate limiter becomes a storage bill.
 */
export async function pruneRateLimits(env: Env): Promise<number> {
  // Keep one extra window of slack so a request that started just before the
  // boundary still sees its row.
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  const res = await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
    .bind(cutoff)
    .run();
  return res.meta.changes ?? 0;
}
