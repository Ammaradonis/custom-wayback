/**
 * Typed bindings for the Cloudflare Workers environment.
 * All secrets come from `wrangler secret put`; non-secret vars from wrangler.toml [vars].
 * Values are NEVER logged.
 */

export interface Env {
  // ── D1 ──────────────────────────────────────────────────────────────────
  DB: D1Database;

  // ── R2 ───────────────────────────────────────────────────────────────────
  STORAGE: R2Bucket;

  // ── Queues ───────────────────────────────────────────────────────────────
  INGEST_QUEUE: Queue;
  /** Terminal queue for messages that exhausted their retries (plan.md §4). */
  DLQ_QUEUE: Queue;

  // ── KV ───────────────────────────────────────────────────────────────────
  COVERAGE_KV: KVNamespace;

  // ── Static Assets ────────────────────────────────────────────────────────
  ASSETS: Fetcher;

  // ── Secrets (injected by wrangler secret put) ────────────────────────────
  JWT_SECRET: string;
  STORAGE_ACCESS_KEY_ID: string;
  STORAGE_SECRET_ACCESS_KEY: string;
  STORAGE_ENDPOINT: string;
  STORAGE_BUCKET_NAME: string;

  // ── Supabase backup mirror (optional) ────────────────────────────────────
  //
  // Both are secrets: the service-role key bypasses the mirror's row-level
  // security by design, and the URL identifies the project. Optional on purpose —
  // `supabaseConfigFromEnv` returns null when either is absent, so a deployment
  // with no backup configured boots, serves and reports `configured: false`
  // rather than failing every request through a missing binding.
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;

  // ── Non-secret vars ──────────────────────────────────────────────────────
  CRAWLER_USER_AGENT: string;
  MAX_PAGES_PER_MONTH: string;
  SNAPSHOT_BEHAVIOR: "nearest" | "exact";
  PURGE_GRACE_SECONDS: string;
  /** Crawls a user may start per UTC day. The cost guardrail. */
  CRAWL_QUOTA_PER_DAY: string;
  /** Monthly spend ceiling in USD; 0 disables the guardrail. */
  MONTHLY_BUDGET_USD: string;
  /** Optional: only allow registrations from these comma-separated emails. */
  ALLOWED_EMAILS?: string;

  // ── Frame origin (optional; see wrangler.frame.toml) ─────────────────────
  //
  // The same code deployed a second time, under its own hostname, serves archived pages
  // and nothing else. Its responses differ in exactly three ways: the archived document
  // keeps a real origin (`allow-same-origin` — safe, because that origin is not the
  // app's), only the app origin may frame it, and anything that is not an archived page
  // or resource is refused, so the app shell and the API never run there.
  /** `"frame"` on the archive-only deployment; unset on the app. */
  ROLE?: string;
  /** The app's origin. Required when `ROLE` is `"frame"`. */
  APP_ORIGIN?: string;

  // ── Backup tuning (all optional; see packages/shared/src/backup.ts) ──────
  /** Mirrored schema. Defaults to `cw_backup`. */
  SUPABASE_SCHEMA?: string;
  /** "false" turns the automatic backup off without removing the secrets. */
  BACKUP_ENABLED?: string;
  /** Minimum seconds between automatic runs. Default 900. */
  BACKUP_INTERVAL_SECONDS?: string;
  /** Automatic runs per UTC day. Default 96. */
  BACKUP_RUNS_PER_DAY?: string;
  /** Wall-clock ceiling for one run, in ms. Default 20000. */
  BACKUP_MAX_RUNTIME_MS?: string;
  /** Rows read from D1 per page. Default 200. */
  BACKUP_READ_BATCH?: string;
  /** Rows per PostgREST upsert. Default 200. */
  BACKUP_PUSH_BATCH?: string;
  /** Serialised request-body ceiling, in bytes. Default 262144. */
  BACKUP_PUSH_BYTES?: string;
}
