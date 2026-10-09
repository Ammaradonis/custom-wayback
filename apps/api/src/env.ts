/**
 * Typed bindings for the Cloudflare Workers environment.
 * All secrets come from `wrangler secret put`; non-secret vars from wrangler.toml [vars].
 * Values are NEVER logged.
 */

export interface Env {
  // ── D1 ──────────────────────────────────────────────────────────────────
  DB: D1Database;

  // ── R2 ──────────────────────────────────────────────────────────────────
  STORAGE: R2Bucket;

  // ── Queues ───────────────────────────────────────────────────────────────
  INGEST_QUEUE: Queue;

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

  // ── Non-secret vars ──────────────────────────────────────────────────────
  CRAWLER_USER_AGENT: string;
  MAX_PAGES_PER_MONTH: string;
  SNAPSHOT_BEHAVIOR: "nearest" | "exact";
  PURGE_GRACE_SECONDS: string;
}
