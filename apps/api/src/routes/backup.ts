/**
 * Backup API — the Supabase mirror's control and status surface.
 *
 *   GET  /v1/backup/status  — is the second copy current, and how far behind?
 *   POST /v1/backup/run     — run a sync now, optionally restricted to tables
 *
 * ## Why both are behind auth
 *
 * A manual run costs real Supabase traffic and D1 reads, so it is an authenticated,
 * rate-limited action — the same reasoning as `POST /v1/jobs` (plan.md §11.5:
 * "Crawls are user-initiated and quota'd"). Status is behind auth too, even though
 * it holds no secrets, because it describes your corpus: table names, row counts
 * and the lag on your archive are not public information.
 *
 * ## Why the run endpoint does not crawl in the request
 *
 * A Worker request has a wall-clock ceiling, and a full first-time mirror of a
 * large ledger takes longer than one. So the run is bounded by
 * `BACKUP_DEFAULTS.maxRuntimeMs`, cursor state is written as it goes, and the
 * response says what was left rather than pretending to have finished. Calling it
 * twice is safe and idempotent — the second call resumes from the first one's
 * cursors. This is also why `POST /v1/backup/run` returning `pending > 0` is not
 * an error: it is an instruction to call it again, or simply to wait for the cron.
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Env } from "../env.js";
import { authenticateRequest } from "../lib/auth.js";
import { consumeRateLimit, userBucket } from "../lib/ratelimit.js";
import {
  BackupNotConfiguredError,
  BackupSync,
  backupEnabled,
  unconfiguredStatus,
  type BackupStatus,
} from "../lib/backup.js";
import { BACKUP_TABLES } from "@custom-wayback/shared";

export const backupRouter = new Hono<{ Bindings: Env }>();

// ── Auth ──────────────────────────────────────────────────────────────────────

backupRouter.use("/status", authGuard);
backupRouter.use("/run", authGuard);

async function authGuard(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
}

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * `GET /v1/backup/status`
 *
 * Always 200 when the caller is authenticated, even when the mirror is
 * unreachable or has never run. The *status* is the payload — a health endpoint
 * that returns 500 when the thing it monitors is down cannot be used by the
 * monitor.
 */
backupRouter.get("/status", async (c) => {
  try {
    const sync = new BackupSync(c.env);
    const status = await sync.status();
    return c.json(status);
  } catch (err) {
    if (err instanceof BackupNotConfiguredError) {
      return c.json(unconfiguredStatus(err.message));
    }
    return c.json(
      unconfiguredStatus(err instanceof Error ? err.message : String(err)),
      200,
    );
  }
});

// ── Manual run ────────────────────────────────────────────────────────────────

/**
 * `POST /v1/backup/run?force=1&tables=snapshots,assets`
 *
 * `force` skips the interval and daily-run checks. It deliberately does **not**
 * skip the lease: two concurrent runs would double our traffic and race on the
 * same cursors, and the upserts being idempotent makes that wasteful rather than
 * corrupting — which is exactly the kind of bug that goes unnoticed for months.
 */
backupRouter.post("/run", async (c) => {
  const userId = c.get("userId" as never) as string;

  if (!backupEnabled(c.env)) {
    return c.json(
      {
        error: "Backup is disabled",
        detail: "BACKUP_ENABLED is set to a false value for this deployment.",
      },
      409,
    );
  }

  // A manual run is the expensive action, so it is throttled like one.
  const limit = await consumeRateLimit(c.env, userBucket(userId, "backup"), "jobs");
  if (!limit.allowed) {
    return c.json(
      {
        error: "Too many backup runs",
        detail: `Retry in ${limit.retryAfter}s. The scheduled backup continues regardless.`,
        retryAfter: limit.retryAfter,
        resetAt: limit.resetAt,
      },
      429,
    );
  }

  const requested = (c.req.query("tables") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const known = new Set(BACKUP_TABLES.map((p) => p.name));
  const unknown = requested.filter((t) => !known.has(t));
  if (unknown.length > 0) {
    return c.json(
      {
        error: "Unknown table",
        detail: `Not part of the backup plan: ${unknown.join(", ")}`,
        tables: [...known],
      },
      400,
    );
  }

  try {
    const sync = new BackupSync(c.env);
    const summary = await sync.run({
      ...(requested.length > 0 ? { only: requested } : {}),
      force: c.req.query("force") === "1" || c.req.query("force") === "true",
    });

    // `pending` is the honest answer to "did that finish?". A run that hit its
    // runtime ceiling reports what is left instead of implying it was complete.
    const status = await sync.status().catch(() => null);

    return c.json({
      ...summary,
      pendingRows: status?.pendingRows ?? null,
      health: status?.health ?? null,
      /** True when re-invoking would move more data. */
      more: (status?.pendingRows ?? 0) > 0,
    });
  } catch (err) {
    if (err instanceof BackupNotConfiguredError) {
      return c.json({ error: "Backup is not configured", detail: err.message }, 503);
    }
    return c.json(
      { error: "Backup run failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

// ── Health fragment ───────────────────────────────────────────────────────────

/**
 * The backup's contribution to `GET /v1/health`.
 *
 * Returned as a nested object rather than a boolean, and *not* folded into the
 * top-level `ok`. Three reasons, in order of importance:
 *
 *  1. A backup is best-effort by construction. Supabase having a bad minute must
 *     not make the Worker report itself unhealthy, or every monitor you point at
 *     `/v1/health` will page you for something the app is designed to survive.
 *  2. The interesting states are not boolean — `behind`, `failing`, `drift` and
 *     `unreachable` need different responses from whoever reads them.
 *  3. `scripts/phase4-smoke.ps1` asserts a fixed set of `checks` keys. Keeping the
 *     backup out of `checks` means adding it could not break an existing gate.
 */
export async function backupHealth(env: Env): Promise<BackupStatus> {
  try {
    const sync = new BackupSync(env);
    return await sync.status();
  } catch (err) {
    if (err instanceof BackupNotConfiguredError) return unconfiguredStatus(err.message);
    return unconfiguredStatus(err instanceof Error ? err.message : String(err));
  }
}
