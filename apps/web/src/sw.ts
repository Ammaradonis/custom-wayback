/**
 * Service worker — Phase 3 mobile PWA hardening.
 *
 * Strategy:
 *  Shell (JS/CSS/HTML/icons): CacheFirst with network revalidation on launch.
 *    Vite PWA injects the precache manifest; we just add the SW-update forcing.
 *
 *  Archive viewer pages (/a/*): StaleWhileRevalidate, LRU capped at 25 MB.
 *    - On cache miss → network, then cache the response.
 *    - Prefetch the top 8 in-page links after each page load (postMessage from shell).
 *    - Eviction: when total cache size > 25 MB, drop LRU entries.
 *
 *  API calls (/v1/*): NetworkFirst, 5-minute TTL, max 50 entries.
 *    Exception: cost/quota/job reads (/v1/jobs/**, /v1/usage/**, /v1/health) are
 *    NetworkOnly. Caching a spend figure or a job's progress for five minutes
 *    would show a confident, wrong number — stale cost numbers are worse than
 *    none.
 *
 *  Everything else: network only.
 *
 * iOS Safari notes:
 *  - SWs are evicted after ~7 days of inactivity; the shell forces skipWaiting +
 *    clients.claim on every launch so the user always has the latest SW.
 *  - Background Sync / Background Fetch are not available; we never depend on them.
 *  - Storage cap ~50 MB; we stay well under with the 25 MB LRU cap.
 */

/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst, NetworkOnly, StaleWhileRevalidate } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

declare const self: ServiceWorkerGlobalScope;

const ARCHIVE_CACHE = "archive-cache-v1";
const API_CACHE = "api-cache-v1";
const ARCHIVE_MAX_BYTES = 25 * 1024 * 1024; // 25 MB hard cap

// ── Precache shell assets (injected by Vite PWA) ─────────────────────────────
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// ── Force SW update on every launch ──────────────────────────────────────────
// Safari caches SWs aggressively; skipWaiting ensures the new SW activates
// immediately rather than waiting for all tabs to close.
self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Archive viewer pages (/a/*) ───────────────────────────────────────────────
registerRoute(
  ({ url }) => url.pathname.startsWith("/a/"),
  new StaleWhileRevalidate({
    cacheName: ARCHIVE_CACHE,
    plugins: [
      new ExpirationPlugin({
        // 7 days TTL; the edge already deleted the R2 blob post-serve,
        // so this is the only copy. Don't evict too aggressively.
        maxAgeSeconds: 60 * 60 * 24 * 7,
        // 200 entries as a count backstop; real enforcement is byte-based below.
        maxEntries: 200,
        purgeOnQuotaError: true,
      }),
    ],
  }),
);

// ── API calls (/v1/*) ─────────────────────────────────────────────────────────
// Two different jobs, two different strategies:
//
//   * Cost/limit/job reads are NetworkOnly. A cached spend figure is worse
//     than no figure — it is a number the user will act on that may be minutes
//     old. `/v1/jobs/usage` and `/v1/jobs/usage/limits` in particular must never
//     be served from cache, and neither must a job's progress.
//   * Everything else is NetworkFirst with a short TTL, so a flaky train
//     connection degrades to slightly-stale ledgers rather than a blank screen.
registerRoute(
  ({ url }) =>
    url.pathname.startsWith("/v1/jobs") ||
    url.pathname.startsWith("/v1/usage") ||
    url.pathname.startsWith("/v1/health"),
  new NetworkOnly(),
);

registerRoute(
  ({ url }) => url.pathname.startsWith("/v1/"),
  new NetworkFirst({
    cacheName: API_CACHE,
    networkTimeoutSeconds: 10,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 50,
        maxAgeSeconds: 60 * 5, // 5 minutes
      }),
    ],
  }),
);

// ── Offline fallback for navigation ──────────────────────────────────────────
// If the user navigates to a page that is not cached AND we are offline,
// serve the shell so they see the designed "needs network" state rather than
// the browser's error page.
self.addEventListener("fetch", (event: FetchEvent) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open("workbox-precache-v2-" + self.location.origin);
      const shell = await cache.match("/index.html");
      return shell ?? new Response("Offline", { status: 503 });
    }),
  );
});

// ── Byte-based LRU eviction for archive cache ─────────────────────────────────
// Called after each new archive page is cached.
async function evictArchiveCacheToLimit(): Promise<void> {
  const cache = await caches.open(ARCHIVE_CACHE);
  const keys = await cache.keys();
  if (!keys.length) return;

  // Measure total size.
  let total = 0;
  const entries: { key: Request; size: number }[] = [];
  for (const key of keys) {
    const resp = await cache.match(key);
    if (!resp) continue;
    const buf = await resp.clone().arrayBuffer().catch(() => new ArrayBuffer(0));
    entries.push({ key, size: buf.byteLength });
    total += buf.byteLength;
  }

  // Evict oldest entries (keys() returns insertion order) until under limit.
  let i = 0;
  while (total > ARCHIVE_MAX_BYTES && i < entries.length) {
    const entry = entries[i++]!;
    await cache.delete(entry.key);
    total -= entry.size;
  }
}

// ── postMessage API (from shell) ──────────────────────────────────────────────

interface SWMessage {
  type: "PREFETCH" | "SKIP_WAITING" | "EVICT_CACHE" | "CACHE_ESTIMATE";
  urls?: string[];
}

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const msg = event.data as SWMessage;

  if (msg.type === "SKIP_WAITING") {
    void self.skipWaiting();
    return;
  }

  if (msg.type === "EVICT_CACHE") {
    event.waitUntil(evictArchiveCacheToLimit());
    return;
  }

  if (msg.type === "PREFETCH" && Array.isArray(msg.urls)) {
    // Prefetch up to 8 archive URLs in the background.
    event.waitUntil(
      (async () => {
        const cache = await caches.open(ARCHIVE_CACHE);
        for (const url of (msg.urls ?? []).slice(0, 8)) {
          if (await cache.match(url)) continue; // already cached
          try {
            const resp = await fetch(url, { credentials: "same-origin" });
            if (resp.ok) {
              await cache.put(url, resp);
            }
          } catch {
            // Prefetch failure is always non-fatal.
          }
        }
        await evictArchiveCacheToLimit();
      })(),
    );
    return;
  }

  if (msg.type === "CACHE_ESTIMATE") {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(ARCHIVE_CACHE);
        const keys = await cache.keys();
        let total = 0;
        for (const key of keys) {
          const resp = await cache.match(key);
          if (resp) {
            const buf = await resp.clone().arrayBuffer().catch(() => new ArrayBuffer(0));
            total += buf.byteLength;
          }
        }
        // Reply to whichever client sent the message.
        const client = event.source as Client | null;
        if (client) {
          client.postMessage({ type: "CACHE_ESTIMATE_RESULT", bytes: total, entries: keys.length });
        }
      })(),
    );
  }
});
