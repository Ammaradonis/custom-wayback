/** Shared constants used across API, crawler, and web shell. */

/** CDX endpoint base. */
export const CDX_BASE = "https://web.archive.org/cdx/search/cdx";

/** Wayback availability API. */
export const AVAILABILITY_BASE = "https://archive.org/wayback/available";

/** Raw (un-rewritten) fetch modifier. */
export const WAYBACK_RAW_BASE = "https://web.archive.org/web";

/** R2 path prefixes. */
export const R2 = {
  PAGES: "pages",
  ASSETS: "assets",
  META: "meta",
  RAW: "raw",
} as const;

/** JWT settings. */
export const JWT_ALGORITHM = "HS256" as const;
/** 7 days in seconds. */
export const JWT_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * After a page is served, it is eligible for R2 deletion.
 * The purge worker processes rows where served_at IS NOT NULL AND purged_at IS NULL.
 * We add a short grace period so a refresh within a session does not cause a
 * double-fetch cold hit.
 */
export const PURGE_GRACE_SECONDS = 60 * 30; // 30 minutes

/**
 * R2 "raw/" prefix grace period before automatic deletion.
 * We never store raw/ in this build — the flag is kept for forward compatibility.
 */
export const STORE_RAW = false;

/**
 * Politeness knobs. The *rules* that consume these live in `./policy.ts`, which
 * is the single implementation shared by the local runner and the cloud queue
 * consumer. Kept re-exported here so existing importers keep working.
 */
export { BREAKER_THRESHOLD as CIRCUIT_BREAKER_THRESHOLD } from "./policy.js";
/** Wall-clock ceiling for one backoff wait, in milliseconds. */
export const BACKOFF_MAX_MS = 120_000;

// ── Phase 4: queue stages ────────────────────────────────────────────────────
// A job walks these stages, one queue message per stage-transition-or-batch.
// Each message is bounded, so an eviction or a 429 storm costs at most one
// batch of work — never the whole crawl.

export const INGEST_STAGES = ["survey", "pages", "assets", "finalize"] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];

/** Pages fetched per queue message. Small on purpose: see §12, politeness. */
export const PAGES_PER_MESSAGE = 2;
/** Assets fetched per queue message. */
export const ASSETS_PER_MESSAGE = 12;
/** How long a claim on a job is valid before another consumer may take it. */
export const LEASE_SECONDS = 120;
/** Queue delivery attempts before the message goes to the dead-letter queue. */
export const MAX_QUEUE_ATTEMPTS = 6;

// ── Phase 4: throttling of our own API ───────────────────────────────────────
// Fixed-window counters in D1. These protect the crawl quota (the real cost
// lever) and the auth endpoints (the real abuse target).

export interface RateLimitPolicy {
  /** Window length in seconds. */
  windowSeconds: number;
  /** Requests permitted per window. */
  limit: number;
}

export const RATE_LIMITS: Record<string, RateLimitPolicy> = {
  /** Starting crawls — the expensive operation. */
  jobs: { windowSeconds: 3600, limit: 12 },
  /** Reads of the ledger/manifest. Cheap, but not free (D1 rows read). */
  read: { windowSeconds: 60, limit: 240 },
  /** Auth attempts, keyed by hashed IP rather than user id. */
  auth: { windowSeconds: 300, limit: 20 },
  /** On-demand cold page fetches from the viewer — the one path that can
   *  reach archive.org without a user-initiated crawl. */
  ondemand: { windowSeconds: 3600, limit: 60 },
};

/** Crawls a user may start per rolling day. The hard cost guardrail. */
export const DEFAULT_CRAWL_QUOTA_PER_DAY = 8;

// ── Phase 4: cost monitoring ─────────────────────────────────────────────────
// Unit prices from plan.md §11.1 (verified October 2026). Kept as data so the
// /v1/usage dashboard and the budget guardrail read the same numbers, and so a
// price change is a one-line edit rather than a hunt through call sites.

export interface UsagePrice {
  /** USD per single unit of the resource. */
  unitPriceUsd: number;
  /** Units included free each month (already-absorbed allowance). */
  freeUnitsPerMonth: number;
  /** Human-readable unit, for the dashboard. */
  unit: string;
}

/** A fixed monthly charge (the Workers Paid plan floor). */
export const PLAN_FLOOR_USD = 5.0;

export const USAGE_PRICES: Record<string, UsagePrice> = {
  worker_request: { unitPriceUsd: 0.3 / 1_000_000, freeUnitsPerMonth: 10_000_000, unit: "requests" },
  worker_cpu_ms: { unitPriceUsd: 0.02 / 1_000_000, freeUnitsPerMonth: 30_000_000, unit: "CPU-ms" },
  r2_class_a: { unitPriceUsd: 4.5 / 1_000_000, freeUnitsPerMonth: 1_000_000, unit: "writes" },
  r2_class_b: { unitPriceUsd: 0.36 / 1_000_000, freeUnitsPerMonth: 10_000_000, unit: "reads" },
  bytes_stored: { unitPriceUsd: 0.015 / (1024 * 1024 * 1024), freeUnitsPerMonth: 10 * 1024 ** 3, unit: "bytes" },
  r2_delete: { unitPriceUsd: 0, freeUnitsPerMonth: 0, unit: "deletes" },
  ia_fetch: { unitPriceUsd: 0, freeUnitsPerMonth: 0, unit: "archive.org fetches" },
  bytes_served: { unitPriceUsd: 0, freeUnitsPerMonth: 0, unit: "bytes served" },
  queue_op: { unitPriceUsd: 0.4 / 1_000_000, freeUnitsPerMonth: 1_000_000, unit: "operations" },
  /**
   * D1 rows written. Recording this matters because Phase 5's search index writes
   * ~4 rows per crawled page (the FTS row, the FTS delete-guard, and the
   * `search_docs` bookkeeping) against §11.1's 50M rows/month allowance. Without
   * a metered line for it, that cost would appear as unexplained D1 growth.
   */
  d1_write: { unitPriceUsd: 1.0 / 1_000_000, freeUnitsPerMonth: 50_000_000, unit: "rows written" },
};

/**
 * Default monthly ingest budget, in USD. When the month's modelled cost crosses
 * this, new crawl requests are refused with an actionable message (plan.md §11.5).
 * Set to 0 or negative to disable the guardrail.
 */
export const DEFAULT_MONTHLY_BUDGET_USD = 25;

/** Queue names, shared by the producer (API) and the consumer (same Worker). */
export const QUEUE_INGEST = "custom-wayback-ingest";
export const QUEUE_INGEST_DLQ = "custom-wayback-ingest-dlq";

/** Warn in the UI once this fraction of the budget is spent. */
export const BUDGET_WARN_FRACTION = 0.7;

