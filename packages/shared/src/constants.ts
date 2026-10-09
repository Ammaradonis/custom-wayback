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

/** Politeness: pause after this many consecutive 429s before circuit-breaking. */
export const CIRCUIT_BREAKER_THRESHOLD = 5;
/** Backoff ceiling in milliseconds. */
export const BACKOFF_MAX_MS = 120_000;
