/**
 * Service worker — Phase 3 mobile PWA hardening.
 *
 * Strategy:
 *  Shell (JS/CSS/HTML/icons): CacheFirst with network revalidation on launch.
 *    Vite PWA injects the precache manifest; we just add the SW-update forcing.
 *
 *  Top-level navigations — including viewer URLs (/a/*) — get the precached app shell,
 *    instantly and offline. A reload of a viewer URL is the React viewer, never the
 *    archived page itself.
 *
 *  Archived pages are deliberately NOT cached here. The viewer shows them in a
 *    sandboxed iframe with an opaque origin: a service worker does not control that
 *    frame's requests, and the frame gets no HTTP cache either, so a page this worker
 *    cached or prefetched was never served to it. The edge cache is the one the frame
 *    reads, and the viewer warms that instead (`POST /_cw/warm`). An earlier version
 *    cached `/a/*` here with StaleWhileRevalidate; the only request it could answer
 *    was a top-level reload, and it answered that with archived HTML outside the
 *    viewer. Its cache is deleted on activation.
 *
 *  API calls (/v1/*): NetworkFirst, 5-minute TTL, max 50 entries.
 *    Exception: cost/quota/job reads (/v1/jobs/**, /v1/usage/**, /v1/health) are
 *    NetworkOnly. Caching a spend figure or a job's progress for five minutes
 *    would show a confident, wrong number — stale cost numbers are worse than
 *    none.
 *
 *    Search, compare and export joins them, for the same reason in a different
 *    currency: a cached search result is a claim about what the archive contains,
 *    a cached comparison is a claim about what changed, and a cached export row is
 *    a claim about whether a bundle is finished and complete. All three can become
 *    false the moment a crawl, a reindex or a purge lands, and a wrong answer about
 *    the *contents* of the archive is worse than no answer at all.
 *
 *  Everything else: network only.
 *
 * iOS Safari notes:
 *  - SWs are evicted after ~7 days of inactivity; the shell forces skipWaiting +
 *    clients.claim on every launch so the user always has the latest SW.
 *  - Background Sync / Background Fetch are not available; we never depend on them.
 */

/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst, NetworkOnly } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

declare const self: ServiceWorkerGlobalScope;

/** The archived-page cache earlier versions kept; removed on activation. */
const LEGACY_ARCHIVE_CACHE = "archive-cache-v1";
const API_CACHE = "api-cache-v1";

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
  event.waitUntil(
    Promise.all([self.clients.claim(), caches.delete(LEGACY_ARCHIVE_CACHE).catch(() => false)]),
  );
});

// ── Top-level navigations → the app shell ────────────────────────────────────
// Only `destination === "document"`: the viewer's iframe navigation (`iframe`) must
// reach the Worker, which serves the archived page — which is why this is not
// Workbox's `NavigationRoute`, whose match is every navigation, frames included.
// Paths the Worker answers itself (the API, share-link redirects, archive resources)
// are left to the network.
const appShell = createHandlerBoundToURL("/index.html");
registerRoute(
  ({ request, url }) =>
    request.mode === "navigate" &&
    request.destination === "document" &&
    !/^\/(?:v1|s|_cw|assets)\//.test(url.pathname),
  appShell,
);

// ── API calls (/v1/*) ─────────────────────────────────────────────────────────
// Two different jobs, two different strategies:
//
//   * Cost/limit/job reads are NetworkOnly. A cached spend figure is worse
//     than no figure — it is a number the user will act on that may be minutes
//     old. `/v1/jobs/usage` and `/v1/jobs/usage/limits` in particular must never
//     be served from cache, and neither must a job's progress.
//   * Search, compare and export are NetworkOnly for the same shape of reason:
//     they describe the *contents* of the archive, and a crawl, a reindex or a
//     purge invalidates that description without notice. A stale "no results" or
//     "ready, complete bundle" would be believed.
//   * Everything else is NetworkFirst with a short TTL, so a flaky train
//     connection degrades to slightly-stale ledgers rather than a blank screen.
registerRoute(
  ({ url }) =>
    url.pathname.startsWith("/v1/jobs") ||
    url.pathname.startsWith("/v1/usage") ||
    url.pathname.startsWith("/v1/health") ||
    url.pathname.startsWith("/v1/search") ||
    url.pathname.startsWith("/v1/compare") ||
    url.pathname.startsWith("/v1/export"),
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

// ── postMessage API (from shell) ──────────────────────────────────────────────

interface SWMessage {
  type: "SKIP_WAITING" | "CACHE_ESTIMATE";
}

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const msg = event.data as SWMessage;

  if (msg.type === "SKIP_WAITING") {
    void self.skipWaiting();
    return;
  }

  if (msg.type === "CACHE_ESTIMATE") {
    // The device holds no archived pages any more (see the header), so the honest
    // figure is what remains of the legacy cache until activation removes it.
    event.waitUntil(
      (async () => {
        let total = 0;
        let entries = 0;
        if (await caches.has(LEGACY_ARCHIVE_CACHE)) {
          const cache = await caches.open(LEGACY_ARCHIVE_CACHE);
          const keys = await cache.keys();
          entries = keys.length;
          for (const key of keys) {
            const resp = await cache.match(key);
            if (resp) total += (await resp.clone().arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength;
          }
        }
        const client = event.source as Client | null;
        if (client) client.postMessage({ type: "CACHE_ESTIMATE_RESULT", bytes: total, entries });
      })(),
    );
  }
});
