/**
 * Ingest job routes.
 *
 *  POST   /v1/jobs              — start a crawl job (quota + budget checked, then queued)
 *  GET    /v1/jobs/:ingestId    — job status: checkpoint, stage, throttle state
 *  GET    /v1/jobs/:ingestId/events — SSE progress stream
 *  DELETE /v1/jobs/:ingestId    — cancel
 *
 *  GET    /v1/usage             — cost monitoring: modelled spend, budget, throttle
 *  GET    /v1/usage/limits      — the limits currently in force, for the UI
 *
 * Throttling has three layers here and it is worth knowing which is which:
 *   - `consumeRateLimit(..., "jobs")` stops a client hammering the start endpoint.
 *   - `crawlQuota` caps how many crawls one user starts per UTC day.
 *   - the budget guardrail refuses *any* new crawl once the month's modelled cost
 *     has crossed `MONTHLY_BUDGET_USD`. That is the one that protects the bill.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  DEFAULT_BUDGET,
  DEFAULT_CRAWL_QUOTA_PER_DAY,
  StartIngestSchema,
  type IngestQueueMessage,
  type ThrottleState,
} from "@custom-wayback/shared";
import { authenticateRequest } from "../lib/auth.js";
import { ulid } from "../lib/ulid.js";
import { consumeRateLimit, crawlQuota, userBucket } from "../lib/ratelimit.js";
import { buildUsageReport, currentMonth, budgetUsdFromEnv } from "../lib/cost.js";
import type { Env } from "../env.js";

export const ingestRouter = new Hono<{ Bindings: Env }>();

// ── Auth middleware ───────────────────────────────────────────────────────────

ingestRouter.use("/*", async (c, next) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
});

/** Read throttling: generous, but not unlimited — every read is D1 rows read. */
ingestRouter.use("/*", async (c, next) => {
  if (c.req.method !== "GET") return next();
  const userId = c.get("userId" as never) as string;
  const limit = await consumeRateLimit(c.env, userBucket(userId, "read"), "read");
  c.header("X-RateLimit-Limit", String(limit.limit));
  c.header("X-RateLimit-Remaining", String(limit.remaining));
  c.header("X-RateLimit-Reset", String(limit.resetAt));
  if (!limit.allowed) {
    return c.json(
      { error: "Too many requests", retryAfter: limit.retryAfter },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }
  return next();
});

// ── Start a job ───────────────────────────────────────────────────────────────

ingestRouter.post("/", zValidator("json", StartIngestSchema), async (c) => {
  const userId = c.get("userId" as never) as string;
  const { domainId, month, budgetOverride } = c.req.valid("json");

  // 1. Request throttle — the cheap, always-on layer.
  const limit = await consumeRateLimit(c.env, userBucket(userId, "jobs"), "jobs");
  if (!limit.allowed) {
    return c.json(
      {
        error: "rate_limited",
        message: `Too many crawl requests. Try again in ${limit.retryAfter}s.`,
        retryAfter: limit.retryAfter,
      },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  // 2. Daily crawl quota — bounds how much work one account can ask for.
  const quota = await crawlQuota(c.env, userId);
  if (quota.remaining <= 0) {
    return c.json(
      {
        error: "quota_exceeded",
        message: `Daily crawl quota (${quota.limit}) reached. It resets at ${new Date(quota.resetsAt * 1000).toISOString()}.`,
        quota,
      },
      429,
    );
  }

  // 3. Budget guardrail — the layer that actually protects the invoice.
  const report = await buildUsageReport(c.env, userId, currentMonth());
  if (report.budget.crawlsBlocked) {
    return c.json(
      {
        error: "budget_exceeded",
        message:
          `Monthly ingest budget reached: $${report.budget.spentUsd.toFixed(2)} of ` +
          `$${report.budget.budgetUsd.toFixed(2)}. Raise MONTHLY_BUDGET_USD to continue.`,
        budget: report.budget,
      },
      402,
    );
  }

  // Verify the user owns this domain.
  const domainRow = await c.env.DB.prepare(
    "SELECT id, domain, budget_json FROM domains WHERE id = ? AND user_id = ? AND tracking_status != 'deleted'",
  )
    .bind(domainId, userId)
    .first<{ id: string; domain: string; budget_json: string }>();
  if (!domainRow) return c.json({ error: "Domain not found" }, 404);

  // Check for an existing active or completed ingest.
  const existing = await c.env.DB.prepare(
    "SELECT id, status FROM ingests WHERE domain_id = ? AND month = ?",
  )
    .bind(domainId, month)
    .first<{ id: string; status: string }>();
  if (existing && ["queued", "surveying", "fetching", "rewriting", "ready"].includes(existing.status)) {
    return c.json({ id: existing.id, status: existing.status, existing: true }, 200);
  }

  const baseBudget = JSON.parse(domainRow.budget_json) as typeof DEFAULT_BUDGET;
  const budget = { ...baseBudget, ...budgetOverride };

  const id = ulid();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO ingests (id, domain_id, month, status, stage, budget_json, started_at, cursor, asset_cursor, attempts)
     VALUES (?,?,?,?,?,?,?,0,0,0)
     ON CONFLICT(id) DO UPDATE SET status = 'queued', stage = 'survey', error_message = NULL`,
  )
    .bind(id, domainId, month, "queued", "survey", JSON.stringify(budget), now)
    .run();

  // Enqueue the first bounded stage. Everything after this is the consumer's job.
  const message: IngestQueueMessage = { ingestId: id, domain: domainRow.domain, month, stage: "survey", attempt: 0, enqueuedAt: now };
  await c.env.INGEST_QUEUE.send(message);

  return c.json(
    {
      id,
      status: "queued",
      stage: "survey",
      budget,
      quota: { ...quota, remaining: Math.max(0, quota.remaining - 1) },
      budgetStatus: report.budget,
    },
    202,
  );
});

// ── Cost monitoring ───────────────────────────────────────────────────────────
// Registered before `/:ingestId` on purpose: Hono matches in registration order,
// and "/usage" would otherwise be read as an ingest id.

/** GET /v1/usage — the cost dashboard payload (plan.md §11.5 item 5). */
ingestRouter.get("/usage", async (c) => {
  const userId = c.get("userId" as never) as string;
  const month = c.req.query("month") ?? currentMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ error: "month must be YYYY-MM" }, 400);
  }
  const report = await buildUsageReport(c.env, userId, month);
  return c.json(report);
});

/** GET /v1/usage/limits — what is currently enforced, for the settings sheet. */
ingestRouter.get("/usage/limits", async (c) => {
  const userId = c.get("userId" as never) as string;
  const quota = await crawlQuota(c.env, userId);
  const read = await consumeRateLimit(c.env, userBucket(userId, "read"), "read");
  return c.json({
    crawlQuotaPerDay: quota.limit || DEFAULT_CRAWL_QUOTA_PER_DAY,
    crawlQuotaRemaining: quota.remaining,
    crawlQuotaResetsAt: quota.resetsAt,
    monthlyBudgetUsd: budgetUsdFromEnv(c.env),
    readLimitPerMinute: read.limit,
  });
});

// ── Job status ────────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  status: string;
  stage: string | null;
  month: string;
  pages_total: number;
  pages_done: number;
  assets_total: number;
  assets_done: number;
  bytes_stored: number;
  ia_429_count: number;
  consecutive_429: number;
  breaker_open_until: number | null;
  last_throttle_at: number | null;
  attempts: number;
  degraded_reason: string | null;
  error_message: string | null;
  started_at: number | null;
  finished_at: number | null;
}

ingestRouter.get("/:ingestId", async (c) => {
  const userId = c.get("userId" as never) as string;
  const { ingestId } = c.req.param();

  const row = await c.env.DB.prepare(
    `SELECT i.id, i.status, i.stage, i.month, i.pages_total, i.pages_done,
            i.assets_total, i.assets_done, i.bytes_stored, i.ia_429_count,
            i.consecutive_429, i.breaker_open_until, i.last_throttle_at,
            i.attempts, i.degraded_reason, i.error_message, i.started_at, i.finished_at
     FROM ingests i
     JOIN domains d ON d.id = i.domain_id
     WHERE i.id = ? AND d.user_id = ?`,
  )
    .bind(ingestId, userId)
    .first<JobRow>();
  if (!row) return c.json({ error: "Not found" }, 404);

  // Keep this response in the same camelCase contract as the SSE progress frames
  // and `IngestJob` in the web client. D1 returns column names verbatim, so
  // spreading `row` here used to leak snake_case fields that the UI silently read
  // as `undefined`.
  return c.json({
    id: row.id,
    status: row.status,
    stage: row.stage,
    pagesTotal: row.pages_total,
    pagesDone: row.pages_done,
    assetsTotal: row.assets_total,
    assetsDone: row.assets_done,
    bytesStored: row.bytes_stored,
    ia429Count: row.ia_429_count,
    errorMessage: row.error_message,
    attempts: row.attempts,
    degradedReason: row.degraded_reason,
    throttle: throttleStateOf(row),
  });
});

/** Human-readable throttle state — the UI shows this instead of a silent hang (§12.3). */
export function throttleStateOf(row: {
  status: string;
  consecutive_429: number;
  breaker_open_until: number | null;
}): ThrottleState {
  const now = Math.floor(Date.now() / 1000);
  const parked = row.breaker_open_until !== null && row.breaker_open_until > now;
  if (parked) {
    const remaining = (row.breaker_open_until as number) - now;
    return {
      active: true,
      resumeAt: row.breaker_open_until,
      consecutive: row.consecutive_429,
      message: `archive.org is throttling us — circuit breaker open, resuming in ${remaining}s`,
    };
  }
  if (row.consecutive_429 > 0) {
    return {
      active: false,
      resumeAt: null,
      consecutive: row.consecutive_429,
      message: `${row.consecutive_429} throttle response(s) so far; backing off between requests`,
    };
  }
  return { active: false, resumeAt: null, consecutive: 0, message: null };
}

// ── SSE progress stream ───────────────────────────────────────────────────────

ingestRouter.get("/:ingestId/events", async (c) => {
  const userId = c.get("userId" as never) as string;
  const { ingestId } = c.req.param();

  const owned = await c.env.DB.prepare(
    `SELECT i.status FROM ingests i
     JOIN domains d ON d.id = i.domain_id
     WHERE i.id = ? AND d.user_id = ?`,
  )
    .bind(ingestId, userId)
    .first<{ status: string }>();
  if (!owned) return c.json({ error: "Not found" }, 404);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (data: unknown) => {
    writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)).catch(() => void 0);
  };

  send({ type: "open", ingestId });

  // Poll D1 every 2 s and emit a progress frame. Deliberately not a Durable
  // Object: a crawl finishes in seconds-to-minutes, and an SSE stream that
  // survives the worker is a service to maintain for no benefit here.
  let done = false;
  const interval = setInterval(async () => {
    if (done) return;
    const current = await c.env.DB.prepare(
      `SELECT status, stage, pages_total, pages_done, assets_total, assets_done,
              bytes_stored, ia_429_count, consecutive_429, breaker_open_until,
              attempts, degraded_reason, error_message
       FROM ingests WHERE id = ?`,
    )
      .bind(ingestId)
      .first<JobRow & { stage: string | null }>();
    if (!current) return;

    send({
      type: "progress",
      ingestId,
      status: current.status,
      stage: current.stage,
      pagesTotal: current.pages_total,
      pagesDone: current.pages_done,
      assetsTotal: current.assets_total,
      assetsDone: current.assets_done,
      bytesStored: current.bytes_stored,
      ia429Count: current.ia_429_count,
      errorMessage: current.error_message,
      attempts: current.attempts,
      degradedReason: current.degraded_reason,
      throttle: throttleStateOf(current),
    });

    if (["ready", "partial", "failed"].includes(current.status)) {
      send({
        type: "done",
        ingestId,
        status: current.status,
        errorMessage: current.error_message,
      });
      done = true;
      clearInterval(interval);
      await writer.close();
    }
  }, 2000);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Disable proxy buffering so the first frame lands immediately.
      "X-Accel-Buffering": "no",
    },
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────────

ingestRouter.delete("/:ingestId", async (c) => {
  const userId = c.get("userId" as never) as string;
  const { ingestId } = c.req.param();

  const row = await c.env.DB.prepare(
    `SELECT i.id FROM ingests i
     JOIN domains d ON d.id = i.domain_id
     WHERE i.id = ? AND d.user_id = ? AND i.status IN ('queued','surveying','fetching','rewriting')`,
  )
    .bind(ingestId, userId)
    .first();
  if (!row) return c.json({ error: "Not found or not cancellable" }, 404);

  // Cancellation is a status change, not a queue purge: the consumer checks the
  // status before doing work and drops the message. Purging the queue would also
  // drop unrelated jobs, since one queue carries every domain's stages.
  await c.env.DB.prepare(
    `UPDATE ingests SET status = 'failed', stage = 'done', lease_until = NULL,
       breaker_open_until = NULL, error_message = 'Cancelled by user', finished_at = ?
     WHERE id = ?`,
  )
    .bind(Math.floor(Date.now() / 1000), ingestId)
    .run();
  return c.json({ ok: true });
});
