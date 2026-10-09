/**
 * Shared TypeScript types and Zod schemas used across the API, crawler,
 * and web shell.
 */

import { z } from "zod";

// ── Crawl budget ─────────────────────────────────────────────────────────────

export const CrawlBudgetSchema = z.object({
  /** Hard ceiling on HTML pages fetched per month per domain. Default 1000. */
  maxPagesPerMonth: z.number().int().min(1).max(10_000).default(1000),
  /** Maximum link-follow depth from the seed URL. Default 3. */
  maxDepth: z.number().int().min(1).max(10).default(3),
  /** Per-page asset cap to avoid pulling ad/tracker soup. Default 120. */
  maxAssetsPerPage: z.number().int().min(1).max(500).default(120),
  /** Compressed byte cap before hard abort. Default 750 MB. */
  maxBytesPerMonth: z
    .number()
    .int()
    .default(750 * 1024 * 1024),
  /** Global concurrent fetch limit. Default 6. */
  concurrency: z.number().int().min(1).max(20).default(6),
  /** Requests per second per host (politeness). Default 1. */
  rpsPerHost: z.number().min(0.1).max(5).default(1),
  /**
   * "nearest" = auto-resolve to closest capture if the exact day is missing.
   * "exact"   = return null / 404 for missing days.
   * Your answer: "nearest" is the default.
   */
  snapshotBehavior: z.enum(["nearest", "exact"]).default("nearest"),
});

export type CrawlBudget = z.infer<typeof CrawlBudgetSchema>;

export const DEFAULT_BUDGET: CrawlBudget = CrawlBudgetSchema.parse({});

// ── API request/response shapes ─────────────────────────────────────────────

export const RegisterSchema = z.object({
  email: z.string().email().max(254),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(128),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const AddDomainSchema = z.object({
  /** Raw paste: "samsung.com" or "https://www.samsung.com/uk/phones" */
  rawInput: z.string().min(1).max(2048),
  budget: CrawlBudgetSchema.partial().optional(),
});

export const StartIngestSchema = z.object({
  domainId: z.string().ulid(),
  /** "YYYY-MM" */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  budgetOverride: CrawlBudgetSchema.partial().optional(),
});

export const DomainParamSchema = z.object({
  domainId: z.string().ulid(),
});

// ── Job status (SSE events) ──────────────────────────────────────────────────

export type IngestStatus =
  | "queued"
  | "surveying"
  | "fetching"
  | "rewriting"
  | "ready"
  | "partial"
  | "failed";

export interface IngestProgressEvent {
  type: "progress";
  ingestId: string;
  status: IngestStatus;
  pagesTotal: number;
  pagesDone: number;
  assetsTotal: number;
  assetsDone: number;
  bytesStored: number;
  ia429Count: number;
  message?: string;
}

export interface IngestDoneEvent {
  type: "done";
  ingestId: string;
  status: "ready" | "partial" | "failed";
}

export type IngestEvent = IngestProgressEvent | IngestDoneEvent;

// ── CDX types ────────────────────────────────────────────────────────────────

export interface CdxRow {
  timestamp: string; // 14-digit
  original: string; // original URL
  mimetype: string;
  statuscode: string;
  digest: string;
  length: string;
}

export interface DayBucket {
  day: string; // "YYYY-MM-DD"
  captures: CdxRow[];
  /** The single chosen capture for this day (§6.2 policy). */
  chosen: CdxRow;
}

// ── Viewer ───────────────────────────────────────────────────────────────────

export interface ViewerParams {
  domain: string;
  day: string; // "YYYY-MM-DD"
  path: string; // original path under domain
}

export interface SnapshotMeta {
  url: string;
  day: string;
  ts: string;
  resolvedDay: string | null;
  deltaDays: number | null;
  r2Key: string | null;
  purgedAt: number | null;
}

// ── Coverage ─────────────────────────────────────────────────────────────────

export interface DayCoverage {
  day: string;
  captureCount: number; // 0 = dimmed in calendar
}

export interface MonthCoverage {
  year: number;
  month: number;
  days: DayCoverage[];
}

// ── Usage ────────────────────────────────────────────────────────────────────

export type UsageKind =
  | "ia_fetch"
  | "r2_put"
  | "r2_get"
  | "r2_delete"
  | "bytes_stored"
  | "bytes_served"
  | "worker_cpu_ms"
  | "worker_request"
  | "queue_op"
  | "throttle_wait_ms";

// ── Cost monitoring (Phase 4) ────────────────────────────────────────────────

/** Per-kind roll-up: what we used, what it cost, what was free. */
export interface CostLine {
  kind: string;
  unit: string;
  units: number;
  /** Units beyond the monthly free allowance. */
  billableUnits: number;
  freeUnits: number;
  costUsd: number;
}

export interface DomainCost {
  domain: string;
  lines: CostLine[];
  totalUsd: number;
  bytesStored: number;
  iaFetches: number;
  throttleEvents: number;
  /** Milliseconds spent waiting on archive.org backoff. */
  throttleWaitMs: number;
}

export interface BudgetStatus {
  /** "ok" | "warn" | "exceeded" | "disabled" */
  state: "ok" | "warn" | "exceeded" | "disabled";
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  /** 0–1+, spent / budget. */
  fraction: number;
  /** True when new crawls should be refused. */
  crawlsBlocked: boolean;
}

export interface UsageReport {
  /** "YYYY-MM" */
  month: string;
  generatedAt: number;
  /** Modelled total for the month, including the plan floor. */
  totalUsd: number;
  /** The fixed plan charge, listed separately so the arithmetic is checkable. */
  planFloorUsd: number;
  /** Sum of metered lines only. */
  meteredUsd: number;
  byKind: CostLine[];
  byDomain: DomainCost[];
  budget: BudgetStatus;
  /** Crawl quota consumption for the current day. */
  quota: {
    limit: number;
    used: number;
    remaining: number;
    resetsAt: number;
  };
  /** Throttle summary — this is the §12 "are we being a good citizen" readout. */
  throttle: {
    events: number;
    byStatus: Record<string, number>;
    lastEventAt: number | null;
    totalWaitMs: number;
  };
}

/** Throttle state surfaced to the UI while a crawl is running. */
export interface ThrottleState {
  /** True when archive.org is currently backing us off. */
  active: boolean;
  /** Unix seconds until we resume, or null when not waiting. */
  resumeAt: number | null;
  /** Consecutive throttles observed. */
  consecutive: number;
  /** Human-readable line for the progress panel. */
  message: string | null;
}

// ── Ingest queue messages (Phase 4) ──────────────────────────────────────────

/**
 * One queue message = one bounded unit of work. A job's whole life is a chain
 * of these, which is what makes it resumable: a message that dies is retried,
 * and a retry re-reads the checkpoint instead of restarting the crawl.
 */
export interface IngestQueueMessage {
  ingestId: string;
  domain: string;
  month: string;
  stage: "survey" | "pages" | "assets" | "finalize";
  /** Delivery attempt, incremented by the producer on each re-enqueue. */
  attempt?: number;
  /** Set when the previous message asked us to wait out a breaker. */
  notBefore?: number;
  enqueuedAt?: number;
}

