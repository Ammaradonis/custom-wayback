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
  | "worker_cpu_ms";
