/**
 * Wayback Machine client: CDX survey, Availability lookups, and raw (`id_`) replay.
 *
 * This file is now only the half that needs a polite fetcher. The protocol half --
 * endpoints, survey specs, CDX parsing, cache keys and the `id_` URL builders -- lives
 * in `@custom-wayback/pipeline` and is re-exported below, so existing importers of
 * './wayback.ts' (orchestrator.ts, pipeline.test.ts) keep working unchanged.
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

import {
  AVAILABILITY_ENDPOINT,
  buildIdUrl,
  buildSurveyUrl,
  cdxRowToArray,
  exactUrlSurvey,
  parseCdxJson,
  surveyCacheKey,
  tsToDay,
} from '@custom-wayback/pipeline';
import type {
  CdxRow,
  SurveyBudget,
  SurveyCache,
  SurveyProgress,
  SurveyResult,
  SurveySpec,
} from '@custom-wayback/pipeline';
import type { FetchOutcome, PoliteFetcher } from './politeness.ts';
import { ThrottleError } from './politeness.ts';

// The pure protocol pieces this module used to own. Re-exported explicitly (rather than
// `export *`) so the surface of './wayback.ts' stays exactly what it always was.
export {
  AVAILABILITY_ENDPOINT,
  CDX_ENDPOINT,
  RAW_PREFIX,
  assetSurvey,
  buildIdUrl,
  buildReplayUrl,
  buildSurveyUrl,
  cdxRowToArray,
  exactUrlSurvey,
  htmlSurvey,
  looksLikeWaybackError,
  parseCdxJson,
  surveyCacheKey,
} from '@custom-wayback/pipeline';
export type {
  CdxRow,
  SurveyBudget,
  SurveyCache,
  SurveyProgress,
  SurveyResult,
  SurveySpec,
} from '@custom-wayback/pipeline';

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
