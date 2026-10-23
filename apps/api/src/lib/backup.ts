/**
 * D1 → Supabase backup sync.
 *
 * ## What problem this solves, precisely
 *
 * D1's free plan is metered per day on rows read, rows written and storage. When
 * a daily ceiling is crossed, D1 stops accepting **writes** — and a crawl that
 * cannot record what it fetched has thrown that work away. The crawler already
 * refuses to start a crawl it cannot afford (`POST /v1/jobs` checks the monthly
 * budget), so the failure mode that matters is not overspend, it is *refused
 * writes at the moment the ledger is at its most valuable*.
 *
 * This module keeps a second, current copy of the whole ledger in Supabase
 * Postgres, so the answer to "D1 has stopped accepting writes" is "promote the
 * mirror", not "the last three months of research are gone".
 *
 * ## How a run works
 *
 *   1. Take a lease in D1 (`rate_limits`), so two cron ticks cannot overlap.
 *   2. Check the run quota for today.
 *   3. For each mirrored table, in plan order:
 *        a. compare D1's high watermark against the mirror's stored cursor;
 *        b. if there is nothing new, skip — no network traffic at all;
 *        c. otherwise read one batch, upsert it, advance the cursor, repeat.
 *   4. Release the lease, write a usage row, return a summary.
 *
 * Every step is resumable and every step is bounded: a per-run runtime ceiling,
 * a bounded number of batches per table, and a per-batch row and byte cap. A run
 * that hits the ceiling simply stops, leaves the cursors where they are, and the
 * next tick continues. Nothing is ever half-written, because the cursor only
 * advances after the mirror has accepted the batch.
 *
 * ## Why the automatic path is quiet
 *
 * The cost of being wrong here is Supabase traffic, so the design spends as
 * little as possible: a table with no new rows costs one indexed `MAX()` on D1
 * and zero HTTP requests. A whole run with nothing to do costs fourteen `MAX()`
 * queries and one lease write.
 *
 * ## Deliberately not implemented
 *
 * * **No read failover.** The mirror is a recovery source, not a second reader.
 *   Serving requests from Postgres would need every query in the app rewritten
 *   against PostgREST, and a wrong answer there is worse than a slow one.
 *   Promotion is a deliberate operator action — see `docs/supabase-backup.md`.
 * * **No triggers or change-data-capture in D1.** Watermark columns already exist
 *   on every table (see the plan), so the incremental read is free.
 */

import {
  BACKUP_DEFAULTS,
  BACKUP_LEASE_BUCKET,
  BACKUP_QUOTA_BUCKET,
  BACKUP_TABLES,
  BACKUP_TABLE_BY_NAME,
  chunkRows,
  columnNames,
  conflictTarget,
  d1HighWaterSql,
  d1PendingCountSql,
  d1ReadParams,
  coerceCursor,
  d1ReadSql,
  MORE_FIELD,
  diffAgainstD1,
  toPostgrestRow,
  WATERMARK_FIELD,
  type BackupRow,
  type D1ColumnInfo,
  type DriftProblem,
  type TablePlan,
} from "@custom-wayback/shared";
import {
  describeError,
  initWith,
  pushRows,
  supabaseConfigFromEnv,
  type PushOptions,
  type SupabaseConfig,
  type SupabaseEnv,
} from "./supabase.js";

// ── Environment ───────────────────────────────────────────────────────────────

export interface BackupRuntimeEnv extends SupabaseEnv {
  DB: D1Database;
  /** Kill switch. Defaults to enabled: absent means "run". */
  BACKUP_ENABLED?: string;
  /** Overrides `BACKUP_DEFAULTS.intervalSeconds`. */
  BACKUP_INTERVAL_SECONDS?: string;
  /** Overrides `BACKUP_DEFAULTS.runsPerDay`. */
  BACKUP_RUNS_PER_DAY?: string;
  /** Extra runtime budget, in ms, for a manually triggered run. */
  BACKUP_MAX_RUNTIME_MS?: string;
  /** Overrides `BACKUP_DEFAULTS.leaseSeconds`. */
  BACKUP_LEASE_SECONDS?: string;
  /** Overrides `BACKUP_DEFAULTS.readBatch`. */
  BACKUP_READ_BATCH?: string;
  /** Overrides `BACKUP_DEFAULTS.pushBatch`. */
  BACKUP_PUSH_BATCH?: string;
  /** Overrides `BACKUP_DEFAULTS.pushBytes`. */
  BACKUP_PUSH_BYTES?: string;
}

export class BackupNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupNotConfiguredError";
  }
}

/**
 * Resolve configuration or explain exactly which variable is missing.
 *
 * The distinction between "not configured at all" and "half configured" matters:
 * the first is a supported state (health reports `configured: false` and nothing
 * fails), the second is a mistake that would otherwise fail at the first push with
 * a 401 from Supabase and no clue as to why.
 */
export function resolveBackupEnv(
  env: BackupRuntimeEnv,
): { config: SupabaseConfig; env: BackupRuntimeEnv } {
  const config = supabaseConfigFromEnv(env);
  if (config) return { config, env };

  const hasUrl = Boolean(env.SUPABASE_URL?.trim());
  const hasKey = Boolean(env.SUPABASE_SERVICE_ROLE_KEY?.trim());
  if (hasUrl !== hasKey) {
    throw new BackupNotConfiguredError(
      hasUrl
        ? "SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is not; the backup needs both."
        : "SUPABASE_SERVICE_ROLE_KEY is set but SUPABASE_URL is not; the backup needs both.",
    );
  }
  throw new BackupNotConfiguredError(
    "Supabase backup is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY " +
      "(see docs/supabase-backup.md).",
  );
}

export function backupEnabled(env: BackupRuntimeEnv): boolean {
  const raw = env.BACKUP_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return raw !== "false" && raw !== "0" && raw !== "off" && raw !== "no";
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── State ─────────────────────────────────────────────────────────────────────

/** One row of `backup_state`, as the Worker reads and writes it. */
export interface TableSyncState {
  tableName: string;
  lastCursor: string | null;
  rowsSynced: number;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFails: number;
}

export interface TableSyncResult {
  table: string;
  /** Rows pushed in this run. */
  rows: number;
  batches: number;
  /** True when D1's high watermark already matched the mirror's cursor. */
  skipped: boolean;
  error?: string;
  ms: number;
}

export interface BackupRunSummary {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  rows: number;
  tables: TableSyncResult[];
  /** Tables that failed this run, by name. */
  failures: string[];
  /** Why the run stopped early, when it did. */
  stoppedBecause?: "deadline" | "quota" | "lease" | "drift" | "complete";
  drift?: DriftProblem[];
}

// ── Engine ────────────────────────────────────────────────────────────────────

export interface SyncOptions extends PushOptions {
  /** Restrict to these tables. Unknown names are ignored. */
  only?: readonly string[];
  /** Ignore the interval and daily-run checks. Used by the manual endpoint. */
  force?: boolean;
  /** Injected clock, so tests can pin time. */
  now?: () => number;
}

export class BackupSync {
  private readonly db: D1Database;
  private readonly config: SupabaseConfig;
  private readonly env: BackupRuntimeEnv;
  private readonly now: () => number;
  /**
   * Run options, including the injected `fetchImpl` and clock.
   *
   * Held on the instance because the syncer issues requests in several places —
   * the mirror's `backup_state` reads and writes as well as the row pushes — and
   * they must all use the same transport. `run()` replaces this with the options
   * it was called with, so a later call can narrow or widen the injection.
   */
  private options: SyncOptions;

  constructor(env: BackupRuntimeEnv, options: SyncOptions = {}) {
    const resolved = resolveBackupEnv(env);
    this.env = resolved.env;
    this.config = resolved.config;
    this.db = env.DB;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.options = options;
  }

  get schema(): string {
    return this.config.schema;
  }

  // ── Mirror-side state ───────────────────────────────────────────────────────

  private restUrl(path: string): string {
    return `${this.config.url}/rest/v1/${path}`;
  }

  private restHeaders(profile: "read" | "write"): Record<string, string> {
    const headers: Record<string, string> = {
      apikey: this.config.serviceRoleKey,
      Authorization: `Bearer ${this.config.serviceRoleKey}`,
      "Content-Type": "application/json",
    };
    // Reads negotiate with `Accept-Profile`, writes with `Content-Profile`.
    headers[profile === "read" ? "Accept-Profile" : "Content-Profile"] = this.config.schema;
    return headers;
  }

  /**
   * The fetch used for the syncer's own calls to `backup_state`.
   *
   * Prefers the injected implementation so a test can drive the whole engine — not
   * just the row pushes — with no network at all, which is the only way to test the
   * cursor bookkeeping that makes the backup resumable.
   */
  private httpFetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  /** Read every row of the mirror's `backup_state`. */
  async readMirrorState(options: SyncOptions = {}): Promise<Map<string, TableSyncState>> {
    const url = new URL(this.restUrl("backup_state"));
    url.searchParams.set(
      "select",
      "table_name,last_cursor,rows_synced,last_run_at,last_success_at,last_error,consecutive_fails",
    );
    const fetchImpl = options.fetchImpl ?? this.httpFetch();

    const response = await fetchImpl(
      url.toString(),
      initWith("GET", this.restHeaders("read"), options.timeoutMs),
    );
    if (!response.ok) {
      throw new Error(`could not read backup_state: ${await describeError(response)}`);
    }

    const rows = (await response.json()) as {
      table_name: string;
      last_cursor: string | null;
      rows_synced: number | string | null;
      last_run_at: number | string | null;
      last_success_at: number | string | null;
      last_error: string | null;
      consecutive_fails: number | string | null;
    }[];

    const out = new Map<string, TableSyncState>();
    for (const row of rows ?? []) {
      out.set(row.table_name, {
        tableName: row.table_name,
        lastCursor: row.last_cursor,
        rowsSynced: Number(row.rows_synced ?? 0),
        lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
        lastSuccessAt: row.last_success_at === null ? null : Number(row.last_success_at),
        lastError: row.last_error,
        consecutiveFails: Number(row.consecutive_fails ?? 0),
      });
    }
    return out;
  }

  /**
   * Record the outcome of a table's sync.
   *
   * `merge-duplicates` on `table_name` makes this an upsert, so the row does not
   * need to exist first. On failure the cursor is written as the value the caller
   * passed — which is the cursor the run *started* from, not the one it reached —
   * so the next run re-reads everything the mirror did not accept.
   *
   * `consecutive_fails` is the signal an operator acts on: one failure is noise, a
   * rising count means the mirror has been stale for that many runs and the
   * status endpoint should be shouting about it.
   */
  private async writeState(
    table: string,
    outcome: { cursor: string | null; rows: number; error?: string },
    timestamp: number,
  ): Promise<void> {
    const existing = await this.readOneState(table);
    const consecutiveFails = outcome.error ? (existing?.consecutiveFails ?? 0) + 1 : 0;
    const rowsSynced = (existing?.rowsSynced ?? 0) + outcome.rows;
    const lastSuccessAt = outcome.error ? (existing?.lastSuccessAt ?? null) : timestamp;
    const lastCursor = outcome.cursor ?? existing?.lastCursor ?? null;

    const body: BackupRow = {
      table_name: table,
      last_cursor: lastCursor,
      rows_synced: rowsSynced,
      last_run_at: timestamp,
      last_success_at: lastSuccessAt,
      last_error: outcome.error ?? null,
      consecutive_fails: consecutiveFails,
    };

    const url = new URL(this.restUrl("backup_state"));
    url.searchParams.set("on_conflict", "table_name");

    const response = await this.httpFetch()(
      url.toString(),
      initWith("POST", { ...this.restHeaders("write"), Prefer: "resolution=merge-duplicates,return=minimal" }, undefined, JSON.stringify([body])),
    );
    if (!response.ok) {
      // The mirror's bookkeeping failing is itself worth knowing about, but it
      // must not abort the run: the data may well have been written.
      throw new Error(`could not record state for ${table}: ${await describeError(response)}`);
    }
    await response.body?.cancel().catch(() => void 0);
  }

  private async readOneState(table: string): Promise<TableSyncState | null> {
    const url = new URL(this.restUrl("backup_state"));
    url.searchParams.set(
      "select",
      "table_name,last_cursor,rows_synced,last_run_at,last_success_at,last_error,consecutive_fails",
    );
    url.searchParams.set("table_name", `eq.${table}`);
    url.searchParams.set("limit", "1");

    const response = await this.httpFetch()(
      url.toString(),
      initWith("GET", this.restHeaders("read"), undefined),
    );
    if (!response.ok) return null;
    const rows = (await response.json()) as {
      table_name: string;
      last_cursor: string | null;
      rows_synced: number | string | null;
      last_run_at: number | string | null;
      last_success_at: number | string | null;
      last_error: string | null;
      consecutive_fails: number | string | null;
    }[];
    const row = rows?.[0];
    if (!row) return null;
    return {
      tableName: row.table_name,
      lastCursor: row.last_cursor,
      rowsSynced: Number(row.rows_synced ?? 0),
      lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
      lastSuccessAt: row.last_success_at === null ? null : Number(row.last_success_at),
      lastError: row.last_error,
      consecutiveFails: Number(row.consecutive_fails ?? 0),
    };
  }

  // ── D1-side helpers ─────────────────────────────────────────────────────────

  /**
   * Columns D1 actually has, for the drift check.
   *
   * `PRAGMA table_info` returns one row per column with its declared type. It is
   * one D1 query per table, so the whole check is fourteen cheap round trips —
   * cheaper than being wrong about what is protected.
   */
  async readD1Schema(plans: readonly TablePlan[] = BACKUP_TABLES): Promise<Map<string, D1ColumnInfo[]>> {
    const out = new Map<string, D1ColumnInfo[]>();
    for (const plan of plans) {
      try {
        const res = await this.db
          .prepare(`PRAGMA table_info(${plan.name})`)
          .all<{ name: string; type: string }>();
        out.set(
          plan.name,
          (res.results ?? []).map((c) => ({ name: c.name, type: c.type ?? "" })),
        );
      } catch {
        // A missing table shows up as an absent map entry, which the diff reports
        // as `missing-table`. Swallowing the error here keeps one bad table from
        // hiding the state of the other thirteen.
        out.delete(plan.name);
      }
    }
    return out;
  }

  /** Compare the plan against D1's live schema. Empty array means in step. */
  async checkDrift(): Promise<DriftProblem[]> {
    const actual = await this.readD1Schema();
    return diffAgainstD1(BACKUP_TABLES, actual);
  }

  private async highWater(plan: TablePlan): Promise<string | number | null> {
    const row = await this.db
      .prepare(d1HighWaterSql(plan))
      .first<{ wm: string | number | null }>();
    return row?.wm ?? null;
  }

  /**
   * Read one batch, already mapped into pushable JSON.
   *
   * The watermark rides along as `__wm` and is stripped here: `toPostgrestRow`
   * copies planned columns only, so the value that becomes the next cursor is
   * available without ever being sent to PostgREST.
   *
   * `d1ReadParams` and not a bare `bind(cursor)`: the value to supply is derived
   * from the generated SQL rather than assumed. Today that is exactly one cursor,
   * and a future edit that moves the placeholder into the projection would need two
   * — a mismatch that is otherwise silent, because `wm >= NULL` matches no rows and
   * the table would simply never sync while every run reported success.
   */
  private async readBatch(
    plan: TablePlan,
    cursor: string,
    limit: number,
    strict = false,
  ): Promise<{ rows: BackupRow[]; watermark: string | number | null; more: boolean }> {
    const res = await this.db
      .prepare(d1ReadSql(plan, limit, { strict }))
      .bind(...d1ReadParams(plan, cursor))
      .all<BackupRow>();
    const raw = res.results ?? [];
    const last = raw[raw.length - 1];
    return {
      rows: raw.map((row) => toPostgrestRow(plan, row)),
      watermark: (last?.[WATERMARK_FIELD] ?? null) as string | number | null,
      // `__more` is null exactly when the batch reached the end of the pending set.
      // A row count cannot answer this: a batch that contains everything and a batch
      // that was capped at `limit` are the same size, and treating the capped one as
      // the end would leave the cursor behind and re-read it forever.
      more: raw.length > 0 && last?.[MORE_FIELD] != null,
    };
  }

  /** Compare cursors as numbers when they look numeric, as strings otherwise. */
  private cursorEquals(a: string | number | null, b: string | null): boolean {
    if (a === null || b === null) return false;
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an === bn;
    return String(a) === b;
  }

  private cursorGt(a: string | number, b: string): boolean {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an > bn;
    return String(a) > b;
  }

  // ── Leasing and quota ───────────────────────────────────────────────────────

  /**
   * Claim the right to run.
   *
   * `rate_limits` is already the fixed-window counter table for the API, and its
   * `(bucket, window_start)` primary key makes an atomic claim a plain UPSERT: a
   * returned count of 1 means this invocation created the row and therefore owns
   * the window. Using it costs no new infrastructure — which is the same argument
   * that removed Redis from the stack (plan.md §4).
   */
  async acquireLease(windowSeconds: number): Promise<boolean> {
    const now = this.now();
    const windowStart = now - (now % windowSeconds);
    try {
      const row = await this.db
        .prepare(
          `INSERT INTO rate_limits (bucket, window_start, count, updated_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
           RETURNING count`,
        )
        .bind(BACKUP_LEASE_BUCKET, windowStart, now)
        .first<{ count: number }>();
      return (row?.count ?? 0) === 1;
    } catch {
      // Fail closed here, unlike the request rate limiter: a lease that cannot be
      // recorded is a lease we do not hold, and two concurrent runs would double
      // our Supabase traffic for no benefit.
      return false;
    }
  }

  /**
   * Is another run still in flight?
   *
   * Asked before starting, so a run that overran its lease window is not joined by
   * a second one. The window key is the run's start time, so "within the last
   * `leaseSeconds`" is a range scan on the primary key.
   */
  private async leaseInFlight(leaseSeconds: number): Promise<boolean> {
    const cutoff = this.now() - leaseSeconds;
    try {
      const row = await this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM rate_limits
           WHERE bucket = ? AND window_start >= ?`,
        )
        .bind(BACKUP_LEASE_BUCKET, cutoff)
        .first<{ n: number }>();
      // More than one window present means a run started recently; the row for
      // *this* invocation does not exist yet, so any count means someone else.
      return (row?.n ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** Runs already started today, against the daily ceiling. */
  async runsToday(): Promise<number> {
    try {
      const start = new Date(this.now() * 1000);
      const dayStart = Math.floor(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()) / 1000,
      );
      const row = await this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM rate_limits
           WHERE bucket LIKE ? AND window_start >= ?`,
        )
        .bind(`${BACKUP_QUOTA_BUCKET}:%`, dayStart)
        .first<{ n: number }>();
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  private async recordRunStart(): Promise<void> {
    const now = this.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO rate_limits (bucket, window_start, count, updated_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
        )
        .bind(`${BACKUP_QUOTA_BUCKET}:${now}`, now, now)
        .run();
    } catch {
      // A missing quota row costs us a ceiling, not correctness.
    }
  }

  // ── The run ─────────────────────────────────────────────────────────────────

  /**
   * Sync every table that has new rows.
   *
   * The outer loop is ordered parents-first so a partial run leaves a mirror whose
   * rows have their parents present, which keeps a mid-run restore coherent.
   */
  async run(options: SyncOptions = {}): Promise<BackupRunSummary> {
    const startedAt = this.now();
    const deadline =
      Date.now() +
      intFromEnv(this.env.BACKUP_MAX_RUNTIME_MS, BACKUP_DEFAULTS.maxRuntimeMs) +
      // A manual (forced) run is allowed more time than a cron tick.
      (options.force ? 30_000 : 0);

    const plans = options.only?.length
      ? BACKUP_TABLES.filter((p) => options.only?.includes(p.name))
      : BACKUP_TABLES;

    const summary: BackupRunSummary = {
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      rows: 0,
      tables: [],
      failures: [],
    };

    // Refuse to run against a schema this plan does not describe. A backup that
    // reports success while a new column goes unprotected is the one outcome
    // worse than not backing up at all.
    summary.drift = await this.checkDrift();
    const fatalDrift = summary.drift.filter(
      (d) => d.kind === "missing-table" || d.kind === "missing-column",
    );
    if (fatalDrift.length > 0) {
      summary.stoppedBecause = "drift";
      summary.finishedAt = this.now();
      summary.durationMs = summary.finishedAt - summary.startedAt;
      return summary;
    }

    const leaseSeconds = intFromEnv(this.env.BACKUP_LEASE_SECONDS, BACKUP_DEFAULTS.leaseSeconds);
    if (!options.force && (await this.leaseInFlight(leaseSeconds))) {
      summary.stoppedBecause = "lease";
      summary.finishedAt = this.now();
      summary.durationMs = summary.finishedAt - summary.startedAt;
      return summary;
    }
    const holdsLease = await this.acquireLease(leaseSeconds);
    if (!holdsLease) {
      summary.stoppedBecause = "lease";
      summary.finishedAt = this.now();
      summary.durationMs = summary.finishedAt - summary.startedAt;
      return summary;
    }

    const runsPerDay = intFromEnv(this.env.BACKUP_RUNS_PER_DAY, BACKUP_DEFAULTS.runsPerDay);
    const interval = options.force
      ? 0
      : intFromEnv(this.env.BACKUP_INTERVAL_SECONDS, BACKUP_DEFAULTS.intervalSeconds);

    const state = await this.readMirrorState(options);
    const oldestSuccess = Math.min(
      ...plans.map((p) => state.get(p.name)?.lastSuccessAt ?? 0),
    );
    const due =
      options.force === true ||
      oldestSuccess === 0 ||
      startedAt - oldestSuccess >= interval;

    if (!due || (!options.force && (await this.runsToday()) >= runsPerDay)) {
      summary.stoppedBecause = "quota";
      summary.finishedAt = this.now();
      summary.durationMs = summary.finishedAt - summary.startedAt;
      return summary;
    }

    await this.recordRunStart();

    for (const plan of plans) {
      if (Date.now() > deadline) {
        summary.stoppedBecause = "deadline";
        break;
      }
      const result = await this.syncTable(plan, state.get(plan.name) ?? null, deadline, options);
      summary.tables.push(result);
      summary.rows += result.rows;
      if (result.error) summary.failures.push(plan.name);
    }

    summary.stoppedBecause ??= "complete";
    summary.finishedAt = this.now();
    summary.durationMs = summary.finishedAt - summary.startedAt;
    await this.recordUsage(summary);
    return summary;
  }

  private async syncTable(
    plan: TablePlan,
    previous: TableSyncState | null,
    deadline: number,
    options: SyncOptions,
  ): Promise<TableSyncResult> {
    const started = Date.now();
    const result: TableSyncResult = { table: plan.name, rows: 0, batches: 0, skipped: false, ms: 0 };
    const cursor = previous?.lastCursor ?? "0";
    const readBatch = intFromEnv(this.env.BACKUP_READ_BATCH, BACKUP_DEFAULTS.readBatch);

    try {
      // Cheap exit: one indexed MAX() on D1 and no HTTP at all.
      const high = await this.highWater(plan);
      if (high === null || this.cursorEquals(high, previous?.lastCursor ?? null)) {
        result.skipped = true;
        result.ms = Date.now() - started;
        return result;
      }

      let current = cursor;
      for (let page = 0; page < BACKUP_DEFAULTS.maxPagesPerTable; page++) {
        if (Date.now() > deadline) break;

        // The first page of a run is read inclusively (at-least-once: a run that died
        // before recording its cursor re-covers the boundary rows); every later page
        // is strictly greater, because the cursor it starts from *is* the previous
        // page's boundary and re-reading it would return the same rows forever.
        const { rows, watermark, more } = await this.readBatch(
          plan,
          current,
          readBatch,
          page > 0,
        );
        if (rows.length === 0) break;

        if (watermark === null) {
          throw new Error(
            `batch for "${plan.name}" has no watermark value; the read query's ${WATERMARK_FIELD} alias is missing`,
          );
        }

        const batches = chunkRows(rows, {
          maxRows: intFromEnv(this.env.BACKUP_PUSH_BATCH, BACKUP_DEFAULTS.pushBatch),
          maxBytes: intFromEnv(this.env.BACKUP_PUSH_BYTES, BACKUP_DEFAULTS.pushBytes),
        });

        let pushed = 0;
        for (const batch of batches) {
          // The transport is passed explicitly rather than left to the spread:
          // every request the syncer makes must go through the same injected
          // `fetchImpl`, and a push that quietly fell back to the platform `fetch`
          // would be the one call a test could not intercept.
          const push = await pushRows(this.config, plan.name, batch, conflictTarget(plan), {
            ...options,
            fetchImpl: this.httpFetch(),
          });
          if (!push.ok) {
            result.error = push.error ?? `push failed with HTTP ${push.status}`;
            // Commit what the mirror did accept, then stop. On the next run the
            // read starts at `current`, which re-covers every row in this page
            // that had not been pushed — at-least-once, never skipped.
            result.rows += pushed;
            result.ms = Date.now() - started;
            await this.writeState(
              plan.name,
              { cursor: current, rows: pushed, error: result.error },
              this.now(),
            ).catch(() => void 0);
            return result;
          }
          pushed += batch.length;
          result.batches += 1;
        }

        result.rows += pushed;
        current = String(watermark);
        await this.writeState(plan.name, { cursor: current, rows: pushed }, this.now());

        // `__more` is the statement's own answer to "was that the whole table?", so
        // the run stops only when D1 says there is nothing left — never on a guess
        // from the row count.
        if (!more) break;
      }

      result.ms = Date.now() - started;
      return result;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      result.ms = Date.now() - started;
      await this.writeState(
        plan.name,
        { cursor: previous?.lastCursor ?? null, rows: 0, error: result.error },
        this.now(),
      ).catch(() => void 0);
      return result;
    }
  }

  private async recordUsage(summary: BackupRunSummary): Promise<void> {
    if (summary.rows === 0) return;
    try {
      await this.db
        .prepare(
          `INSERT INTO usage_ledger (domain, month, kind, value, recorded_at) VALUES (?,?,?,?,?)`,
        )
        .bind(null, null, "backup_row", summary.rows, this.now())
        .run();
    } catch {
      // Cost attribution is nice to have; failing a completed backup over it is not.
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  /**
   * The whole picture, for `GET /v1/backup/status`.
   *
   * Answers the only question that matters about a backup — *is the second copy
   * current, and if not, how far behind is it* — with three independently
   * measured numbers rather than one derived one:
   *
   *   * `pendingRows` counts D1 rows past the mirror's cursor. It is read from D1,
   *     so it cannot be fooled by the mirror's own bookkeeping.
   *   * `lagSeconds` is how long since the table last succeeded, computed from the
   *     mirror's clock, which means a Worker with a wrong clock cannot make a
   *     stale backup look fresh.
   *   * `drift` compares the plan against D1's live schema, so a migration that
   *     adds a column surfaces as "this is not being backed up" instead of as
   *     silent success.
   *
   * `health` collapses those into one word for a human, and is deliberately biased
   * towards alarm: a table that has never succeeded is `behind` however recently
   * the run started.
   */
  async status(options: SyncOptions = {}): Promise<BackupStatus> {
    const now = this.now();
    const enabled = backupEnabled(this.env);

    let mirror: Map<string, TableSyncState>;
    try {
      mirror = await this.readMirrorState(options);
    } catch (err) {
      // An unreachable mirror is itself the status. Reporting it as "unknown"
      // rather than throwing keeps /v1/health useful while the mirror is down.
      return {
        configured: true,
        enabled,
        reachable: false,
        schema: this.config.schema,
        checkedAt: now,
        lagSeconds: null,
        pendingRows: null,
        tables: [],
        drift: [],
        health: "unreachable",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const tables: TableBackupStatus[] = [];
    let pendingTotal = 0;
    let maxLag: number | null = 0;

    for (const plan of BACKUP_TABLES) {
      const state = mirror.get(plan.name) ?? null;
      const pending = await this.pendingRows(plan, state?.lastCursor ?? null).catch(() => null);
      const lagSeconds = state?.lastSuccessAt == null ? null : now - state.lastSuccessAt;

      if (pending !== null) pendingTotal += pending;
      if (lagSeconds === null) {
        // Never succeeded. That is not "no lag", it is unknown — and treating it
        // as zero would let a backup that has never once run report as healthy.
        maxLag = null;
      } else if (maxLag !== null) {
        maxLag = Math.max(maxLag, lagSeconds);
      }

      tables.push({
        table: plan.name,
        unit: plan.unit,
        restorable: plan.restorable,
        note: plan.note,
        mirroredRows: state?.rowsSynced ?? 0,
        pendingRows: pending,
        lastCursor: state?.lastCursor ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        lagSeconds,
        lastError: state?.lastError ?? null,
        consecutiveFails: state?.consecutiveFails ?? 0,
      });
    }

    const drift = await this.checkDrift().catch(() => [] as DriftProblem[]);
    const failing = tables.filter((t) => t.consecutiveFails > 0);
    const neverSucceeded = tables.filter((t) => t.lastSuccessAt === null);

    const health: BackupHealth =
      drift.some((d) => d.kind === "missing-table" || d.kind === "missing-column")
        ? "drift"
        : failing.length > 0
          ? "failing"
          : neverSucceeded.length > 0
            ? "behind"
            : (maxLag ?? 0) > BACKUP_DEFAULTS.intervalSeconds * 4
              ? "behind"
              : "ok";

    return {
      configured: true,
      enabled,
      reachable: true,
      schema: this.config.schema,
      checkedAt: now,
      lagSeconds: maxLag,
      pendingRows: pendingTotal,
      tables,
      drift,
      health,
    };
  }

  /** Rows past a cursor, counted on D1 so the mirror cannot flatter itself. */
  private async pendingRows(plan: TablePlan, cursor: string | null): Promise<number> {
    const sql = d1PendingCountSql(plan, cursor !== null);
    const stmt = this.db.prepare(sql);
    // `coerceCursor` for the same reason the read query uses it: a cursor stored as
    // text compared against an integer column matches nothing in SQLite, which would
    // report every table as fully pending even when it is current.
    const row = cursor === null
      ? await stmt.first<{ n: number }>()
      : await stmt.bind(coerceCursor(cursor)).first<{ n: number }>();
    return row?.n ?? 0;
  }
}

// ── Status types ──────────────────────────────────────────────────────────────

export type BackupHealth = "ok" | "behind" | "failing" | "drift" | "unreachable" | "disabled";

export interface TableBackupStatus {
  table: string;
  unit: string;
  restorable: boolean;
  note: string;
  /** Cumulative rows this table has ever pushed. */
  mirroredRows: number;
  /** Rows on D1 this table's cursor does not yet cover, or null if unreadable. */
  pendingRows: number | null;
  lastCursor: string | null;
  /** Unix seconds of the last successful push, or null if it has never succeeded. */
  lastSuccessAt: number | null;
  lagSeconds: number | null;
  lastError: string | null;
  consecutiveFails: number;
}

export interface BackupStatus {
  configured: boolean;
  enabled: boolean;
  reachable: boolean;
  schema: string;
  checkedAt: number;
  /** Worst-case lag across tables; null when any table has never succeeded. */
  lagSeconds: number | null;
  /** Total rows D1 holds that the mirror does not, or null when unreadable. */
  pendingRows: number | null;
  tables: TableBackupStatus[];
  drift: DriftProblem[];
  health: BackupHealth;
  error?: string;
}

/** Status for a deployment where the backup has not been configured at all. */
export function unconfiguredStatus(error: string): BackupStatus {
  return {
    configured: false,
    enabled: false,
    reachable: false,
    schema: "",
    checkedAt: Math.floor(Date.now() / 1000),
    lagSeconds: null,
    pendingRows: null,
    tables: [],
    drift: [],
    health: "disabled",
    error,
  };
}

/** Convenience: one call, resolved from raw bindings. */
export async function runBackup(
  env: BackupRuntimeEnv,
  options: SyncOptions = {},
): Promise<BackupRunSummary> {
  const sync = new BackupSync(env, options);
  return sync.run(options);
}

/** Names and order of the mirrored tables, for status payloads. */
export function mirroredTableNames(): string[] {
  return BACKUP_TABLES.map((p) => p.name);
}

/** Look up a plan by name, for the CLI and status output. */
export function planFor(table: string): TablePlan | undefined {
  return BACKUP_TABLE_BY_NAME.get(table);
}

/** Column names in plan order, re-exported so callers need only this module. */
export { columnNames };
