/**
 * Page selection and link resolution — the "one clean snapshot per day" policy.
 *
 * Two selection modes:
 *
 *  perday (default)  For every URL, pick the best capture of each day it was
 *                    captured on. This is what makes the day scrubber real: you get
 *                    one clean version per day instead of every capture.
 *
 *  anchor            Pick the single best-captured day of the month, then pin the whole
 *                    site to it. Produces the most coherent single view ("samsung.com
 *                    as it was on March 14") at the cost of falling back to nearby days
 *                    for thinly-captured pages.
 *
 * "Best capture" is a deterministic policy:
 *   1. status 200 only
 *   2. more bytes wins (truncated captures are short)
 *   3. earlier timestamp wins (the state of the site at the start of the day)
 * Tie-breaking is total, so re-running a crawl reproduces the same choices.
 */

import { canonicalize, daysBetween, pathDepth, hashString } from './urlutil.js';
import type { CdxRow } from './wayback.js';

export interface SelectedPage {
  url: string;
  ts: string;
  day: string;
  mime: string;
  bytes: number;
  digest: string | null;
  /** Other genuinely distinct captures of this URL on this day (for the UI counter). */
  extras: string[];
}

export interface SelectionResult {
  pages: SelectedPage[];
  anchorDay: string;
  anchorCoverage: number;
  distinctUrls: number;
  capturesConsidered: number;
  capturesDiscarded: number;
  coverageByDay: Record<string, number>;
}

/** Paths that are technically HTML but are not pages a human navigates to. */
const NON_PAGE_PATHS: RegExp[] = [
  /^\/robots\.txt$/i,
  /^\/sitemap[^/]*\.xml/i,
  /^\/manifest\.json$/i,
  /^\/browserconfig\.xml$/i,
  /^\/favicon\.ico$/i,
  /\/wp-json\//i,
  /\/feed\/?$/i,
  /\.(xml|json|txt|rss|atom)$/i,
];

export function isNavigablePage(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return !NON_PAGE_PATHS.some((re) => re.test(url.pathname));
  } catch {
    return false;
  }
}

/** Lower is better: shallow, few-query pages make better entry points. */
function entryCost(urlStr: string): number {
  try {
    const url = new URL(urlStr);
    const depth = pathDepth(urlStr);
    const queryCost = url.search ? 1 : 0;
    const longPath = url.pathname.length > 90 ? 1 : 0;
    const looksLikeId = /\/\d{5,}(\/|$)/.test(url.pathname) ? 1 : 0;
    return depth * 10 + queryCost * 5 + longPath * 3 + looksLikeId * 4;
  } catch {
    return 999;
  }
}

/**
 * Pick one capture per (url, day) according to the policy, then order pages
 * best-first so a budgeted crawl spends its pages on pages people actually visit.
 */
export function selectPages(rows: CdxRow[], mode: 'perday' | 'anchor', seedUrl: string): SelectionResult {
  const capturesConsidered = rows.length;

  const byUrl = new Map<string, CdxRow[]>();
  for (const row of rows) {
    if (row.status !== 200) continue;
    const canonical = canonicalize(row.url);
    if (!canonical) continue;
    if (!isNavigablePage(canonical)) continue;
    let list = byUrl.get(canonical);
    if (!list) {
      list = [];
      byUrl.set(canonical, list);
    }
    list.push(row);
  }

  const coverageByDay: Record<string, number> = {};
  for (const list of byUrl.values()) {
    for (const day of new Set(list.map((r) => r.day))) {
      coverageByDay[day] = (coverageByDay[day] ?? 0) + 1;
    }
  }

  let anchorDay = '';
  let anchorCoverage = 0;
  for (const [day, count] of Object.entries(coverageByDay)) {
    if (count > anchorCoverage || (count === anchorCoverage && day < anchorDay)) {
      anchorDay = day;
      anchorCoverage = count;
    }
  }

  const pages: SelectedPage[] = [];

  for (const [url, list] of byUrl) {
    if (mode === 'anchor') {
      const best = pickBestNear(list, anchorDay);
      if (!best) continue;
      pages.push(toSelected(url, best, []));
      continue;
    }

    const byDay = new Map<string, CdxRow[]>();
    for (const row of list) {
      const bucket = byDay.get(row.day);
      if (bucket) bucket.push(row);
      else byDay.set(row.day, [row]);
    }
    for (const [day, dayRows] of byDay) {
      const sorted = sortCaptures(dayRows);
      const chosen = sorted[0]!;
      // Captures within a minute of the chosen one are the same page state; keep only
      // genuinely distinct captures as "extras" for the UI's capture counter.
      //
      // Two traps here, both hit during development:
      //  1. Timestamps must be compared as real times. Subtracting HHMMSS as a decimal
      //     ("180000" - "90000" = 90000) is not a number of seconds.
      //  2. The chosen capture is the *largest*, not the earliest, so same-day captures
      //     can legitimately fall either side of it. Compare absolute distance.
      const chosenSeconds = hhmmssToSeconds(chosen.ts);
      const extras = sorted
        .slice(1)
        .filter((r) => Math.abs(hhmmssToSeconds(r.ts) - chosenSeconds) > 60)
        .map((r) => r.ts);
      pages.push(toSelected(url, chosen, extras));
    }
  }

  const seedCanonical = canonicalize(seedUrl);
  pages.sort((a, b) => {
    if (a.url === seedCanonical) return -1;
    if (b.url === seedCanonical) return 1;
    const cost = entryCost(a.url) - entryCost(b.url);
    if (cost !== 0) return cost;
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return a.url < b.url ? -1 : 1;
  });

  return {
    pages,
    anchorDay,
    anchorCoverage,
    distinctUrls: byUrl.size,
    capturesConsidered,
    capturesDiscarded: Math.max(0, capturesConsidered - pages.length),
    coverageByDay,
  };
}

function sortCaptures(rows: CdxRow[]): CdxRow[] {
  return [...rows].sort((a, b) => {
    if (b.bytes !== a.bytes) return b.bytes - a.bytes; // larger = more complete
    return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; // earlier = start of day state
  });
}

/** Seconds since midnight for a 14-digit wayback timestamp. */
function hhmmssToSeconds(ts: string): number {
  const hh = Number(ts.slice(8, 10));
  const mm = Number(ts.slice(10, 12));
  const ss = Number(ts.slice(12, 14));
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return 0;
  return hh * 3600 + mm * 60 + ss;
}

/** Best 200 capture closest to `day`, searching outward within a bounded window. */
function pickBestNear(rows: CdxRow[], day: string, maxDeltaDays = 45): CdxRow | undefined {
  return rows
    .filter((r) => Math.abs(daysBetween(day, r.day)) <= maxDeltaDays)
    .sort((a, b) => {
      const da = Math.abs(daysBetween(day, a.day));
      const db = Math.abs(daysBetween(day, b.day));
      if (da !== db) return da - db;
      if (b.bytes !== a.bytes) return b.bytes - a.bytes;
      return a.ts < b.ts ? -1 : 1;
    })[0];
}

function toSelected(url: string, row: CdxRow, extras: string[]): SelectedPage {
  return { url, ts: row.ts, day: row.day, mime: row.mime, bytes: row.bytes, digest: row.digest, extras };
}

/**
 * Choose the single best capture of one asset URL. Assets are not day-scoped:
 * one good copy serves every day, which is where the byte savings come from.
 */
export function pickAssetCapture(rows: CdxRow[]): CdxRow | undefined {
  const ok = rows.filter((r) => r.status === 200);
  if (ok.length === 0) return undefined;
  return ok.sort((a, b) => {
    if (b.bytes !== a.bytes) return b.bytes - a.bytes;
    return a.ts < b.ts ? -1 : 1;
  })[0];
}

/**
 * Resolve an internal link to the day that actually has the page.
 * Returns the nearest stored day within `toleranceDays`, else undefined.
 */
export function resolveLink(
  targetDays: Set<string>,
  fromDay: string,
  toleranceDays = 31,
): { day: string; deltaDays: number } | undefined {
  if (targetDays.has(fromDay)) return { day: fromDay, deltaDays: 0 };
  let best: { day: string; deltaDays: number } | undefined;
  for (const day of targetDays) {
    const delta = daysBetween(fromDay, day);
    if (Math.abs(delta) > toleranceDays) continue;
    if (
      !best ||
      Math.abs(delta) < Math.abs(best.deltaDays) ||
      (Math.abs(delta) === Math.abs(best.deltaDays) && delta < best.deltaDays)
    ) {
      best = { day, deltaDays: delta };
    }
  }
  return best;
}

/** Stable id for a page route, used in filenames and the manifest. */
export function pageId(url: string): string {
  return hashString(url);
}
