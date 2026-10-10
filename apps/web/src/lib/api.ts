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

/**
 * A failed API call, carrying the HTTP status and the decoded body.
 *
 * It is still an `Error` whose `message` is the server's own wording, so every
 * existing `catch (err) { err.message }` keeps working unchanged. The extra
 * fields exist because some endpoints say *why* in a way the UI must branch on:
 * search answers a nonsense query with `400 invalid_query` (help text, not an
 * error) and a broken index with `422`/`503` (a real error). Branching on a
 * status code is honest; parsing the message string is not.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }

  /** The `error` field (`invalid_query`, `Domain not found`, …), when present. */
  get code(): string | null {
    if (this.payload && typeof this.payload === "object" && "error" in this.payload) {
      const value = (this.payload as { error?: unknown }).error;
      if (typeof value === "string") return value;
    }
    return null;
  }
}

/** Options for {@link request}. */
interface RequestOptions {
  /**
   * Prefer the server's `message` field over its `error` field.
   *
   * The `error` field is a machine token (`Domain not found`, `bundle_too_large`)
   * and is what every existing caller shows. Some endpoints — search, share
   * minting, export — also return a `message` written *for a person*, and that is
   * the better thing to put in front of one.
   */
  preferMessage?: boolean;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
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

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText })) as {
      error?: string;
      message?: string;
    };
    const fallback = err.error ?? `HTTP ${resp.status}`;
    const message =
      options?.preferMessage === true && typeof err.message === "string" && err.message.length > 0
        ? err.message
        : fallback;

    // Only redirect to /login and clear the token for 401s that happen on
    // authenticated routes — not on login/register itself. Clearing the token
    // on a login failure redirects the user away from the login form, hides the
    // real error ("Invalid credentials"), and shows "Unauthorized" instead.
    if (resp.status === 401 && !path.startsWith("/auth/")) {
      clearToken();
      window.location.href = "/login";
    }

    throw new ApiError(message, resp.status, err);
  }

  return resp.json() as Promise<T>;
}

/** Drop keys whose value is `undefined`, so an omitted filter stays omitted. */
function compact<T extends object>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * Any object of primitive fields → a query string, empties and `undefined` dropped.
 *
 * Takes a plain `object` rather than an index-signature type because the callers
 * are typed interfaces (`SearchQuery`, `ComparePageDiff` input, …), and interfaces
 * do not have implicit index signatures.
 */
function qs(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || typeof value === "number") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const auth = {
  register: (email: string, password: string) =>
    request<{ ok: boolean }>("POST", "/auth/register", { email, password }, { preferMessage: true }),
  login: (email: string, password: string) =>
    request<{ token: string }>("POST", "/auth/login", { email, password }, { preferMessage: true }),
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

// ── Feature types ─────────────────────────────────────────────────────────────
//
// Search, compare, shares and exports were added to the API in Phase 5
// (plan.md §15). The interfaces below mirror the JavaScript objects those routes
// actually return — `apps/api/src/routes/{search,compare,shares,export}.ts` and
// `apps/api/src/lib/search.ts` are the single source of truth. They are
// redeclared here rather than imported for the reason given above the cost
// types: `@custom-wayback/shared` exposes only its barrel, and that barrel pulls
// zod and drizzle into the browser bundle. Keep these in lockstep with the
// routes.

/** One search result. `route` is the viewer path to open; `snippet` is archived third-party text. */
export interface SearchHit {
  domain: string;
  url: string;
  /** `YYYY-MM-DD`. */
  day: string;
  /** The capture timestamp, `YYYYMMDDhhmmss`. */
  ts: string;
  /** Frequently null — render the URL instead of an empty title. */
  title: string | null;
  /** BM25 rank; higher is better. */
  score: number;
  /** Already trimmed; may begin or end with an ellipsis. */
  snippet: string;
  /** e.g. `/a/example.com/2024-03-15/pricing`. */
  route: string;
}

/** `GET /v1/search?q=…` */
export interface SearchResult {
  query: string;
  /** The escaped FTS5 expression actually run — worth showing in a disclosure. */
  expression: string;
  total: number;
  hits: SearchHit[];
  tookMs: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Query for {@link search.query}. Every field but `q` is optional. */
export interface SearchQuery {
  q: string;
  domain?: string;
  /** `YYYY-MM`. */
  month?: string;
  /** `YYYY-MM-DD`. */
  day?: string;
  limit?: number;
  offset?: number;
}

/**
 * `POST /v1/search/reindex` — one bounded batch.
 *
 * `remaining > 0` means call it again to continue. `skipped` is the honest
 * number: pages whose stored copy was already purged and so cannot be indexed.
 */
export interface ReindexProgress {
  indexed: number;
  /** Stored copies that are gone — search will never see these pages. */
  skipped: number;
  /** Stored pages that yielded no indexable text (JS shells, image-only pages). */
  empty: number;
  remaining: number;
  done: boolean;
}

export const search = {
  query: (params: SearchQuery) =>
    request<SearchResult>("GET", `/search${qs(compact(params))}`, undefined, {
      // 400 `invalid_query` carries a message written for the person who typed
      // the query; `***` deserves an explanation, not a token.
      preferMessage: true,
    }),
  /**
   * Index one bounded batch of stored pages. Stop when `remaining === 0`;
   * loop in the caller so progress is visible (`apps/web/src/routes/SearchPage.tsx`).
   */
  reindex: (scope: { domain?: string; month?: string } = {}) =>
    request<ReindexProgress>(
      "POST",
      `/search/reindex${qs(compact(scope))}`,
      undefined,
      { preferMessage: true },
    ),
};

// ── Compare two months ────────────────────────────────────────────────────────

export type ChangeKind = "added" | "removed" | "changed" | "unchanged" | "unknown";

export interface CompareChange {
  url: string;
  kind: ChangeKind;
  title: string | null;
  /** `YYYY-MM-DD`, or null when the row has no capture day. */
  day: string | null;
  /** Why this row is uncertain. Show it when present. */
  note?: string;
}

/** `GET /v1/compare?domain=&from=&to=` */
export interface CompareResult {
  domain: string;
  from: string;
  to: string;
  counts: Record<ChangeKind, number>;
  totalPages: { from: number; to: number };
  hasDigests: boolean;
  /** Present when digests are missing: "changed" is inferred, not exact. */
  note?: string;
  changes: CompareChange[];
}

/** One side of a page diff. `available: false` means the stored copy was purged. */
export interface ComparePageSide {
  day: string;
  title: string | null;
  bytes: number | null;
  available: boolean;
}

/** One run of text in a word-level diff, in document order. */
export interface DiffSegment {
  kind: "same" | "added" | "removed";
  text: string;
}

/** `GET /v1/compare/page?domain=&from=&to=&url=` */
export interface ComparePageDiff {
  domain: string;
  url: string;
  from: string;
  to: string;
  kind: ChangeKind;
  before: ComparePageSide | null;
  after: ComparePageSide | null;
  /** e.g. `"1 word replaced by 1"`. */
  summary: string;
  addedWords: number;
  removedWords: number;
  /** True when the page was too large for an exact diff. */
  truncated: boolean;
  segments: DiffSegment[];
  /** Months whose stored copy has been purged, so the diff is incomplete. */
  unavailableMonths?: string[];
  /** Explains an incomplete diff. Show it when present. */
  note?: string;
}

export const compare = {
  months: (domain: string, from: string, to: string) =>
    request<CompareResult>(
      "GET",
      `/compare${qs({ domain, from, to })}`,
      undefined,
      { preferMessage: true },
    ),
  /**
   * The word-level diff for one page. Deliberately a second call: the list is two
   * indexed reads, while this reads both versions out of R2. Fetch it only for the
   * row the user opened, never eagerly for the whole list.
   */
  page: (params: { domain: string; from: string; to: string; url: string }) =>
    request<ComparePageDiff>(
      "GET",
      `/compare/page${qs(compact(params))}`,
      undefined,
      { preferMessage: true },
    ),
};

// ── Share links ───────────────────────────────────────────────────────────────

/** `POST /v1/shares` — the one and only time `token` is ever returned. */
export interface CreatedShare {
  id: string;
  /** Shown once. Only a hash is stored, so it cannot be retrieved later. */
  token: string;
  /** `/s/<token>` — the stable URL of the link. */
  shareUrl: string;
  /** The viewer route the link resolves to, e.g. `/a/example.com/2024-03-15/pricing`. */
  resolvesTo: string;
  domain: string;
  month: string | null;
  day: string | null;
  url: string | null;
  label: string | null;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds, or null when the link does not expire. */
  expiresAt: number | null;
  /** Says plainly that the link is behind the app's access control, not public. */
  accessNote: string;
}

/** Scope of a link. A `day` or `url` requires a `month`. */
export interface ShareScopeInput {
  domain: string;
  month?: string;
  day?: string;
  url?: string;
  label?: string;
  expiresInDays?: number;
}

/** One row of `GET /v1/shares` (snake_case: it is a database row). */
export interface ShareRecord {
  id: string;
  domain: string;
  month: string | null;
  day: string | null;
  url: string | null;
  label: string | null;
  /** Unix seconds. */
  created_at: number;
  /** Unix seconds, or null. */
  expires_at: number | null;
  /** Unix seconds when revoked, or null while live. */
  revoked_at: number | null;
  view_count: number;
  last_viewed_at: number | null;
}

export const shares = {
  create: (input: ShareScopeInput) =>
    request<CreatedShare>("POST", "/shares", compact(input), { preferMessage: true }),
  list: () => request<{ shares: ShareRecord[]; note: string }>("GET", "/shares"),
  /** Revoke. The row is kept, so the link stops working but the record remains. */
  revoke: (id: string) =>
    request<{ ok: boolean }>("DELETE", `/shares/${encodeURIComponent(id)}`, undefined, {
      preferMessage: true,
    }),
};

// ── Export a month as a static bundle ─────────────────────────────────────────

export type ExportStatus = "building" | "ready" | "failed" | "deleted";

/**
 * An export row. Mirrors `apps/api/src/routes/export.ts`.
 *
 * Timestamps and the error text are camelCase (`createdAt`, `finishedAt`,
 * `error`) because that is what `exportJson()` sends; `status`, `bytes`, `pages`,
 * `assets` and `missing` are the row's own column names. Both spellings of the
 * timestamps are typed because the 202 body from `POST /v1/export` and the body
 * from `GET /v1/export/:id` are not identical, and a UI that crashes on the
 * difference would be worse than one that reads either.
 */
export interface ExportRecord {
  id: string;
  domain: string;
  month: string;
  status: ExportStatus;
  /** Size of the finished zip in bytes. */
  bytes: number;
  /** Pages actually written into the bundle. */
  pages: number;
  /** Distinct assets referenced by those pages. */
  assets: number;
  /**
   * Pages that could NOT be included because their stored copy was purged. Shown
   * prominently when non-zero: the bundle is incomplete.
   */
  missing: number;
  /** The failure reason when `status === "failed"`. */
  error?: string | null;
  error_message?: string | null;
  createdAt?: number;
  created_at?: number;
  finishedAt?: number | null;
  finished_at?: number | null;
  /** Present only while `status === "ready"`. */
  downloadUrl?: string;
}

export const exports = {
  /**
   * Start a bundle. The API builds it inside the request and answers `202` with the
   * finished row when it succeeds, so a returned row may already be `ready`. Poll
   * {@link exports.status} while it is not — a build interrupted mid-flight leaves a
   * `building` row behind.
   */
  start: (domain: string, month: string) =>
    request<ExportRecord>("POST", "/export", { domain, month }, { preferMessage: true }),
  status: (id: string) =>
    request<ExportRecord>("GET", `/export/${encodeURIComponent(id)}`, undefined, {
      preferMessage: true,
    }),
  /** Removes the artifact; the record stays, with `status: "deleted"`. */
  remove: (id: string) =>
    request<{ ok: boolean; id?: string; status?: string }>(
      "DELETE",
      `/export/${encodeURIComponent(id)}`,
      undefined,
      { preferMessage: true },
    ),
  /** The zip itself. A plain `<a download>` works; the request helper is for JSON. */
  downloadUrl: (id: string) => `${BASE}/export/${encodeURIComponent(id)}/download`,
};
