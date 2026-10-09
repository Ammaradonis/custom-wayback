/**
 * Wayback Machine protocol: CDX survey specs and parsing, Availability lookups, and
 * raw (`id_`) replay URLs. This is the pure, runtime-agnostic half of the old
 * apps/crawler-local/src/wayback.ts; the HTTP client that needs a polite fetcher
 * (`WaybackClient`) stayed behind in that package.
 *
 * =====================================================================================
 * MEASURED archive.org BEHAVIOUR (October 2026) -- this shapes the whole module.
 * =====================================================================================
 * Probed live against web.archive.org/cdx/search/cdx for example.com, Jan 2024:
 *
 *   query shape                                        result
 *   -------------------------------------------------  --------------------------------
 *   plain `limit=3`, no from/to/collapse/fl              200 OK   ~11 s
 *   plain `limit=10`                                     200 OK   ~10 s
 *   plain `limit=50`                                     200 OK   ~25 s
 *   `from`/`to` + `filter=statuscode:200` (no limit)    HUNG, connection closed @119 s
 *   `from`/`to` + `collapse=timestamp:8` + limit        504 Gateway Timeout @62 s
 *   `from`/`to` + `collapse=urlkey`                      HUNG, closed @120 s
 *   same-day-only range query                            504 Gateway Timeout @60 s
 *   `showResumeKey=true`                                 HUNG, closed @181 s
 *   `showNumPages=true`                                  200 OK   ~1 s   (returns 912)
 *   `page=0&pageSize=1`                                  200 OK   ~1 s   (returns [])
 *
 * Conclusions encoded below:
 *  1. `showResumeKey=true` is a trap: it forces a full scan to find a resumption point.
 *     It is NOT used on the default path.
 *  2. `from`/`to` ranges and `collapse=` are the expensive part. They do not fail fast;
 *     they hang until the server 504s. So a survey needs a wall-clock deadline and a
 *     request ceiling, and must return whatever it got rather than throwing.
 *  3. `limit=N` genuinely bounds server work (the scan stops at N rows), so it is the
 *     one knob that reliably keeps a CDX query cheap.
 *  4. The documented pagination API is currently unusable from outside (a 912-page
 *     index returns an empty first page), so it is a best-effort enhancement only.
 *
 * The result: the survey is a bounded, deadline-driven, non-fatal operation. If
 * archive.org is having a bad day, the ingest degrades to a smaller survey or to
 * on-demand fetches and says so, instead of hanging for three minutes per query.
 * That loop lives in `WaybackClient.survey()` (apps/crawler-local); the specs, URL
 * builders and parser it drives are here so the Worker ingest path can share them.
 */

import { hashString, tsToDay } from './urlutil.js';

export const CDX_ENDPOINT = 'https://web.archive.org/cdx/search/cdx';
export const RAW_PREFIX = 'https://web.archive.org/web';
export const AVAILABILITY_ENDPOINT = 'https://archive.org/wayback/available';

export interface CdxRow {
  url: string;
  ts: string;
  mime: string;
  status: number;
  digest: string | null;
  bytes: number;
  day: string;
}

export interface SurveySpec {
  label: string;
  params: Record<string, string>;
}

export interface SurveyProgress {
  (info: { label: string; requests: number; rows: number; done: boolean; note?: string }): void;
}

export interface SurveyBudget {
  /** Wall-clock ceiling for this survey, in ms. */
  deadlineMs: number;
  /** Maximum HTTP requests this survey may spend. */
  maxRequests: number;
  /** Row cap per CDX query. */
  limit: number;
}

/** The URL that returns the *original* bytes of a capture. */
export function buildIdUrl(timestamp: string, originalUrl: string): string {
  return `${RAW_PREFIX}/${timestamp}id_/${originalUrl}`;
}

export function buildReplayUrl(timestamp: string, originalUrl: string): string {
  return `${RAW_PREFIX}/${timestamp}/${originalUrl}`;
}

/**
 * CDX query for HTML page captures in the window.
 * Note the deliberate absence of `collapse` and `showResumeKey`: both force full scans.
 * Day selection happens client-side in ledger.ts instead, which is free.
 */
export function htmlSurvey(domain: string, from: string, to: string, limit: number): SurveySpec {
  return {
    label: 'html',
    params: {
      url: domain,
      matchType: 'domain',
      from,
      to,
      filter: 'statuscode:200',
      limit: String(limit),
    },
  };
}

/**
 * CDX query for non-HTML assets. `filter=!mimetype:text/html` is cheap enough to keep
 * because the result set is bounded by `limit`; if it 504s the survey simply has no
 * asset index and assets are fetched on demand.
 */
export function assetSurvey(domain: string, from: string, to: string, limit: number): SurveySpec {
  return {
    label: 'asset',
    params: {
      url: domain,
      matchType: 'domain',
      from,
      to,
      filter: '!mimetype:text/html',
      limit: String(limit),
    },
  };
}

export function buildSurveyUrl(spec: SurveySpec): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(spec.params)) usp.append(k, v);
  usp.append('output', 'json');
  usp.append('fl', 'timestamp,original,mimetype,statuscode,digest,length');
  return `${CDX_ENDPOINT}?${usp.toString()}`;
}

/**
 * Single-URL capture lookup within one day.
 *
 * This is the workhorse when a domain-wide survey is unavailable. A CDX query for a
 * single exact URL over a one-day range is vastly cheaper for archive.org than a
 * domain-wide range scan, and in testing it is the difference between "returns in a
 * few seconds" and "504 Gateway Timeout after 60 s".
 */
export function exactUrlSurvey(url: string, day: string): SurveySpec {
  return {
    label: `exact:${new URL(url).pathname || '/'}`,
    params: {
      url,
      matchType: 'exact',
      from: `${day.replace(/-/g, '')}000000`,
      to: `${day.replace(/-/g, '')}235959`,
      filter: 'statuscode:200',
      limit: '20',
    },
  };
}

/**
 * Stable survey cache key.
 *
 * 16 hex characters from `hashString` (FNV-ish, see urlutil.ts). This is a
 * non-cryptographic hash and it is used for exactly one thing: as the cache key for a
 * survey spec, whose cardinality is a handful of specs per domain/month. There is no
 * collision risk at that size, and staying synchronous and dependency-free means the
 * same code runs under both runtimes without importing a crypto module.
 */
export function surveyCacheKey(spec: SurveySpec): string {
  return hashString(`${spec.label}|${JSON.stringify(spec.params)}`);
}

type CdxJsonRow = [string, string, string, string, string, string, string];

/** Parse a CDX JSON page into rows. Tolerates the resumption-key trailer if present. */
export function parseCdxJson(text: string): { rows: CdxRow[]; resumeKey?: string; error?: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { rows: [] };
  if (!trimmed.startsWith('[')) {
    return { rows: [], error: trimmed.slice(0, 300) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { rows: [], error: `unparseable CDX JSON: ${trimmed.slice(0, 200)}` };
  }
  if (!Array.isArray(parsed)) return { rows: [], error: 'CDX response was not an array' };

  const rows: CdxRow[] = [];
  let resumeKey: string | undefined;
  let sawHeader = false;

  for (const entry of parsed as unknown[]) {
    if (!Array.isArray(entry)) continue;
    const cells = entry as string[];
    if (cells.length === 0) continue;
    if (!sawHeader && cells[0] === 'timestamp') {
      sawHeader = true;
      continue;
    }
    if (cells.length === 1) {
      resumeKey = cells[0]!;
      continue;
    }
    if (cells.length < 6) continue;
    const [ts, original, mime, status, digest, length] = cells as CdxJsonRow;
    rows.push({
      url: original,
      ts,
      mime: mime || 'application/octet-stream',
      status: Number.parseInt(status || '0', 10) || 0,
      digest: digest && digest.length > 0 ? digest : null,
      bytes: Number.parseInt(length || '0', 10) || 0,
      day: tsToDay(ts),
    });
  }

  return resumeKey ? { rows, resumeKey } : { rows };
}

export interface SurveyResult {
  rows: CdxRow[];
  requests: number;
  fromCache: boolean;
  /** True when the survey stopped early because of a cap, deadline, or error. */
  degraded: boolean;
  /** Human-readable reason for degradation, surfaced in the report. */
  degradedReason?: string;
  elapsedMs: number;
}

export interface SurveyCache {
  getSurvey(domain: string, month: string, queryHash: string): string | undefined;
  putSurvey(domain: string, month: string, queryHash: string, payload: string): void;
}

export function cdxRowToArray(r: CdxRow): string[] {
  return [r.ts, r.url, r.mime, String(r.status), r.digest ?? '', String(r.bytes)];
}

/** Detect an archive.org error page served with HTTP 200. */
export function looksLikeWaybackError(body: Uint8Array, contentType: string): boolean {
  if (!contentType.includes('text/html')) return false;
  const head = new TextDecoder().decode(body.subarray(0, 4096)).toLowerCase();
  return (
    head.includes("wayback machine doesn't have that page archived") ||
    head.includes('this page is not available in the wayback machine') ||
    head.includes('cannot find the requested url') ||
    head.includes('the wayback machine has not archived that url')
  );
}
