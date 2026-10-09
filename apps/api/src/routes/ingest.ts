/**
 * Ingest job routes.
 *
 * POST /v1/jobs              — start a crawl job
 * GET  /v1/jobs/:ingestId    — job status (polling)
 * GET  /v1/jobs/:ingestId/events — SSE progress stream
 * DELETE /v1/jobs/:ingestId  — cancel a queued/in-progress job
 * GET  /v1/usage             — per-domain cost attribution
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { StartIngestSchema, DEFAULT_BUDGET } from "@custom-wayback/shared";
import { authenticateRequest } from "../lib/auth.js";
import { ulid } from "../lib/ulid.js";
import type { Env } from "../env.js";

export const ingestRouter = new Hono<{ Bindings: Env }>();

// ── Auth middleware ───────────────────────────────────────────────────────────

ingestRouter.use("/*", async (c, next) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
});

// ── Start a job ───────────────────────────────────────────────────────────────

ingestRouter.post("/", zValidator("json", StartIngestSchema), async (c) => {
  const userId = c.get("userId" as never) as string;
  const { domainId, month, budgetOverride } = c.req.valid("json");

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
    `INSERT INTO ingests (id, domain_id, month, status, budget_json, started_at)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(id, domainId, month, "queued", JSON.stringify(budget), now)
    .run();

  // Enqueue for the crawler.
  await c.env.INGEST_QUEUE.send({
    ingestId: id,
    domain: domainRow.domain,
    month,
    budget,
  });

  return c.json({ id, status: "queued" }, 202);
});

// ── Job status (polling) ──────────────────────────────────────────────────────

ingestRouter.get("/:ingestId", async (c) => {
  const userId = c.get("userId" as never) as string;
  const { ingestId } = c.req.param();

  const row = await c.env.DB.prepare(
    `SELECT i.*, d.user_id FROM ingests i
     JOIN domains d ON d.id = i.domain_id
     WHERE i.id = ? AND d.user_id = ?`,
  )
    .bind(ingestId, userId)
    .first();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

// ── SSE progress stream ───────────────────────────────────────────────────────

ingestRouter.get("/:ingestId/events", async (c) => {
  const userId = c.get("userId" as never) as string;
  const { ingestId } = c.req.param();

  // Verify ownership.
  const row = await c.env.DB.prepare(
    `SELECT i.status FROM ingests i
     JOIN domains d ON d.id = i.domain_id
     WHERE i.id = ? AND d.user_id = ?`,
  )
    .bind(ingestId, userId)
    .first<{ status: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (data: unknown) => {
    writer
      .write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      .catch(() => void 0);
  };

  // Poll D1 every 2 s and emit events.
  let done = false;
  const interval = setInterval(async () => {
    if (done) return;
    const current = await c.env.DB.prepare(
      `SELECT status, pages_total, pages_done, assets_total, assets_done,
              bytes_stored, ia_429_count, error_message
       FROM ingests WHERE id = ?`,
    )
      .bind(ingestId)
      .first<{
        status: string;
        pages_total: number;
        pages_done: number;
        assets_total: number;
        assets_done: number;
        bytes_stored: number;
        ia_429_count: number;
        error_message: string | null;
      }>();
    if (!current) return;

    send({
      type: "progress",
      ingestId,
      ...current,
    });

    if (["ready", "partial", "failed"].includes(current.status)) {
      send({ type: "done", ingestId, status: current.status });
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

  await c.env.DB.prepare("UPDATE ingests SET status = 'failed', error_message = 'Cancelled by user' WHERE id = ?")
    .bind(ingestId)
    .run();
  return c.json({ ok: true });
});

// ── Usage dashboard ───────────────────────────────────────────────────────────

ingestRouter.get("/usage", async (c) => {
  const userId = c.get("userId" as never) as string;
  // Aggregate by domain + kind for the current calendar month.
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const rows = await c.env.DB.prepare(
    `SELECT u.domain, u.kind, SUM(u.value) as total
     FROM usage_ledger u
     JOIN domains d ON d.domain = u.domain AND d.user_id = ?
     WHERE u.month = ?
     GROUP BY u.domain, u.kind
     ORDER BY u.domain, u.kind`,
  )
    .bind(userId, month)
    .all();

  return c.json({ month, usage: rows.results });
});
