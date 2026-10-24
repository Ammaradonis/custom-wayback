/**
 * Configuration and CLI parsing.
 *
 * The budget caps here are not suggestions: they are the mechanism that keeps the
 * "pre-load takes seconds" promise and the bill bounded. Every one of them is
 * surfaced in the crawl report so a run can always be explained after the fact.
 *
 * `cdxDeadlineMs` and `cdxMaxRequests` exist because of a measured reality (see
 * README.md "archive.org behaviour"): under current load, expensive CDX queries do
 * not fail fast, they hang until the server returns a 504. A survey must therefore
 * have a hard wall-clock and request ceiling, and degrade to a smaller survey or an
 * on-demand fetch rather than stalling the whole ingest.
 *
 * The runtime-agnostic helpers that were in this file -- `parseMonth` and
 * `registrableDomain` -- now live in `@custom-wayback/pipeline` so the Worker ingest
 * path can use them, and are re-exported below. Everything else here is CLI plumbing
 * (`process.cwd()`, argv, usage text) and stays local on purpose.
 */

import { parseMonth as parseMonthRange, registrableDomain } from '@custom-wayback/pipeline';

export interface Budget {
  /** Hard cap on distinct page-loads (URL x day) ingested. */
  maxPages: number;
  /** Link-follow depth from the seed URL. */
  maxDepth: number;
  /** Hard cap on assets fetched for a single page. */
  maxAssetsPerPage: number;
  /** Hard cap on total bytes written to the blob store, pre-optimization. */
  maxBytes: number;
  /** Parallel in-flight requests to archive.org. */
  concurrency: number;
  /** Minimum spacing between two requests to the same host, in ms. */
  minDelayMs: number;
  /** Consecutive 429/503 responses before the circuit breaker trips. */
  breakerThreshold: number;
  /** How long the breaker stays open, in ms. */
  breakerCooldownMs: number;
  /** Total attempts per URL before giving up. */
  maxAttempts: number;
  /** Per-request timeout, in ms. */
  requestTimeoutMs: number;
  /** Wall-clock ceiling for the whole CDX survey phase, in ms. */
  cdxDeadlineMs: number;
  /** Maximum CDX HTTP requests allowed during the survey phase. */
  cdxMaxRequests: number;
  /** Row cap for a single CDX query (the server stops scanning at this point). */
  cdxLimit: number;
  /**
   * When the domain-wide CDX survey fails (common: those queries routinely 504),
   * the crawler bootstraps from the seed page's own links instead, resolving each
   * one with a cheap per-URL CDX query. This caps how many of those it will spend.
   */
  maxFrontierLookups: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxPages: 250,
  maxDepth: 3,
  maxAssetsPerPage: 120,
  maxBytes: 750 * 1024 * 1024,
  concurrency: 4,
  minDelayMs: 1000,
  breakerThreshold: 5,
  breakerCooldownMs: 60_000,
  maxAttempts: 3,
  requestTimeoutMs: 20_000,
  cdxDeadlineMs: 90_000,
  cdxMaxRequests: 12,
  cdxLimit: 2000,
  maxFrontierLookups: 60,
};

export interface CrawlOptions {
  domain: string;
  month: string; // YYYY-MM
  /** Page selection strategy, see selection.ts (packages/pipeline). */
  mode: 'perday' | 'anchor';
  outDir: string;
  dbPath: string;
  /** The seed URL as given (informational; used in logs and origin checks). */
  seedUrl?: string;
  /** Canonical form of the seed URL. Always present: it is the fallback seed. */
  seedCanonical: string;
  userAgent: string;
  contact: string;
  includeAssets: boolean;
  /** Regex allowlist applied to page URLs; when set, only matches are ingested. */
  pathFilter?: RegExp;
  budget: Budget;
  refreshSurvey: boolean;
}

export class UsageError extends Error {}

export function printUsage(): void {
  process.stdout.write(
    [
      'custom-wayback local crawler (Phase 1: local ingestion)',
      '',
      'Usage:',
      '  npm run crawl -- --domain=<domain> --month=YYYY-MM [options]',
      '  npm run serve [--port=8787]',
      '  npm run stats [--domain=<domain>]',
      '  npm run login -- --api=<app url> [--email=<email>]',
      '  npm run publish -- --domain=<domain> --month=YYYY-MM',
      '',
      'Required:',
      '  --domain=<domain>        e.g. samsung.com, apple.com (registrable domain)',
      '  --month=YYYY-MM          e.g. 2024-03',
      '',
      'Options:',
      '  --mode=perday|anchor     perday (default): one best capture per day per URL,',
      '                           so the day scrubber works.',
      '                           anchor: pin every URL to the single best-captured day',
      '                           of the month, for one coherent site view.',
      '  --seed=<url>             override the seed page (default: https://<domain>/)',
      '  --max-pages=<n>          crawl budget (default 250)',
      '  --max-depth=<n>          link-follow depth (default 3)',
      '  --max-assets=<n>         assets stored per page (default 120)',
      '  --max-bytes=<mb>         total byte budget (default 750)',
      '  --min-delay-ms=<n>       per-host spacing (default 1000; do not go below 250)',
      '  --request-timeout=<ms>   per-request timeout (default 20000)',
      '  --cdx-deadline=<ms>      wall-clock ceiling for the CDX survey (default 90000)',
      '  --cdx-max-requests=<n>   CDX request ceiling for the survey (default 12)',
      '  --cdx-limit=<n>          row cap per CDX query (default 2000)',
      '  --frontier-lookups=<n>   per-URL CDX lookups when the domain survey fails (default 60)',
      '  --path-filter=<regex>    only ingest page URLs matching this regex',
      '  --no-assets              HTML only (skip images/CSS/JS/fonts)',
      '  --refresh                ignore the cached CDX survey and re-query',
      '  --out=<dir>              blob store root (default ./data)',
      '  --db=<path>              ledger path (default ./data/ledger.db)',
      '  --contact=<string>       contact string for the User-Agent (etiquette)',
      '  --verbose                debug logging',
      '',
      'Publishing (pre-crawled pages for a deployed viewer, served from its R2):',
      '  --publish                after the crawl, publish the month (sign in first)',
      '  --api=<url>              the deployed app, e.g. https://custom-wayback-api.example.workers.dev',
      '  --token=<token>          a session token instead of the saved sign-in (or CW_TOKEN)',
      '',
      'Serve options:',
      '  --port=<n>               viewer port (default 8787)',
      '',
      'Etiquette: this crawler stays at or above --min-delay-ms between requests to',
      'archive.org, sends an honest User-Agent with contact info, backs off on 429/503,',
      'and stops the survey at --cdx-deadline instead of retrying into a wall.',
      '',
    ].join('\n'),
  );
}

function argValue(argv: string[], name: string): string | undefined {
  const prefixed = argv.find((a) => a.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1]!.startsWith('--')) return argv[idx + 1];
  return undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function numArg(argv: string[], name: string, fallback: number): number {
  const raw = argValue(argv, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`--${name} must be a positive number (got "${raw}")`);
  }
  return parsed;
}

/**
 * Canonical form of the seed URL, guaranteed to be a usable absolute http(s) URL.
 * Falls back to `https://<domain>/` if the supplied seed cannot be parsed, so callers
 * never have to handle a missing seed (it is the fallback when CDX will not answer).
 */
export function canonicalSeed(seedUrl: string | undefined, domain: string): string {
  const fallback = `https://${domain}/`;
  if (!seedUrl) return fallback;
  try {
    const parsed = new URL(seedUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

// Re-exported from the pipeline package so './config.ts' stays a working import site.
export { registrableDomain };

/**
 * `parseMonth` is the pipeline's, wrapped only so an invalid month still throws this
 * package's `UsageError`: cli.ts matches on that type to print usage and exit 2. The
 * message text is the pipeline's, unchanged.
 */
export function parseMonth(month: string): { from: string; to: string; firstDay: string; lastDay: string } {
  try {
    return parseMonthRange(month);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

export function parseCrawlOptions(argv: string[], cwd = process.cwd()): CrawlOptions {
  const domainRaw = argValue(argv, 'domain');
  if (!domainRaw) throw new UsageError('--domain is required');
  const monthRaw = argValue(argv, 'month');
  if (!monthRaw) throw new UsageError('--month is required');
  parseMonth(monthRaw); // validate early

  const domain = registrableDomain(
    domainRaw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim(),
  );
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new UsageError(`could not read a domain out of "${domainRaw}"`);
  }

  const mode = (argValue(argv, 'mode') ?? 'perday') as CrawlOptions['mode'];
  if (mode !== 'perday' && mode !== 'anchor') {
    throw new UsageError(`--mode must be perday or anchor (got "${mode}")`);
  }

  const minDelayMs = numArg(argv, 'min-delay-ms', DEFAULT_BUDGET.minDelayMs);
  if (minDelayMs < 250) {
    throw new UsageError(
      '--min-delay-ms below 250 is refused: this tool will not hammer the Internet Archive.',
    );
  }

  const pathFilterRaw = argValue(argv, 'path-filter');
  const contact = argValue(argv, 'contact') ?? 'local-phase1';
  const seedUrl = argValue(argv, 'seed') ?? `https://${domain}/`;

  return {
    domain,
    month: monthRaw,
    mode,
    outDir: argValue(argv, 'out') ?? `${cwd}/data`,
    dbPath: argValue(argv, 'db') ?? `${cwd}/data/ledger.db`,
    seedUrl,
    // The seed is always usable in canonical form; callers must never have to handle
    // a missing one, because it is the fallback when the CDX index will not cooperate.
    seedCanonical: canonicalSeed(seedUrl, domain),
    userAgent: `CustomWaybackFastBot/0.1 (local Phase 1; +contact: ${contact})`,
    contact,
    includeAssets: !hasFlag(argv, 'no-assets'),
    pathFilter: pathFilterRaw ? new RegExp(pathFilterRaw) : undefined,
    refreshSurvey: hasFlag(argv, 'refresh'),
    budget: {
      ...DEFAULT_BUDGET,
      maxPages: numArg(argv, 'max-pages', DEFAULT_BUDGET.maxPages),
      maxDepth: numArg(argv, 'max-depth', DEFAULT_BUDGET.maxDepth),
      maxAssetsPerPage: numArg(argv, 'max-assets', DEFAULT_BUDGET.maxAssetsPerPage),
      maxBytes: numArg(argv, 'max-bytes', DEFAULT_BUDGET.maxBytes / (1024 * 1024)) * 1024 * 1024,
      concurrency: numArg(argv, 'concurrency', DEFAULT_BUDGET.concurrency),
      minDelayMs,
      requestTimeoutMs: numArg(argv, 'request-timeout', DEFAULT_BUDGET.requestTimeoutMs),
      cdxDeadlineMs: numArg(argv, 'cdx-deadline', DEFAULT_BUDGET.cdxDeadlineMs),
      cdxMaxRequests: numArg(argv, 'cdx-max-requests', DEFAULT_BUDGET.cdxMaxRequests),
      cdxLimit: numArg(argv, 'cdx-limit', DEFAULT_BUDGET.cdxLimit),
      maxFrontierLookups: numArg(argv, 'frontier-lookups', DEFAULT_BUDGET.maxFrontierLookups),
    },
  };
}
