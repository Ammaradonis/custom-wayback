/**
 * Typed API client. Reads the JWT from localStorage (key: "cw_token").
 * Never logs or exposes the token value.
 */

const BASE = "/v1";

function getToken(): string | null {
  return localStorage.getItem("cw_token");
}

export function setToken(token: string): void {
  localStorage.setItem("cw_token", token);
}

export function clearToken(): void {
  localStorage.removeItem("cw_token");
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (resp.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${resp.status}`);
  }

  return resp.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const auth = {
  register: (email: string, password: string) =>
    request<{ ok: boolean }>("POST", "/auth/register", { email, password }),
  login: (email: string, password: string) =>
    request<{ token: string }>("POST", "/auth/login", { email, password }),
  logout: () => request<{ ok: boolean }>("POST", "/auth/logout"),
  logoutAll: () => request<{ ok: boolean }>("POST", "/auth/logout-all"),
};

// ── Domains ───────────────────────────────────────────────────────────────────

export interface DomainEntry {
  id: string;
  domain: string;
  hostFilter: string | null;
  trackingStatus: string;
  addedAt: number;
  lastCrawledAt: number | null;
}

export const domains = {
  list: () => request<DomainEntry[]>("GET", "/domains"),
  add: (rawInput: string, budget?: Record<string, unknown>) =>
    request<{ id: string; domain: string }>("POST", "/domains", { rawInput, budget }),
  remove: (domainId: string) =>
    request<{ ok: boolean }>("DELETE", `/domains/${domainId}`),
  coverage: (domainId: string) =>
    request<string[]>("GET", `/domains/${domainId}/coverage`),
};

// ── Ingest ────────────────────────────────────────────────────────────────────

/**
 * Cost-monitoring types — mirrors `packages/shared/src/types.ts`, which is the
 * single source of truth. They are redeclared here rather than imported because
 * `@custom-wayback/shared` exposes only its barrel (`dist/index.js`), and that
 * barrel re-exports `./schema.js`, which imports zod and drizzle-orm. Importing
 * *anything* from the barrel would either drag those runtime deps into the
 * browser bundle or force a build of the shared package before the web build.
 * Keep these in lockstep with packages/shared/src/types.ts.
 */

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
  state: "ok" | "warn" | "exceeded" | "disabled";
  budgetUsd: number;
  spentUsd: number;
  /** May be `Infinity` when the guardrail is disabled. */
  remainingUsd: number;
  /** 0–1+, spent / budget. */
  fraction: number;
  /** True when new crawls should be refused. */
  crawlsBlocked: boolean;
}

export interface UsageReport {
  /** "YYYY-MM" */
  month: string;
  /** Unix seconds. */
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
  quota: { limit: number; used: number; remaining: number; resetsAt: number };
  /** Throttle summary — the §12 "are we being a good citizen" readout. */
  throttle: {
    events: number;
    byStatus: Record<string, number>;
    /** Unix seconds, or null when nothing has been throttled. */
    lastEventAt: number | null;
    totalWaitMs: number;
  };
}

/** `GET /v1/jobs/usage/limits` — the limits currently in force. */
export interface UsageLimits {
  crawlQuotaPerDay: number;
  crawlQuotaRemaining: number;
  /** Unix seconds. */
  crawlQuotaResetsAt: number;
  monthlyBudgetUsd: number;
  readLimitPerMinute: number;
}

/** Throttle state surfaced while a crawl is running. Mirrors the shared type. */
export interface ThrottleState {
  /** True when archive.org is currently backing us off. */
  active: boolean;
  /** Unix seconds until we resume, or null when not waiting. */
  resumeAt: number | null;
  consecutive: number;
  /** Human-readable line for the progress panel. */
  message: string | null;
}

/** One `{ type: "progress", … }` frame from `/v1/jobs/:ingestId/events`. */
export interface IngestProgressEvent {
  type: string;
  ingestId?: string;
  status?: string;
  stage?: string | null;
  pagesTotal?: number;
  pagesDone?: number;
  assetsTotal?: number;
  assetsDone?: number;
  bytesStored?: number;
  ia429Count?: number;
  attempts?: number;
  degradedReason?: string | null;
  throttle?: ThrottleState;
}

export interface IngestJob {
  id: string;
  status: string;
  /** Pipeline stage: survey | pages | assets | finalize | done. */
  stage: string | null;
  pagesTotal: number;
  pagesDone: number;
  assetsTotal: number;
  assetsDone: number;
  bytesStored: number;
  ia429Count: number;
  errorMessage: string | null;
  /** Queue delivery attempts spent on this job. */
  attempts: number;
  /** Set when the crawl finished with a caveat (e.g. byte cap hit). */
  degradedReason: string | null;
  throttle: ThrottleState;
}

export const ingest = {
  start: (domainId: string, month: string) =>
    request<{ id: string; status: string }>("POST", "/jobs", { domainId, month }),
  status: (ingestId: string) =>
    request<IngestJob>("GET", `/jobs/${ingestId}`),
  cancel: (ingestId: string) =>
    request<{ ok: boolean }>("DELETE", `/jobs/${ingestId}`),
  /** Cost report for one month (`YYYY-MM`); the API defaults to the current month. */
  usage: (month?: string) =>
    request<UsageReport>(
      "GET",
      month ? `/jobs/usage?month=${encodeURIComponent(month)}` : "/jobs/usage",
    ),
  /** The quota/budget/rate limits currently in force. */
  usageLimits: () => request<UsageLimits>("GET", "/jobs/usage/limits"),
};

// ── SSE helper ────────────────────────────────────────────────────────────────

export function watchIngest(
  ingestId: string,
  onEvent: (ev: unknown) => void,
  onDone: () => void,
): () => void {
  const token = getToken();
  if (!token) return () => void 0;

  const es = new EventSource(`${BASE}/jobs/${ingestId}/events`);

  es.onmessage = (e) => {
    const data = JSON.parse(e.data as string) as { type: string };
    onEvent(data);
    if (data.type === "done") {
      es.close();
      onDone();
    }
  };
  es.onerror = () => {
    es.close();
    onDone();
  };

  return () => es.close();
}

// ── Manifest / sites ─────────────────────────────────────────────────────────

export interface SiteEntry {
  domain: string;
  month: string;
  pages: number;
  days: number;
}

export interface ManifestPage {
  url: string;
  day: string;
  ts: string;
  title: string | null;
  bytes: number | null;
  route: string;
  resolvedDay: string | null;
  deltaDays: number | null;
  stored: boolean;
  purged: boolean;
}

export interface Manifest {
  version: number;
  domain: string;
  month: string;
  days: string[];
  pages: ManifestPage[];
  stats: unknown;
  note?: string;
}

export const manifests = {
  sites: () => request<{ sites: SiteEntry[] }>("GET", "/sites"),
  manifest: (domain: string, month: string) =>
    request<Manifest>(
      "GET",
      `/manifest?domain=${encodeURIComponent(domain)}&month=${encodeURIComponent(month)}`,
    ),
};
