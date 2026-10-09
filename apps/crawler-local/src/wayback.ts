/**
 * Wayback Machine client: CDX survey, Availability lookups, and raw (`id_`) replay.
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
 */

import { createHash } from 'node:crypto';
import type { PoliteFetcher, FetchOutcome } from './politeness.ts';
import { ThrottleError } from './politeness.ts';
import { tsToDay } from './urlutil.ts';

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

export function surveyCacheKey(spec: SurveySpec): string {
  return createHash('sha256').update(`${spec.label}|${JSON.stringify(spec.params)}`).digest('hex').slice(0, 24);
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

export class WaybackClient {
  private readonly fetcher: PoliteFetcher;
  private readonly cache: SurveyCache;

  constructor(fetcher: PoliteFetcher, cache: SurveyCache) {
    this.fetcher = fetcher;
    this.cache = cache;
  }

  private async getText(url: string, timeoutMs: number): Promise<{ text?: string; outcome: FetchOutcome }> {
    const outcome = await this.fetcher.fetch(url, {
      headers: { Accept: 'application/json,text/plain,*/*' },
      timeoutMs,
    });
    if (outcome.kind !== 'ok') return { outcome };
    return { text: new TextDecoder().decode(outcome.body), outcome };
  }

  /**
   * Run a bounded CDX survey.
   *
   * Never throws on timeout/throttle: it returns what it managed to collect plus a
   * `degraded` flag. A hard 429 still throws, because that is a signal to stop the
   * whole ingest rather than quietly proceed with bad data.
   */
  async survey(
    spec: SurveySpec,
    domain: string,
    month: string,
    budget: SurveyBudget,
    opts: { refresh?: boolean; onProgress?: SurveyProgress } = {},
  ): Promise<SurveyResult> {
    const started = Date.now();
    const key = surveyCacheKey(spec);

    if (!opts.refresh) {
      const cached = this.cache.getSurvey(domain, month, key);
      if (cached) {
        const { rows } = parseCdxJson(cached);
        opts.onProgress?.({ label: spec.label, requests: 0, rows: rows.length, done: true, note: 'from cache' });
        return { rows, requests: 0, fromCache: true, degraded: false, elapsedMs: 0 };
      }
    }

    const url = buildSurveyUrl(spec);
    let requests = 0;
    let rows: CdxRow[] = [];
    let degraded = false;
    let degradedReason: string | undefined;

    while (requests < budget.maxRequests) {
      const remaining = budget.deadlineMs - (Date.now() - started);
      if (remaining <= 2_000) {
        degraded = true;
        degradedReason = `survey deadline (${budget.deadlineMs} ms) reached after ${requests} request(s)`;
        break;
      }

      requests += 1;
      const { text, outcome } = await this.getText(url, Math.min(remaining, 30_000));

      if (text === undefined) {
        if (outcome.kind === 'throttled') {
          // A 429 on the index itself means stop the run, not "try a smaller query".
          throw new ThrottleError(
            `archive.org throttled the ${spec.label} survey (HTTP ${outcome.status}) after ${outcome.attempts} attempts`,
            outcome.status,
            url,
          );
        }
        if (outcome.kind === 'notfound') {
          opts.onProgress?.({ label: spec.label, requests, rows: rows.length, done: true, note: 'no captures' });
          return { rows: [], requests, fromCache: false, degraded: false, elapsedMs: Date.now() - started };
        }
        // 504s and connection resets land here. Partial data beats a hang.
        degraded = true;
        degradedReason =
          outcome.kind === 'error' ? `CDX ${spec.label} query failed: ${outcome.message}` : 'CDX query failed';
        break;
      }

      const parsed = parseCdxJson(text);
      if (parsed.error) {
        degraded = true;
        degradedReason = `CDX ${spec.label} error: ${parsed.error.slice(0, 160)}`;
        break;
      }

      const seen = new Set(rows.map((r) => `${r.url}|${r.ts}`));
      for (const row of parsed.rows) {
        const dedupe = `${row.url}|${row.ts}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        rows.push(row);
      }

      opts.onProgress?.({ label: spec.label, requests, rows: rows.length, done: false });

      // No resumption key support on this path, so one successful bounded query is
      // the whole survey. Fetching the same URL again would return the same rows.
      break;
    }

    if (requests >= budget.maxRequests && rows.length === 0) {
      degraded = true;
      degradedReason = `survey request ceiling (${budget.maxRequests}) reached with no rows`;
    }

    if (!degraded && rows.length > 0) {
      // Complete survey: safe to cache as CDX-shaped JSON.
      const header = ['timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'];
      this.cache.putSurvey(domain, month, key, JSON.stringify([header, ...rows.map(cdxRowToArray)]));
    }

    opts.onProgress?.({
      label: spec.label,
      requests,
      rows: rows.length,
      done: true,
      note: degraded ? degradedReason : undefined,
    });

    return { rows, requests, fromCache: false, degraded, degradedReason, elapsedMs: Date.now() - started };
  }

  /** Cheap single-URL probe. Fast (no index range scan) and used as a fallback seed. */
  async availability(
    url: string,
    timestamp?: string,
  ): Promise<{ available: boolean; ts?: string; url?: string; status?: string }> {
    const usp = new URLSearchParams({ url });
    if (timestamp) usp.set('timestamp', timestamp);
    const { text } = await this.getText(`${AVAILABILITY_ENDPOINT}?${usp.toString()}`, 15_000);
    if (!text) return { available: false };
    try {
      const parsed = JSON.parse(text) as {
        archived_snapshots?: {
          closest?: { available?: boolean; timestamp?: string; url?: string; status?: string };
        };
      };
      const closest = parsed.archived_snapshots?.closest;
      if (!closest?.available) return { available: false };
      return { available: true, ts: closest.timestamp, url: closest.url, status: closest.status };
    } catch {
      return { available: false };
    }
  }

  /** Last-resort seed: ask for the closest capture of one URL. One cheap request. */
  async seedCapture(
    url: string,
    timestamp: string,
  ): Promise<CdxRow | undefined> {
    const hit = await this.availability(url, timestamp);
    if (!hit.available || !hit.ts) return undefined;
    return {
      url,
      ts: hit.ts,
      mime: 'text/html',
      status: Number.parseInt(hit.status ?? '200', 10) || 200,
      digest: null,
      bytes: 0,
      day: tsToDay(hit.ts),
    };
  }

  /** Fetch the original bytes of a capture through `id_` raw replay. */
  async fetchRaw(
    timestamp: string,
    originalUrl: string,
    timeoutMs = 20_000,
  ): Promise<{ outcome: FetchOutcome; idUrl: string }> {
    const idUrl = buildIdUrl(timestamp, originalUrl);
    const outcome = await this.fetcher.fetch(idUrl, { timeoutMs });
    return { outcome, idUrl };
  }

  /**
   * Cheap exact-URL lookup for one day, used to build the crawl frontier when the
   * domain-wide survey is unavailable. Returns the best capture, or undefined.
   *
   * Never throws: a frontier lookup that fails just means one fewer page to crawl.
   */
  async lookupDay(
    url: string,
    day: string,
    timeoutMs = 20_000,
  ): Promise<{ row?: CdxRow; degradedReason?: string }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return {};
    const spec = exactUrlSurvey(url, day);
    const cdxUrl = buildSurveyUrl(spec);
    const { text, outcome } = await this.getText(cdxUrl, timeoutMs);

    if (text === undefined) {
      if (outcome.kind === 'throttled') {
        throw new ThrottleError(
          `archive.org throttled a frontier lookup (HTTP ${outcome.status})`,
          outcome.status,
          cdxUrl,
        );
      }
      return {
        degradedReason:
          outcome.kind === 'error' ? outcome.message : `lookup ${outcome.kind} (HTTP ${outcome.status})`,
      };
    }

    const parsed = parseCdxJson(text);
    if (parsed.error) return { degradedReason: parsed.error.slice(0, 120) };
    if (parsed.rows.length === 0) return {};

    // Prefer the largest capture: truncated captures are short.
    const best = [...parsed.rows].sort((a, b) => b.bytes - a.bytes)[0];
    return best ? { row: best } : {};
  }
}

function cdxRowToArray(r: CdxRow): string[] {
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
