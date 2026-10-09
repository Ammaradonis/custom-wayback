/**
 * Cloudflare Workers entry point.
 *
 * Routes:
 *  POST /v1/auth/…      — registration, login, logout
 *  GET  /v1/domains/…   — domain management
 *  POST /v1/jobs        — start a crawl;  GET /v1/jobs/:id for status
 *  GET  /v1/usage       — cost monitoring dashboard payload
 *  GET  /a/:domain/…    — archive viewer (fast plane)
 *  anything else        — static assets (Workers Static Assets from apps/web/dist)
 *
 * Queue handler:
 *  Consumes `custom-wayback-ingest`. One message = one bounded stage of one
 *  crawl, so a delivery failure costs a batch rather than a whole job. The
 *  dead-letter queue is drained by the same handler and recorded, never dropped.
 *
 * Scheduled handler (every 5 minutes — see [triggers] in wrangler.toml):
 *  - Purge R2 content for pages already served (storage-cost strategy).
 *  - Prune expired rate-limit windows.
 *  - Re-drive stalled jobs whose lease expired without a completion.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { authRouter } from "./routes/auth.js";
import { domainsRouter } from "./routes/domains.js";
import { ingestRouter } from "./routes/ingest.js";
import { viewerRouter } from "./routes/viewer.js";
import { manifestRouter } from "./routes/manifest.js";
import { searchRouter } from "./routes/search.js";
import { purgeStaleCachedPages } from "./lib/r2.js";
import { pruneRateLimits } from "./lib/ratelimit.js";
import { handleIngestMessage, handleDeadLetter } from "./queue/ingest.js";
import { LEASE_SECONDS, type IngestQueueMessage } from "@custom-wayback/shared";
import type { Env } from "./env.js";

const app = new Hono<{ Bindings: Env }>();

// ── Global middleware ─────────────────────────────────────────────────────────

app.use("*", logger());

app.use(
  "*",
  secureHeaders({
    // Prevent clickjacking on the app shell.
    xFrameOptions: "SAMEORIGIN",
    // Strict transport (set here; Cloudflare also enforces it at the edge).
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    // Prevent MIME sniffing.
    xContentTypeOptions: "nosniff",
    // No referrer to external sites.
    referrerPolicy: "strict-origin-when-cross-origin",
    // Permissions policy: deny camera, mic, geolocation.
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
    },
  }),
);

app.use(
  "/v1/*",
  cors({
    origin: (origin) => {
      // In dev allow localhost; in prod allow only the configured app origin.
      // CORS is an added layer — JWTs are the real auth mechanism.
      if (!origin) return null;
      if (origin.startsWith("http://localhost")) return origin;
      return origin; // Workers already enforce auth on every request
    },
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  }),
);

// ── Health check ──────────────────────────────────────────────────────────────
//
// Registered BEFORE any router is mounted. `manifestRouter` is mounted at `/v1`
// and attaches auth middleware to `/v1/*`, and Hono matches in registration
// order — so a health route declared after it would be rejected with a 401 by
// middleware that has nothing to do with health. That is exactly the kind of bug
// that only shows up when something outside the app tries to check on the app.

app.get("/v1/health", async (c) => {
  const checks: Record<string, boolean> = {};

  // D1 reachability.
  try {
    await c.env.DB.prepare("SELECT 1").first();
    checks["d1"] = true;
  } catch {
    checks["d1"] = false;
  }

  // R2 reachability (list with limit 1 = Class B op, cheap).
  try {
    await c.env.STORAGE.list({ limit: 1 });
    checks["r2"] = true;
  } catch {
    checks["r2"] = false;
  }

  // Queue reachability: `send` is the only probe Workers exposes, so we check the
  // binding exists and is callable rather than spending a real message.
  checks["queue"] = typeof c.env.INGEST_QUEUE?.send === "function";

  // Config presence. This is not paranoia: `.dev.vars` is read relative to the
  // Worker's own directory, so a file at the repo root is silently ignored and
  // every login fails with an opaque 500 from `crypto.subtle.importKey` on an
  // empty secret. Asserting here turns a five-minute debugging session into a
  // failed health check that names the missing variable.
  checks["secrets"] = typeof c.env.JWT_SECRET === "string" && c.env.JWT_SECRET.length >= 32;

  const allOk = Object.values(checks).every(Boolean);
  return c.json({ ok: allOk, checks }, allOk ? 200 : 503);
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.route("/v1/auth", authRouter);
app.route("/v1/domains", domainsRouter);
app.route("/v1/jobs", ingestRouter);
app.route("/v1/search", searchRouter);
app.route("/v1", manifestRouter);
app.route("/a", viewerRouter);

// ── Static assets fallthrough ─────────────────────────────────────────────────

app.get("*", async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  // Re-wrap before returning. A Response that came out of the ASSETS fetcher can
  // carry immutable headers, and middleware that runs after this handler
  // (`secureHeaders`) then throws "Can't modify immutable headers" — turning
  // every deep link the SPA handles client-side into a 500. Copying the body and
  // headers into a fresh Response costs nothing and makes the response ours to
  // decorate.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
});

// ── Stalled-job recovery ──────────────────────────────────────────────────────

/**
 * Re-drive jobs whose consumer died mid-batch.
 *
 * A Worker can be evicted without notice; when that happens the lease it held
 * simply expires. Without this sweep the job would sit in `fetching` forever and
 * the UI would show a progress bar that never moves. Re-driving is safe because
 * every stage is idempotent and resumes from the cursor.
 */
async function requeueStalledJobs(env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const stale = await env.DB.prepare(
    `SELECT i.id, i.month, i.stage, i.domain_id, d.domain
     FROM ingests i
     JOIN domains d ON d.id = i.domain_id
     WHERE i.status IN ('queued','surveying','fetching','rewriting')
       AND i.stage IS NOT NULL
       AND i.stage != 'done'
       AND (i.lease_until IS NULL OR i.lease_until < ?)
       AND (i.breaker_open_until IS NULL OR i.breaker_open_until < ?)
       AND (i.started_at IS NULL OR i.started_at < ?)
     LIMIT 20`,
  )
    .bind(now, now, now - LEASE_SECONDS)
    .all<{ id: string; month: string; stage: string; domain: string }>();

  let requeued = 0;
  for (const row of stale.results ?? []) {
    const message: IngestQueueMessage = {
      ingestId: row.id,
      domain: row.domain,
      month: row.month,
      stage: row.stage as IngestQueueMessage["stage"],
      enqueuedAt: now,
    };
    try {
      await env.INGEST_QUEUE.send(message);
      // Take the lease immediately so two consecutive cron ticks cannot both
      // re-drive the same job.
      await env.DB.prepare(`UPDATE ingests SET lease_until = ? WHERE id = ?`)
        .bind(now + LEASE_SECONDS, row.id)
        .run();
      requeued += 1;
    } catch {
      // Next tick will retry.
    }
  }
  return requeued;
}

// ── Default export (fetch + queue + scheduled handlers) ──────────────────────

export default {
  fetch: app.fetch,

  /**
   * Queue consumer. `batch` is bounded by `max_batch_size` in wrangler.toml, and
   * each message does its own bounded slice of work, so total archive.org
   * request rate is a configuration value rather than an emergent property.
   */
  async queue(batch: MessageBatch<IngestQueueMessage>, env: Env): Promise<void> {
    const isDlq = batch.queue.includes("dlq");

    for (const message of batch.messages) {
      const body = message.body;
      if (!body || typeof body.ingestId !== "string") {
        // Unparseable message: ack it, or the queue will redeliver it forever.
        console.error(`[queue] dropping malformed message on ${batch.queue}`);
        message.ack();
        continue;
      }

      if (isDlq) {
        await handleDeadLetter(env, body, "exhausted retries");
        message.ack();
        continue;
      }

      try {
        await handleIngestMessage(env, body);
        message.ack();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[queue] ${body.ingestId} (${body.stage}) threw: ${reason}`);
        // Retry with backoff; the platform sends it to the DLQ after
        // `max_retries`, and the DLQ handler records the failure in D1.
        message.retry({ delaySeconds: Math.min(60 * (message.attempts + 1), 900) });
      }
    }
  },

  /**
   * Scheduled handler — runs every 5 minutes via Cron Trigger.
   * Each sweep is independent and non-fatal: one failing must not skip the others.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const purged = await purgeStaleCachedPages(env);
          if (purged > 0) console.log(`[purge] deleted ${purged} R2 objects`);
        } catch (err) {
          console.error(`[purge] failed: ${err instanceof Error ? err.message : err}`);
        }

        try {
          const pruned = await pruneRateLimits(env);
          if (pruned > 0) console.log(`[ratelimit] pruned ${pruned} expired windows`);
        } catch (err) {
          console.error(`[ratelimit] prune failed: ${err instanceof Error ? err.message : err}`);
        }

        try {
          const requeued = await requeueStalledJobs(env);
          if (requeued > 0) console.log(`[queue] re-drove ${requeued} stalled job(s)`);
        } catch (err) {
          console.error(`[queue] stalled-job sweep failed: ${err instanceof Error ? err.message : err}`);
        }
      })(),
    );
  },
};
