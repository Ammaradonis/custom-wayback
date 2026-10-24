/**
 * What the viewer does when archive.org rate-limits it.
 *
 * archive.org answers many of the Worker's requests with HTTP 429 at busy times, while a
 * reader's own connection is served normally. A page the Worker could not fetch for that
 * reason comes back as a throttle failure (`throttledPage` in apps/api/src/routes/viewer.ts),
 * and only then does any of this apply — every other page loads in the viewer as usual.
 *
 * Two fallbacks, tried in this order, each one a reader's setting:
 *
 *   1. **A stored copy from the nearest day** — a page pre-crawled through the reader's own
 *      connection (`crawl-local publish`) or kept by a crawl. It is served from R2 with
 *      every viewer feature; only the day differs, and the viewer says so.
 *   2. **archive.org's own replay** — the page loaded straight from web.archive.org in the
 *      reader's browser. It appears, but archive.org sees the reader's IP address, and the
 *      viewer's navigation, prefetching and edge caching do not work on it.
 *
 * Kept per browser: the trade-off in (2) is the reader's own address, on this device.
 */

import { useCallback, useEffect, useState } from "react";

export interface FallbackPrefs {
  /** Open the nearest day whose copy of the page is stored, instead of failing. */
  storedCopy: boolean;
  /** Load archive.org's own replay of the page, instead of failing. */
  replay: boolean;
}

export const DEFAULT_FALLBACKS: FallbackPrefs = { storedCopy: true, replay: true };

const STORAGE_KEY = "cw_fallbacks_v1";

export function loadFallbacks(): FallbackPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FALLBACKS;
    const saved = JSON.parse(raw) as Partial<FallbackPrefs>;
    return {
      storedCopy: typeof saved.storedCopy === "boolean" ? saved.storedCopy : DEFAULT_FALLBACKS.storedCopy,
      replay: typeof saved.replay === "boolean" ? saved.replay : DEFAULT_FALLBACKS.replay,
    };
  } catch {
    // Storage blocked (private window, site data cleared): the defaults apply.
    return DEFAULT_FALLBACKS;
  }
}

function saveFallbacks(prefs: FallbackPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not persisted; the choice still holds for this page view.
  }
}

/** The reader's fallbacks, saved as they change and kept in step across tabs. */
export function useFallbackPrefs(): [FallbackPrefs, (next: FallbackPrefs) => void] {
  const [prefs, setPrefs] = useState<FallbackPrefs>(loadFallbacks);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setPrefs(loadFallbacks());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const update = useCallback((next: FallbackPrefs) => {
    setPrefs(next);
    saveFallbacks(next);
  }, []);
  return [prefs, update];
}

/** What the Worker reports about a page archive.org throttled (`cw:failure` detail). */
export interface ThrottleDetail {
  /** The original URL and capture timestamp, for archive.org's replay. */
  url: string;
  ts: string;
  /** The nearest other day whose copy of this page is stored, if any. */
  nearestStoredDay: string | null;
  /** That copy was pre-crawled (published by the local crawler). */
  nearestStoredPrecrawled: boolean;
}

/** The detail of a throttle failure, or null for any other failure. */
export function throttleDetail(detail: unknown): ThrottleDetail | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as {
    reason?: unknown;
    url?: unknown;
    ts?: unknown;
    nearestStoredDay?: unknown;
    nearestStoredPrecrawled?: unknown;
  };
  if (d.reason !== "archive-throttled" || typeof d.url !== "string" || typeof d.ts !== "string") return null;
  if (!/^https?:\/\//i.test(d.url) || !/^\d{14}$/.test(d.ts)) return null;
  const day = typeof d.nearestStoredDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.nearestStoredDay) ? d.nearestStoredDay : null;
  return { url: d.url, ts: d.ts, nearestStoredDay: day, nearestStoredPrecrawled: d.nearestStoredPrecrawled === true };
}

/** archive.org's replay of a capture, without its toolbar (`if_`): what fallback 2 loads. */
export function replayUrl(ts: string, url: string): string {
  return `https://web.archive.org/web/${ts}if_/${url}`;
}

/**
 * The replay frame's sandbox. `allow-same-origin` is safe here, unlike for the viewer's
 * own frame on this origin: the replay's origin is web.archive.org, never this app's,
 * and archive.org's replay needs its own origin to run. No `allow-forms` — a form in a
 * replayed page posts to archive.org, which cannot do anything useful with it — and no
 * top navigation, so a page that tries to break out of frames stays put.
 */
export const REPLAY_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** The same viewer route on another day: `/a/example.com/2024-03-15/x` → `…/2024-03-10/x`. */
export function routeOnDay(route: string, day: string): string {
  return route.replace(/^(\/a\/[^/]+\/)\d{4}-\d{2}-\d{2}/, `$1${day}`);
}
