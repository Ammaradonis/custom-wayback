/**
 * Crawl orchestrator: survey -> select -> fetch (raw) -> rewrite (once) -> store.
 *
 * Two passes, deliberately:
 *
 *   Pass 1 (fetch)   Pull raw `id_` bytes for every budgeted page and its assets.
 *                    Stores verbatim originals, dedupes assets by content hash, and
 *                    records every internal link edge it observes.
 *
 *   Pass 2 (rewrite) Only now is the link ledger complete, so each page is rewritten
 *                    exactly once with final link targets, asset paths and the
 *                    "captured 2 days earlier" annotations. No page is rewritten
 *                    twice and nothing is rewritten at read time.
 *
 * Rewriting in pass 2 is what makes the mirror feel unbroken: a page fetched early in
 * the crawl still knows where its links point, because nothing is rewritten until
 * every page has been stored.
 *
 * The survey phase is deadline-bounded and non-fatal (see wayback.ts for the measured
 * archive.org behaviour that forces this). If the index will not cooperate, the run
 * degrades to a seed-only ingest and reports exactly why.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FsBlobStore, sha256Hex } from './storage.ts';
import type { BlobStore } from './storage.ts';
import { Ledger } from './db.ts';
import {
  WaybackClient,
  assetSurvey,
  htmlSurvey,
  looksLikeWaybackError,
  type CdxRow,
  type SurveyResult,
} from './wayback.ts';
import { PoliteFetcher } from './politeness.ts';
import type { RequestStats } from './politeness.ts';
import { pickAssetCapture, resolveLink, selectPages } from '@custom-wayback/pipeline';
import type { SelectedPage } from '@custom-wayback/pipeline';
import { cssUrls, extractPage, rewriteCss, rewritePage } from './rewrite.ts';
import type { AssetRequest, LinkResolutionInfo, RewriteContext } from './rewrite.ts';
import { parseMonth } from './config.ts';
import type { CrawlOptions } from './config.ts';
import {
  assetBlobKey,
  assetPath,
  canonicalize,
  extensionOf,
  isMirrorableAsset,
  pageBlobKey,
  pathDepth,
  rawBlobKey,
  sameSite,
  snapshotPath,
  tsToDay,
} from '@custom-wayback/pipeline';
import type { Logger } from './logger.ts';

/** Raw HTML is kept in memory up to this size so pass 2 avoids a disk read. */
const IN_MEMORY_RAW_LIMIT = 2 * 1024 * 1024;

export interface CrawlReport {
  runId: string;
  domain: string;
  month: string;
  mode: 'perday' | 'anchor';
  anchorDay: string;
  anchorCoverage: number;
  startedAt: number;
  finishedAt: number;
  wallClockMs: number;
  survey: {
    htmlRows: number;
    assetRows: number;
    htmlFromCache: boolean;
    assetFromCache: boolean;
    requests: number;
    elapsedMs: number;
    degraded: boolean;
    degradedReason: string | null;
    usedSeedFallback: boolean;
    /** How the crawl frontier was recovered when the domain survey was unavailable. */
    frontierNote: string | null;
    distinctUrls: number;
    capturesConsidered: number;
    capturesDiscarded: number;
    coverageByDay: Record<string, number>;
  };
  pages: {
    selected: number;
    fetched: number;
    failed: number;
    rewritten: number;
    skippedByBudget: number;
    overBudget: boolean;
    bytesStored: number;
    averageBytes: number;
    withTitle: number;
    deadLinksFound: number;
    stubbedScripts: number;
    keptScripts: number;
    externalLinks: number;
  };
  links: {
    edges: number;
    resolved: number;
    unresolved: number;
    distinctTargets: number;
    sameDay: number;
    drifted: number;
    maxDriftDays: number;
  };
  assets: {
    referenced: number;
    fetched: number;
    failed: number;
    missing: number;
    uniqueStored: number;
    storedBytes: number;
    naiveBytes: number;
    dedupeSavedBytes: number;
    dedupeRatio: number;
    sharedAcrossPages: number;
    refs: number;
    skippedByExtension: number;
    /** Assets whose capture was found by a per-URL lookup (no domain survey available). */
    resolvedOnDemand: number;
  };
  ia: RequestStats & { surveyRequests: number; uniqueUrlsFetched: number; avgRequestsPerSecond: number };
  storage: { blobBytes: number; outDir: string };
  byDay: { day: string; pages: number; bytes: number }[];
  byRole: { role: string; count: number; bytes: number }[];
  topAssets: { hash: string; mime: string; bytes: number; refCount: number; url: string | null }[];
  failures: { url: string; reason: string }[];
  wallClockPerPageMs: number;
  archiveRequestsPerPage: number;
}

interface AssetRecord {
  hash: string;
  path: string;
  mime: string;
  bytes: number;
}

interface PageRecord {
  page: SelectedPage;
  rawKey: string;
  rawBytes: number;
  rawBody?: Uint8Array;
  assetMap: Map<string, string>;
  missingAssets: Set<string>;
  assetsReferenced: number;
  assetsFetched: number;
  assetsFailed: number;
  skippedByExtension: number;
  roleBytes: Map<string, { count: number; bytes: number }>;
}

export class Crawler {
  private readonly blobs: BlobStore;
  private readonly ledger: Ledger;
  private readonly wayback: WaybackClient;
  private readonly fetcher: PoliteFetcher;
  private readonly runId: string;
  private readonly opts: CrawlOptions;
  private readonly log: Logger;

  /** hash -> stored asset (global content-dedupe index for this run) */
  private readonly assetIndex = new Map<string, AssetRecord>();
  /** asset URL -> hash, or `false` when known-unavailable (negative cache) */
  private readonly assetUrlIndex = new Map<string, string | false>();
  private readonly linkEdges: { fromUrl: string; day: string; toUrl: string }[] = [];
  private readonly failures: { url: string; reason: string }[] = [];
  /** asset URL -> resolved capture (or undefined when archive.org has none). */
  private readonly assetLookups = new Map<string, CdxRow | undefined>();
  /** Day of the page currently being fetched, used as the hint for asset lookups. */
  private currentDay = '';
  private assetsResolvedOnDemand = 0;
  private uniqueUrlsFetched = 0;
  private overBudget = false;
  private bytesStored = 0;

  constructor(opts: CrawlOptions, log: Logger) {
    this.opts = opts;
    this.log = log;
    this.blobs = new FsBlobStore(opts.outDir);
    this.ledger = new Ledger(opts.dbPath);
    this.fetcher = new PoliteFetcher(opts.userAgent, {
      minDelayMs: opts.budget.minDelayMs,
      breakerThreshold: opts.budget.breakerThreshold,
      breakerCooldownMs: opts.budget.breakerCooldownMs,
      maxAttempts: opts.budget.maxAttempts,
      onThrottle: ({ status, attempt, waitMs }) =>
        this.log.warn('archive.org asked us to slow down', { status, attempt, waitMs }),
      onBreaker: ({ host, waitMs }) =>
        this.log.warn('circuit breaker open; pausing this host', { host, waitMs }),
    });
    this.wayback = new WaybackClient(this.fetcher, this.ledger);
    this.runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  close(): void {
    this.ledger.close();
  }

  async run(): Promise<CrawlReport> {
    const startedAt = Date.now();
    const { domain, month, mode } = this.opts;
    const range = parseMonth(month);
    this.ledger.startRun(this.runId, domain, month, mode);
    this.log.info('ingest starting', {
      domain,
      month,
      mode,
      target: `https://${domain}/`,
      maxPages: this.opts.budget.maxPages,
      minDelayMs: this.opts.budget.minDelayMs,
      includeAssets: this.opts.includeAssets,
    });

    // ---------------------------------------------------------------- survey
    const survey = await this.survey(range);
    let htmlRows = survey.html.rows;
    let usedSeedFallback = false;
    let frontierNote: string | null = null;

    if (htmlRows.length === 0) {
      // The pragmatic fallback: ask for the single closest capture of the seed URL.
      // One cheap request, and enough to produce a browsable (if shallow) mirror.
      const seed = this.opts.seedCanonical;
      const capture = await this.wayback.seedCapture(seed, range.firstDay);
      if (capture) {
        htmlRows = [capture];
        usedSeedFallback = true;
        this.log.warn('CDX survey yielded no rows; degraded to a seed-only ingest via the Availability API', {
          seed,
          captureTs: capture.ts,
        });
      } else {
        this.log.error('no captures found, and the Availability API returned nothing for the seed URL', {
          seed,
          hint: 'archive.org may be throttling this IP, or the domain may have no capture in this month',
        });
      }
    }

    // A seed-only mirror has no navigation: one page, no links, nothing to click.
    // Bootstrap a frontier from the seed page's own links, resolving each with a cheap
    // per-URL CDX query (a domain-wide range scan is what just failed).
    if (usedSeedFallback && htmlRows.length > 0) {
      const bootstrapped = await this.bootstrapFrontier(htmlRows[0]!, range.firstDay);
      if (bootstrapped.rows.length > 1) {
        htmlRows = bootstrapped.rows;
        frontierNote = bootstrapped.note;
      }
    }

    this.log.info('survey phase complete', {
      htmlCaptures: htmlRows.length,
      assetCaptures: survey.assets.rows.length,
      requests: survey.html.requests + survey.assets.requests,
      elapsedMs: survey.html.elapsedMs + survey.assets.elapsedMs,
      degraded: survey.html.degraded || survey.assets.degraded,
      usedSeedFallback,
      frontierNote,
    });

    const selection = selectPages(htmlRows, mode, this.opts.seedCanonical);
    this.log.info('selected one clean capture per day', {
      distinctUrls: selection.distinctUrls,
      pagesSelected: selection.pages.length,
      capturesCollapsed: selection.capturesDiscarded,
      anchorDay: selection.anchorDay,
      anchorCoverage: selection.anchorCoverage,
    });

    this.ledger.replaceCaptures(domain, 'html', htmlRows.map(cdxToCapture));
    this.ledger.replaceCaptures(domain, 'asset', survey.assets.rows.map(cdxToCapture));

    const budgeted = this.applyBudgets(selection.pages);
    const skippedByBudget = selection.pages.length - budgeted.length;
    if (skippedByBudget > 0) {
      this.log.warn('page budget applied; the rest will be served on demand', {
        ingesting: budgeted.length,
        deferredToOnDemand: skippedByBudget,
        budget: this.opts.budget.maxPages,
      });
    }

    const assetCaptures = this.indexAssetCaptures(survey.assets.rows);
    this.log.info('asset capture index built', { distinctAssetUrls: assetCaptures.size });

    // ---------------------------------------------------- pass 1: fetch raw
    const records: PageRecord[] = [];
    const pageDays = new Map<string, Set<string>>();
    let failed = 0;

    this.log.info('pass 1/2: fetching originals');
    for (const page of budgeted) {
      if (this.bytesStored >= this.opts.budget.maxBytes) {
        this.overBudget = true;
        this.log.warn('byte budget reached; stopping fetches', {
          storedMB: Math.round(this.bytesStored / 1024 / 1024),
          budgetMB: Math.round(this.opts.budget.maxBytes / 1024 / 1024),
        });
        break;
      }
      this.registerPageDay(pageDays, page.url, page.day);
      const record = await this.fetchPage(page, assetCaptures);
      if (!record) {
        failed += 1;
        continue;
      }
      records.push(record);
      this.log.debug('fetched', {
        day: page.day,
        url: page.url,
        kb: Math.round(record.rawBytes / 1024),
        assets: record.assetsFetched,
      });
    }
    this.log.info('pass 1 complete', {
      pagesFetched: records.length,
      pagesFailed: failed,
      iaRequests: this.fetcher.stats.attempts,
      throttled: this.fetcher.stats.throttled,
    });

    // ------------------------------------------------- pass 2: rewrite once
    this.log.info('pass 2/2: rewriting with the complete link ledger');
    const rewriteStats = await this.rewriteAll(records, pageDays);
    this.log.info('pass 2 complete', { rewritten: rewriteStats.rewritten });

    // ---------------------------------------------------------------- report
    const assetStats = this.ledger.assetStats();
    const naiveBytes = this.ledger.naiveAssetBytes();
    const dedupeSaved = Math.max(0, naiveBytes - assetStats.totalBytes);
    const finishedAt = Date.now();
    const wallClockMs = finishedAt - startedAt;

    const byDay = this.ledger.daysWithPages(domain).map((d) => {
      const rows = this.ledger.pagesForDay(domain, d.day);
      return { day: d.day, pages: d.n, bytes: rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0) };
    });

    const surveyRequests = survey.html.requests + survey.assets.requests;
    const surveyDegraded = survey.html.degraded || survey.assets.degraded;

    const report: CrawlReport = {
      runId: this.runId,
      domain,
      month,
      mode,
      anchorDay: selection.anchorDay,
      anchorCoverage: selection.anchorCoverage,
      startedAt,
      finishedAt,
      wallClockMs,
      survey: {
        htmlRows: htmlRows.length,
        assetRows: survey.assets.rows.length,
        htmlFromCache: survey.html.fromCache,
        assetFromCache: survey.assets.fromCache,
        requests: surveyRequests,
        elapsedMs: survey.html.elapsedMs + survey.assets.elapsedMs,
        degraded: surveyDegraded,
        degradedReason: survey.html.degradedReason ?? survey.assets.degradedReason ?? null,
        usedSeedFallback,
        frontierNote,
        distinctUrls: selection.distinctUrls,
        capturesConsidered: selection.capturesConsidered,
        capturesDiscarded: selection.capturesDiscarded,
        coverageByDay: selection.coverageByDay,
      },
      pages: {
        selected: selection.pages.length,
        fetched: records.length,
        failed,
        rewritten: rewriteStats.rewritten,
        skippedByBudget,
        overBudget: this.overBudget,
        bytesStored: this.bytesStored,
        averageBytes:
          rewriteStats.rewritten > 0 ? Math.round(rewriteStats.pageBytes / rewriteStats.rewritten) : 0,
        withTitle: rewriteStats.withTitle,
        deadLinksFound: rewriteStats.deadLinksFound,
        stubbedScripts: rewriteStats.stubbedScripts,
        keptScripts: rewriteStats.keptScripts,
        externalLinks: rewriteStats.externalLinks,
      },
      links: rewriteStats.links,
      assets: {
        referenced: records.reduce((n, r) => n + r.assetsReferenced, 0),
        fetched: records.reduce((n, r) => n + r.assetsFetched, 0),
        failed: records.reduce((n, r) => n + r.assetsFailed, 0),
        missing: new Set(records.flatMap((r) => [...r.missingAssets])).size,
        uniqueStored: assetStats.unique,
        storedBytes: assetStats.totalBytes,
        naiveBytes,
        dedupeSavedBytes: dedupeSaved,
        dedupeRatio: naiveBytes > 0 ? Number((dedupeSaved / naiveBytes).toFixed(4)) : 0,
        sharedAcrossPages: assetStats.shared,
        refs: assetStats.refs,
        skippedByExtension: records.reduce((n, r) => n + r.skippedByExtension, 0),
        resolvedOnDemand: this.assetsResolvedOnDemand,
      },
      ia: {
        ...this.fetcher.stats,
        surveyRequests,
        uniqueUrlsFetched: this.uniqueUrlsFetched,
        avgRequestsPerSecond: Number(
          (this.fetcher.stats.attempts / Math.max(1, wallClockMs / 1000)).toFixed(3),
        ),
      },
      storage: { blobBytes: await this.blobs.size(), outDir: this.opts.outDir },
      byDay,
      byRole: collectRoleBytes(records),
      topAssets: this.ledger.topAssets(12).map((a) => ({
        hash: a.hash,
        mime: a.mime,
        bytes: a.bytes,
        refCount: a.ref_count,
        url: a.orig_url,
      })),
      failures: this.failures.slice(0, 50),
      wallClockPerPageMs: records.length > 0 ? Math.round(wallClockMs / records.length) : 0,
      archiveRequestsPerPage:
        records.length > 0 ? Number((this.fetcher.stats.attempts / records.length).toFixed(2)) : 0,
    };

    this.ledger.updateRun(this.runId, {
      status: failed > 0 || this.overBudget || surveyDegraded ? 'partial' : 'ready',
      finishedAt,
      pagesDone: rewriteStats.rewritten,
      pagesTotal: records.length,
      bytesStored: this.bytesStored,
      iaRequests: this.fetcher.stats.attempts,
      iaBytes: this.fetcher.stats.bytes,
      ia429: this.fetcher.stats.throttled,
      dedupeHits: assetStats.unique,
    });
    this.ledger.recordUsage(this.runId, domain, month, 'ia_requests', this.fetcher.stats.attempts);
    this.ledger.recordUsage(this.runId, domain, month, 'stored_bytes', this.bytesStored);

    this.writeManifest(report);
    return report;
  }

  // ------------------------------------------------------------------ survey

  private async survey(range: { from: string; to: string }) {
    const { domain, month, refreshSurvey, budget } = this.opts;
    // One shared deadline across both surveys: --cdx-deadline is a ceiling for the
    // survey *phase*, not a separate allowance for each query. Otherwise two surveys
    // silently cost twice the wall clock the operator asked for.
    const surveyBudget = {
      deadlineMs: budget.cdxDeadlineMs,
      maxRequests: budget.cdxMaxRequests,
      limit: budget.cdxLimit,
    };
    this.log.info('querying the CDX index', {
      deadlineMs: surveyBudget.deadlineMs,
      rowLimitPerQuery: surveyBudget.limit,
    });

    const html = await this.surveyWithProgress(
      htmlSurvey(domain, range.from, range.to, budget.cdxLimit),
      surveyBudget,
      refreshSurvey,
    );

    const remaining = surveyBudget.deadlineMs - html.elapsedMs;
    const assets =
      remaining > 5_000
        ? await this.surveyWithProgress(
            assetSurvey(domain, range.from, range.to, budget.cdxLimit),
            { ...surveyBudget, deadlineMs: remaining },
            refreshSurvey,
          )
        : this.skippedSurvey('asset', 'no survey budget left after the HTML query');

    return { html, assets };
  }

  /** A survey that was never attempted, expressed as a degraded result. */
  private skippedSurvey(label: string, reason: string): SurveyResult {
    this.log.warn(`survey ${label}: skipped`, { reason });
    return {
      rows: [],
      requests: 0,
      fromCache: false,
      degraded: true,
      degradedReason: reason,
      elapsedMs: 0,
    };
  }

  private async surveyWithProgress(
    spec: ReturnType<typeof htmlSurvey>,
    surveyBudget: { deadlineMs: number; maxRequests: number; limit: number },
    refresh: boolean,
  ): Promise<SurveyResult> {
    return this.wayback.survey(spec, this.opts.domain, this.opts.month, surveyBudget, {
      refresh,
      onProgress: ({ label, requests, rows, done, note }) => {
        if (done) {
          this.log.info(`survey ${label}: finished`, { rows, requests, note: note ?? null });
          return;
        }
        this.log.info(`survey ${label}: page of results`, { requests, rows });
      },
    });
  }

  // ------------------------------------------------------------------ frontier

  /**
   * Build a crawl frontier from the seed page's own links when the domain-wide CDX
   * survey is unavailable.
   *
   * Why this exists: a domain+range CDX query routinely 504s (see wayback.ts), which
   * used to leave a mirror containing exactly one page and therefore no navigation at
   * all. But the seed page itself is cheap to fetch, its links are real, and a CDX
   * query for *one exact URL over one day* is vastly cheaper than a domain-wide range
   * scan. So we recover a navigable site from the page we already have.
   *
   * Bounded by `maxFrontierLookups` so a link-heavy homepage cannot turn a "few
   * seconds" ingest into a thousand archive.org queries.
   */
  private async bootstrapFrontier(
    seed: CdxRow,
    day: string,
  ): Promise<{ rows: CdxRow[]; note: string }> {
    const budget = this.opts.budget.maxFrontierLookups;
    const { outcome } = await this.wayback.fetchRaw(
      seed.ts,
      this.opts.seedCanonical,
      this.opts.budget.requestTimeoutMs,
    );
    this.uniqueUrlsFetched += 1;

    if (outcome.kind !== 'ok') {
      const reason = outcome.kind === 'error' ? outcome.message : `HTTP ${outcome.status}`;
      this.log.warn('frontier bootstrap skipped: could not fetch the seed page', { reason });
      return { rows: [seed], note: `seed fetch failed (${reason})` };
    }

    const extracted = extractPage(new TextDecoder('utf-8').decode(outcome.body), this.opts.seedCanonical);
    // Same-page-count ordering as the survey path would apply, but the page's own
    // document order is the best available signal for "what a visitor clicks first".
    const candidates = extracted.internalLinks.slice(0, budget);

    this.log.info('bootstrapping the frontier from the seed page', {
      discovered: extracted.internalLinks.length,
      lookingUp: candidates.length,
      budget,
    });

    const rows: CdxRow[] = [seed];
    let found = 0;
    let failed = 0;
    let lastReason: string | undefined;

    for (const url of candidates) {
      const { row, degradedReason } = await this.wayback.lookupDay(
        url,
        day,
        this.opts.budget.requestTimeoutMs,
      );
      if (row) {
        rows.push(row);
        found += 1;
      } else {
        failed += 1;
        if (degradedReason) lastReason = degradedReason;
      }
    }

    const note =
      `frontier bootstrapped from the seed page: ${found} of ${candidates.length} links had a capture ` +
      `on ${day}${failed > 0 ? `, ${failed} did not` : ''}` +
      (lastReason ? ` (last error: ${lastReason})` : '');

    this.log.info('frontier bootstrap complete', { pages: rows.length, found, failed });

    return { rows, note };
  }

  // ------------------------------------------------------------------ budgets

  private applyBudgets(pages: SelectedPage[]): SelectedPage[] {
    const { maxPages, maxDepth } = this.opts.budget;
    const seed = this.opts.seedCanonical;
    const filtered = pages.filter((page) => {
      if (this.opts.pathFilter && !this.opts.pathFilter.test(page.url)) return false;
      if (page.url === seed) return true;
      return pathDepth(page.url) <= maxDepth;
    });
    return filtered.slice(0, maxPages);
  }

  private indexAssetCaptures(rows: CdxRow[]): Map<string, CdxRow> {
    const grouped = new Map<string, CdxRow[]>();
    for (const row of rows) {
      const canonical = canonicalize(row.url);
      if (!canonical) continue;
      if (!sameSite(canonical, this.opts.seedCanonical)) continue;
      if (!isMirrorableAsset(canonical)) continue;
      let list = grouped.get(canonical);
      if (!list) {
        list = [];
        grouped.set(canonical, list);
      }
      list.push(row);
    }
    const chosen = new Map<string, CdxRow>();
    for (const [url, list] of grouped) {
      const best = pickAssetCapture(list);
      if (best) chosen.set(url, best);
    }
    return chosen;
  }

  private registerPageDay(targets: Map<string, Set<string>>, url: string, day: string): void {
    let days = targets.get(url);
    if (!days) {
      days = new Set();
      targets.set(url, days);
    }
    days.add(day);
  }

  // ------------------------------------------------------- pass 1: fetch raw

  private async fetchPage(
    page: SelectedPage,
    assetCaptures: Map<string, CdxRow>,
  ): Promise<PageRecord | undefined> {
    this.currentDay = page.day;
    const { outcome } = await this.wayback.fetchRaw(page.ts, page.url, this.opts.budget.requestTimeoutMs);
    this.uniqueUrlsFetched += 1;

    if (outcome.kind !== 'ok') {
      const reason =
        outcome.kind === 'error' ? outcome.message : `${outcome.kind} (HTTP ${outcome.status})`;
      this.log.warn('page fetch failed', { day: page.day, url: page.url, reason });
      this.failures.push({ url: `${page.day} ${page.url}`, reason });
      return undefined;
    }
    if (looksLikeWaybackError(outcome.body, outcome.contentType)) {
      this.log.warn('archive.org served an error page with HTTP 200; skipping', { url: page.url });
      this.failures.push({ url: `${page.day} ${page.url}`, reason: 'wayback error page returned as 200' });
      return undefined;
    }

    const html = new TextDecoder('utf-8').decode(outcome.body);
    const extracted = extractPage(html, page.url);

    const assetMap = new Map<string, string>();
    const missingAssets = new Set<string>();
    const roleBytes = new Map<string, { count: number; bytes: number }>();
    let assetsFetched = 0;
    let assetsFailed = 0;
    let skippedByExtension = 0;

    const limited = extracted.assets.slice(0, this.opts.budget.maxAssetsPerPage);
    if (extracted.assets.length > limited.length) {
      this.log.debug('asset cap applied', {
        url: page.url,
        referenced: extracted.assets.length,
        cap: this.opts.budget.maxAssetsPerPage,
      });
    }

    if (this.opts.includeAssets) {
      for (const request of limited) {
        if (this.bytesStored >= this.opts.budget.maxBytes) {
          this.overBudget = true;
          break;
        }
        const result = await this.fetchAsset(request, assetCaptures);
        if (result === 'skipped-extension') {
          skippedByExtension += 1;
          continue;
        }
        if (!result) {
          assetsFailed += 1;
          missingAssets.add(request.url);
          continue;
        }
        assetMap.set(request.url, result.path);
        assetsFetched += 1;
        const entry = roleBytes.get(request.role) ?? { count: 0, bytes: 0 };
        entry.count += 1;
        entry.bytes += result.bytes;
        roleBytes.set(request.role, entry);
        this.ledger.addAssetRef(this.opts.domain, page.day, page.url, result.hash, request.role);
      }
    }

    const rawKey = rawBlobKey(this.opts.domain, page.day, page.url);
    // Originals are immutable for a given capture, but a re-run may legitimately
    // resolve the same route to a different capture, so replace rather than skip.
    const rawPut = await this.blobs.put(rawKey, outcome.body, true);
    if (!rawPut.deduped) this.bytesStored += outcome.body.byteLength;

    const record: PageRecord = {
      page,
      rawKey,
      rawBytes: outcome.body.byteLength,
      assetMap,
      missingAssets,
      assetsReferenced: extracted.assets.length,
      assetsFetched,
      assetsFailed,
      skippedByExtension,
      roleBytes,
    };
    if (outcome.body.byteLength <= IN_MEMORY_RAW_LIMIT) record.rawBody = outcome.body;
    return record;
  }

  /**
   * Fetch one asset into the content-addressed store.
   * Stylesheets are recursed one level so fonts and sprites resolve too.
   */
  private async fetchAsset(
    request: AssetRequest,
    assetCaptures: Map<string, CdxRow>,
    depth = 0,
  ): Promise<AssetRecord | 'skipped-extension' | undefined> {
    if (!isMirrorableAsset(request.url)) return 'skipped-extension';

    const known = this.assetUrlIndex.get(request.url);
    if (known === false) return undefined;
    if (typeof known === 'string') {
      const record = this.assetIndex.get(known);
      if (record) return record;
    }

    const capture = assetCaptures.get(request.url);
    if (!capture) {
      // Not in the surveyed window. When the survey failed outright there is no index
      // at all, so resolve this asset with a cheap exact-URL lookup rather than
      // giving up -- otherwise every image on the page renders as missing.
      const resolved = await this.lookupAssetCapture(request.url);
      if (!resolved) {
        this.assetUrlIndex.set(request.url, false);
        return undefined;
      }
      return this.fetchAssetBytes(request, resolved, assetCaptures, depth);
    }

    return this.fetchAssetBytes(request, capture, assetCaptures, depth);
  }

  /** Resolve one asset URL with a per-URL CDX lookup, cached for the run. */
  private async lookupAssetCapture(url: string): Promise<CdxRow | undefined> {
    const cached = this.assetLookups.get(url);
    if (cached !== undefined) return cached;
    // An asset is not day-scoped, so any day of the target month is a fine hint;
    // in practice archive.org redirects to the nearest capture in the range.
    const { row } = await this.wayback.lookupDay(url, this.currentDay, this.opts.budget.requestTimeoutMs);
    if (row) this.assetsResolvedOnDemand += 1;
    this.assetLookups.set(url, row);
    return row;
  }

  /** Fetch bytes for a known capture into the content-addressed store. */
  private async fetchAssetBytes(
    request: AssetRequest,
    capture: CdxRow,
    assetCaptures: Map<string, CdxRow>,
    depth: number,
  ): Promise<AssetRecord | undefined> {
    const { outcome } = await this.wayback.fetchRaw(
      capture.ts,
      request.url,
      this.opts.budget.requestTimeoutMs,
    );
    this.uniqueUrlsFetched += 1;
    if (outcome.kind !== 'ok') {
      this.assetUrlIndex.set(request.url, false);
      return undefined;
    }

    let bytes = outcome.body;
    const mime = normalizeMime(outcome.contentType, request.url);

    if (request.role === 'stylesheet' || mime === 'text/css') {
      const cssText = new TextDecoder('utf-8').decode(bytes);
      const nested =
        depth < 1
          ? await this.fetchNestedCssAssets(cssText, request.url, assetCaptures)
          : new Map<string, string>();
      bytes = new TextEncoder().encode(rewriteCss(cssText, request.url, nested));
    }

    const hash = sha256Hex(bytes);
    const key = assetBlobKey(hash);
    let record = this.assetIndex.get(hash);
    if (!record) {
      // Insert-if-absent is exactly right here: the key IS the content hash, so an
      // existing key means identical bytes and there is nothing to update.
      const put = await this.blobs.put(key, bytes);
      if (!put.deduped) this.bytesStored += bytes.byteLength;
      record = { hash, path: assetPath(hash), mime, bytes: bytes.byteLength };
      this.assetIndex.set(hash, record);
    }
    this.ledger.upsertAsset({ hash, mime, bytes: bytes.byteLength, r2Key: key, origUrl: request.url });
    this.assetUrlIndex.set(request.url, hash);
    return record;
  }

  /** Fetch url()/@import targets inside a stylesheet (one level). */
  private async fetchNestedCssAssets(
    cssText: string,
    cssUrl: string,
    assetCaptures: Map<string, CdxRow>,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const targets = cssUrls(cssText).slice(0, 40);
    const results = await Promise.all(
      targets.map(async (target) => {
        const canonical = canonicalize(target, cssUrl);
        if (!canonical || !isMirrorableAsset(canonical)) return undefined;
        const isCss = extensionOf(canonical) === 'css';
        const record = await this.fetchAsset(
          { url: canonical, role: isCss ? 'stylesheet' : 'font' },
          assetCaptures,
          1,
        );
        if (!record || record === 'skipped-extension') return undefined;
        return [canonical, record.path] as const;
      }),
    );
    for (const entry of results) if (entry) map.set(entry[0], entry[1]);
    return map;
  }

  // ----------------------------------------------------- pass 2: rewrite once

  private async rewriteAll(
    records: PageRecord[],
    pageDays: Map<string, Set<string>>,
  ): Promise<{
    rewritten: number;
    pageBytes: number;
    withTitle: number;
    deadLinksFound: number;
    stubbedScripts: number;
    keptScripts: number;
    externalLinks: number;
    links: CrawlReport['links'];
  }> {
    const linkLedger = buildLinkLedger(this.linkEdges, pageDays, this.ledger, this.opts.domain);
    this.log.info('link ledger built', linkLedger.stats);

    let rewritten = 0;
    let pageBytes = 0;
    let withTitle = 0;
    let deadLinksFound = 0;
    let stubbedScripts = 0;
    let keptScripts = 0;
    let externalLinks = 0;

    for (const record of records) {
      const raw = record.rawBody ?? (await this.blobs.get(record.rawKey));
      if (!raw) {
        this.log.warn('stored original missing; skipping rewrite', { url: record.page.url });
        this.failures.push({
          url: `${record.page.day} ${record.page.url}`,
          reason: 'stored original missing',
        });
        continue;
      }

      const ctx: RewriteContext = {
        domain: this.opts.domain,
        day: record.page.day,
        pageUrl: record.page.url,
        seedOrigin: `https://${this.opts.domain}`,
        assetMap: record.assetMap,
        linkMap: linkLedger.forPage(record.page.url, record.page.day),
      };
      const result = rewritePage(new TextDecoder('utf-8').decode(raw), ctx);
      const body = new TextEncoder().encode(result.html);

      const blobKey = pageBlobKey(this.opts.domain, record.page.day, record.page.url);
      // Replace: re-rewriting a page (new shim, tighter CSP, better link ledger) yields
      // different bytes at the same key, and silently skipping the write would leave
      // stale HTML on disk while reporting success.
      const put = await this.blobs.put(blobKey, body, true);
      if (!put.deduped) this.bytesStored += body.byteLength;

      const urlHash = createHash('sha1').update(record.page.url).digest('hex').slice(0, 16);
      this.ledger.upsertSnapshot(
        {
          domain: this.opts.domain,
          url: record.page.url,
          day: record.page.day,
          ts: record.page.ts,
          status: 200,
          mime: 'text/html',
          digest: record.page.digest,
          bytes: body.byteLength,
          title: result.title || null,
          depth: pathDepth(record.page.url),
          navScore: 0,
          r2Key: blobKey,
        },
        urlHash,
      );
      for (const extra of record.page.extras) {
        this.ledger.recordExtraCapture(this.opts.domain, record.page.url, record.page.day, extra);
      }
      this.ledger.upsertLinkResolution({
        domain: this.opts.domain,
        day: record.page.day,
        fromUrl: record.page.url,
        toUrl: record.page.url,
        resolvedDay: record.page.day,
        resolvedTs: record.page.ts,
        deltaDays: 0,
        kind: 'self',
      });

      rewritten += 1;
      pageBytes += body.byteLength;
      if (result.title) withTitle += 1;
      deadLinksFound += result.deadLinks.length;
      stubbedScripts += result.stubbedScripts.length;
      keptScripts += result.keptScripts;
      externalLinks += result.externalLinks;

      this.ledger.updateRun(this.runId, {
        pagesDone: rewritten,
        pagesTotal: records.length,
        bytesStored: this.bytesStored,
      });
    }

    return {
      rewritten,
      pageBytes,
      withTitle,
      deadLinksFound,
      stubbedScripts,
      keptScripts,
      externalLinks,
      links: linkLedger.stats,
    };
  }

  // ------------------------------------------------------------------ manifest

  private writeManifest(report: CrawlReport): void {
    const { domain, month } = this.opts;
    const snapshots = this.ledger.allSnapshots(domain);
    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      domain,
      month,
      mode: report.mode,
      anchorDay: report.anchorDay,
      days: report.byDay.map((d) => d.day),
      coverageByDay: report.survey.coverageByDay,
      pages: snapshots.map((row) => ({
        url: row.url,
        day: row.day,
        ts: row.ts,
        title: row.title,
        bytes: row.bytes,
        route: snapshotPath(domain, row.day, row.url),
        blob: row.r2Key,
        extras: this.ledger
          .linkResolutionsFor(domain, row.day)
          .filter((l) => l.to_url === row.url).length,
      })),
      assets: this.ledger.topAssets(2000).map((a) => ({
        hash: a.hash,
        mime: a.mime,
        bytes: a.bytes,
        refs: a.ref_count,
        origUrl: a.orig_url,
      })),
      stats: report,
    };

    const path = `${this.opts.outDir.replace(/\\/g, '/')}/meta/${domain}/${month}/manifest.json`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(manifest, null, 2));
      this.log.info('manifest written', { path, pages: manifest.pages.length });
    } catch (err) {
      this.log.warn('could not write manifest', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Resolve every observed link edge to a stored (day, ts), keyed for per-page lookup. */
export function buildLinkLedger(
  edges: { fromUrl: string; day: string; toUrl: string }[],
  pageDays: Map<string, Set<string>>,
  ledger: Ledger,
  domain: string,
): {
  forPage: (fromUrl: string, day: string) => Map<string, LinkResolutionInfo>;
  stats: CrawlReport['links'];
} {
  const byPage = new Map<string, Map<string, LinkResolutionInfo>>();
  let resolved = 0;
  let unresolved = 0;
  let sameDay = 0;
  let drifted = 0;
  let maxDrift = 0;

  for (const edge of edges) {
    const days = pageDays.get(edge.toUrl);
    const chosen = days && days.size > 0 ? resolveLink(days, edge.day, 31) : undefined;
    const snapshot = chosen ? ledger.snapshotFor(domain, edge.toUrl, chosen.day) : undefined;
    if (!chosen || !snapshot) {
      unresolved += 1;
      continue;
    }
    ledger.upsertLinkResolution({
      domain,
      day: edge.day,
      fromUrl: edge.fromUrl,
      toUrl: edge.toUrl,
      resolvedDay: chosen.day,
      resolvedTs: snapshot.ts,
      deltaDays: chosen.deltaDays,
      kind: 'internal',
    });

    const key = `${edge.fromUrl}\u0000${edge.day}`;
    let map = byPage.get(key);
    if (!map) {
      map = new Map();
      byPage.set(key, map);
    }
    map.set(edge.toUrl, {
      targetUrl: edge.toUrl,
      day: chosen.day,
      deltaDays: chosen.deltaDays,
      ts: snapshot.ts,
    });

    resolved += 1;
    if (chosen.deltaDays === 0) sameDay += 1;
    else {
      drifted += 1;
      maxDrift = Math.max(maxDrift, Math.abs(chosen.deltaDays));
    }
  }

  return {
    forPage: (fromUrl, day) => byPage.get(`${fromUrl}\u0000${day}`) ?? new Map(),
    stats: {
      edges: edges.length,
      resolved,
      unresolved,
      distinctTargets: new Set(edges.map((e) => e.toUrl)).size,
      sameDay,
      drifted,
      maxDriftDays: maxDrift,
    },
  };
}

function collectRoleBytes(records: PageRecord[]): { role: string; count: number; bytes: number }[] {
  const totals = new Map<string, { count: number; bytes: number }>();
  for (const record of records) {
    for (const [role, stat] of record.roleBytes) {
      const entry = totals.get(role) ?? { count: 0, bytes: 0 };
      entry.count += stat.count;
      entry.bytes += stat.bytes;
      totals.set(role, entry);
    }
  }
  return [...totals.entries()].map(([role, v]) => ({ role, ...v })).sort((a, b) => b.bytes - a.bytes);
}

function cdxToCapture(row: CdxRow) {
  return {
    url: row.url,
    ts: row.ts,
    mime: row.mime,
    status: row.status,
    digest: row.digest,
    bytes: row.bytes,
  };
}

function normalizeMime(contentType: string, url: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base && base !== 'application/octet-stream' && base !== 'binary/octet-stream') return base;
  const ext = extensionOf(url);
  const table: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    css: 'text/css',
    js: 'text/javascript',
    mjs: 'text/javascript',
    json: 'application/json',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    otf: 'font/otf',
  };
  return table[ext] ?? (base || 'application/octet-stream');
}

export { tsToDay };
