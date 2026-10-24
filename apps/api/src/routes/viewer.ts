/**
 * Viewer Worker route: /a/:domain/:day/*
 *
 * One URL, three kinds of request — told apart by `Sec-Fetch-Dest`, which every engine
 * this app supports sends (Chrome 80+, Safari 16.4+, Firefox 90+):
 *
 *   1. **A top-level navigation** (`document`) gets the app shell. The same URL is the
 *      React viewer route, so a reload, a shared link or "open in new tab" must land in
 *      the viewer, not on the archived bytes outside it (see `appShell`).
 *   2. **A subresource** (`image`, `script`, `style`, …) gets the archived resource. Those
 *      are URLs a page's own JavaScript resolved against the snapshot `<base>`.
 *   3. **Everything else** — the viewer's iframe — gets the archived page, through the fast
 *      plane: Workers Cache → D1 ledger → R2 → archive.org `id_`.
 *
 * ## Why the rendered page is cached at the edge
 *
 * An archived capture never changes, so the rewritten page for a route is a pure function
 * of (route, runtime version, origin). Serving it from the Workers Cache makes a repeat
 * visit an edge hit with no D1 query and no archive.org request — plan.md §2.2's
 * "< 150 ms warm" — and it is what §12 rule 1 asks for: one `id_` fetch per URL per day,
 * ever, instead of one per view. The cache key carries a hash of the injected runtime, so
 * a deploy that changes the rewrite never serves a page made by the previous one.
 *
 * After serving from R2, records served_at in D1 so the purge job can delete the blob.
 */

import { Hono } from "hono";
import {
  AVAILABILITY_ENDPOINT,
  HEAD_CONTRACT,
  SNAPSHOT_CSP,
  formNeutralisation,
  hashString,
  headInjection,
  isForeignBase,
  isNavigablePage,
  isStrippedMeta,
  canonicalize,
  sameSite,
  snapshotPath,
  scriptDisposition,
  shouldStubScript,
  snapshotCsp,
  snapshotCspForOrigin,
  metaTagsHtml,
  RUNTIME_CSS,
  RUNTIME_SCRIPT,
  RUNTIME_SCRIPT_ID,
  RUNTIME_STYLE_ID,
  stubScriptHtml,
} from "@custom-wayback/pipeline";
import type { Env } from "../env.js";
import { serveCachedPage, markServed, mutableCopy } from "../lib/r2.js";
import { WAYBACK_RAW_BASE } from "@custom-wayback/shared";

/** The slice of `ExecutionContext` the viewer needs; tests pass a stub. */
interface Deferrer {
  waitUntil(promise: Promise<unknown>): void;
}

export const viewerRouter = new Hono<{ Bindings: Env }>();

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The sandbox the viewer's iframe applies (`ViewerPage.tsx`), restated as a CSP directive
 * on every archived document. Inside the iframe it changes nothing — the flags are the
 * same — but it travels with the response, so the archived page is confined to an opaque
 * origin even when something loads it outside the iframe. A meta-delivered policy cannot
 * carry `sandbox`, which is why this is header-only.
 *
 * `allow-popups-to-escape-sandbox` lets an external link (rewritten to open in a new tab)
 * open the live site as a normal page instead of a sandboxed one with no storage.
 */
const SANDBOX_DIRECTIVE = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

/**
 * On the frame origin the archived document keeps a real origin. That is what lets
 * modern pages work as they did — cookies, storage, the about:blank frames they build
 * for themselves, and a browser cache shared between pages — and it is safe there
 * because that origin is not the app's: nothing of the app lives on it (plan.md §10).
 */
const FRAME_SANDBOX_DIRECTIVE = `${SANDBOX_DIRECTIVE} allow-same-origin`;

function snapshotCspHeader(origin: string | undefined, frameRole: boolean): string {
  return `${origin ? snapshotCspForOrigin(origin) : snapshotCsp()}; ${frameRole ? FRAME_SANDBOX_DIRECTIVE : SANDBOX_DIRECTIVE}`;
}

/** The app origin, when this deployment is the archive-only frame origin; null otherwise. */
export function frameAppOrigin(env: Env): string | null {
  if (env.ROLE !== "frame") return null;
  try {
    const origin = new URL(env.APP_ORIGIN ?? "").origin;
    return origin.startsWith("http") ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Request destinations that mean "a page's code asked for an asset". Workers are left
 * out: an opaque-origin document cannot construct one from any URL.
 */
export const ARCHIVE_SUBRESOURCE_DESTINATIONS: ReadonlySet<string> = new Set([
  "image",
  "style",
  "script",
  "font",
  "audio",
  "video",
  "track",
  "embed",
  "object",
  "manifest",
  "xslt",
]);

function viewerFailure(status: number, title: string, message: string): Response {
  const escapeHtml = (value: string) =>
    value.replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return entities[character] ?? character;
    });
  const detail = JSON.stringify({ status, message }).replace(/</g, "\\u003c");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main><script>var detail=${detail};function reportFailure(){window.parent.postMessage({__cw:true,type:'cw:failure',detail:detail},'*')}window.addEventListener('message',function(event){if(event.data&&event.data.__cw===true&&event.data.type==='cw:request-failure')reportFailure()});reportFailure()</script></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ── Small pure helpers ───────────────────────────────────────────────────────

/** An http(s) URL without credentials, normalised, or null. */
function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The archive timestamp to ask for when only the day is known: its midpoint, so the
 * archive's "nearest capture" prefers a capture *on* that day over one late the day
 * before or early the day after.
 */
export function dayTimestamp(day: string): string {
  return `${day.replace(/-/g, "")}120000`;
}

/** Decode the viewer's `%3F<encoded-query>` suffix back into an original URL. */
export function urlForSnapshotRoute(domain: string, path: string, protocol = "https:"): string {
  let pathname = path || "/";
  let search = "";
  const queryMarker = pathname.toLowerCase().indexOf("%3f");
  if (queryMarker >= 0) {
    const encodedQuery = pathname.slice(queryMarker + 3);
    pathname = pathname.slice(0, queryMarker) || "/";
    try {
      search = decodeURIComponent(encodedQuery);
    } catch {
      search = encodedQuery;
    }
  }

  const url = new URL(`${protocol}//${domain}`);
  url.pathname = pathname;
  url.search = search ? `?${search}` : "";
  return url.href;
}

/** `/a/<domain>/<day>/<path>` split into its parts, or null. */
function parseSnapshotRoute(route: string): { domain: string; day: string; path: string } | null {
  const match = /^\/a\/([^/?#]+)\/(\d{4}-\d{2}-\d{2})(\/[^?#]*)?$/.exec(route);
  if (!match) return null;
  return { domain: match[1]!, day: match[2]!, path: match[3] || "/" };
}

// ── The resource URL scheme ──────────────────────────────────────────────────

/**
 * The same-origin URL an archived resource is served from:
 *
 *     /_cw/r/<ts>/<scheme>/<host><path>?<query>
 *
 * ## Why it is path-shaped
 *
 * It used to be `/_cw/resource?ts=…&url=…`, which carries the original URL but not its
 * *shape*. A browser resolves a relative URL against the URL it fetched the file from, so
 * everything a script or stylesheet resolved relative to itself landed on `/_cw/`:
 * webpack's `publicPath: 'auto'` (derived from `document.currentScript.src`), every
 * native `import './chunk.js'`, a stylesheet's own relative `url()`. On a modern site
 * that is the code-split bundle that renders the page, so the page arrived as bare
 * server HTML that never hydrated.
 *
 * Mirroring the original directory structure under the prefix makes relative resolution
 * correct by construction: `./chunk.js` next to `/_cw/r/T/https/www.apple.com/v/main.js`
 * is `/_cw/r/T/https/www.apple.com/v/chunk.js`, which is exactly the archived
 * `https://www.apple.com/v/chunk.js`. Scheme and host are separate segments — never
 * `https://` inside a path — so nothing between the browser and the Worker can collapse a
 * double slash.
 *
 * The query-string form is still served, for pages cached before this change.
 */
export const RESOURCE_PREFIX = "/_cw/r/";

export function resourcePath(ts: string, target: URL): string {
  return `${RESOURCE_PREFIX}${ts}/${target.protocol.slice(0, -1)}/${target.host}${target.pathname}${target.search}`;
}

/** Inverse of `resourcePath`. `pathname` is as received, so still percent-encoded. */
export function parseResourcePath(pathname: string, search: string): { ts: string; url: string } | null {
  const match = /^\/_cw\/r\/(\d{14})\/(https?)\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const url = safeHttpUrl(`${match[2]}://${match[3]}${match[4] ?? "/"}${search}`);
  return url ? { ts: match[1]!, url } : null;
}

/**
 * A root-relative URL that escaped every rewrite, recognised by who asked for it.
 *
 * `img.src = "/images/hero.jpg"` inside an archived page resolves against *our* origin,
 * so the request arrives here as `/images/hero.jpg`. What makes it recoverable is the
 * `Referer`: the archived page or stylesheet that issued it, whose route says which site
 * and which day the path belongs to. The runtime rewrites most of these before they are
 * requested; this is the net under it, for code paths no hook can see.
 *
 * `Sec-Fetch-Site` keeps the app's own requests out: the shell is same-origin, while an
 * archived page runs in an opaque origin and so never is. On the frame origin the reverse
 * holds — only archived pages run there — so the caller says so.
 */
export function leakedArchiveResource(
  request: Request,
  options: { sameOriginIsArchive?: boolean } = {},
): { ts: string; url: string; destination: string } | null {
  const destination = request.headers.get("Sec-Fetch-Dest") ?? "";
  if (!ARCHIVE_SUBRESOURCE_DESTINATIONS.has(destination)) return null;
  // On the frame origin nothing *but* archived pages runs, and they are same-origin.
  const site = request.headers.get("Sec-Fetch-Site") ?? "same-origin";
  if (site === "same-origin" && !options.sameOriginIsArchive) return null;

  let from: URL;
  let target: URL;
  try {
    from = new URL(request.headers.get("Referer") ?? "");
    target = new URL(request.url);
  } catch {
    return null;
  }
  if (from.origin !== target.origin) return null;

  let base: string | null = null;
  let ts = "";
  const page = /^\/a\/([^/]+)\/(\d{4}-\d{2}-\d{2})(\/.*)?$/.exec(from.pathname);
  if (page) {
    base = urlForSnapshotRoute(page[1]!, page[3] ?? "/");
    ts = dayTimestamp(page[2]!);
  } else if (from.pathname.startsWith(RESOURCE_PREFIX)) {
    const parsed = parseResourcePath(from.pathname, from.search);
    if (parsed) ({ url: base, ts } = parsed);
  } else if (from.pathname === "/_cw/resource") {
    base = safeHttpUrl(from.searchParams.get("url"));
    ts = from.searchParams.get("ts") ?? "";
  }
  if (!base || !/^\d{14}$/.test(ts)) return null;

  const url = safeHttpUrl(new URL(`${target.pathname}${target.search}`, base).href);
  return url ? { ts, url, destination } : null;
}

// ── The edge page cache ──────────────────────────────────────────────────────

/** Changes whenever the injected runtime, the policy or the rewrite contract does. */
const PAGE_CACHE_VERSION = hashString(`${RUNTIME_SCRIPT}${RUNTIME_CSS}${SNAPSHOT_CSP}${SANDBOX_DIRECTIVE}|rewrite-4`);
const PAGE_CACHE_SECONDS = 60 * 60 * 24 * 7;

/**
 * Set by a producer whose response is a deterministic rendition of an archived capture,
 * and removed before the response leaves the Worker. Failures and ledger-driven
 * fallback redirects never carry it: those depend on state that a crawl changes.
 */
const EDGE_STORE_HEADER = "X-CW-Edge-Store";

function pageCacheKey(origin: string, domain: string, day: string, path: string): string {
  return `https://cache.internal/page/${PAGE_CACHE_VERSION}/${encodeURIComponent(origin)}/${domain}/${day}${path}`;
}

async function matchEdge(key: string): Promise<Response | undefined> {
  try {
    return await caches.default.match(key);
  } catch {
    // The cache is an optimisation; a failure is a miss.
    return undefined;
  }
}

/** The copy that goes into the cache: everything the page needs, cacheable for a week. */
function forEdge(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete(EDGE_STORE_HEADER);
  headers.set("Cache-Control", `public, max-age=${PAGE_CACHE_SECONDS}`);
  return new Response(response.body, { status: response.status, headers });
}

/** Serve a response and, when it is a capture rendition, store it at the edge as it streams. */
function storeAtEdge(ctx: Deferrer, key: string, response: Response): Response {
  if (response.headers.get(EDGE_STORE_HEADER) !== "1") return response;
  response.headers.delete(EDGE_STORE_HEADER);
  response.headers.set("X-Custom-Wayback-Cache", "miss");
  ctx.waitUntil(caches.default.put(key, forEdge(response.clone())).catch(() => undefined));
  return response;
}

// ── archive.org throttling ───────────────────────────────────────────────────

/**
 * archive.org rate-limits by address, and a Worker's requests leave from addresses its
 * data centre shares with every other Worker there: in production most requests to it can
 * come back 429 for minutes at a time. A visit still asks — the reader is waiting for that
 * page, and some requests get through — but prefetching stands down in this data centre
 * for `THROTTLE_SECONDS` after any 429, because speculative requests into a throttle only
 * prolong it (plan.md §12).
 */
const THROTTLED_HEADER = "X-Custom-Wayback-Archive";
const THROTTLE_KEY = "https://cache.internal/_cw/archive-throttled";
const THROTTLE_SECONDS = 120;

/** Tag a failure as archive.org's 429, so a prefetch can tell it from a broken page. */
function throttled(response: Response): Response {
  response.headers.set(THROTTLED_HEADER, "throttled");
  return response;
}

function noteThrottle(ctx: Deferrer | undefined): void {
  const marker = new Response("1", { headers: { "Cache-Control": `public, max-age=${THROTTLE_SECONDS}` } });
  const write = caches.default.put(THROTTLE_KEY, marker).catch(() => undefined);
  ctx?.waitUntil(write);
}

async function archiveThrottled(): Promise<boolean> {
  return (await matchEdge(THROTTLE_KEY)) !== undefined;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * The app shell, for a top-level navigation to a viewer URL.
 *
 * Without this, reloading the viewer — or opening a shared link, or a link in a new tab —
 * showed the archived page *outside* the viewer: no toolbar, links that did nothing (the
 * runtime hands every click to a parent frame that is not there), and an archived page
 * running in the app's own origin, next to the app's stored session.
 */
async function appShell(env: Env, request: Request): Promise<Response> {
  const shell = await env.ASSETS.fetch(new Request(new URL("/", request.url), { headers: request.headers }));
  return mutableCopy(shell);
}

viewerRouter.get("/:domain/:day/*", async (c) => {
  const { domain, day } = c.req.param();
  if (!DAY_PATTERN.test(day)) {
    return viewerFailure(404, "Not a snapshot address", "Viewer addresses look like /a/<domain>/<YYYY-MM-DD>/<path>.");
  }

  // Hono 4 does not expose the wildcard segment via `c.req.param("*")` — it returns
  // undefined, making every lookup produce `"/undefined"`. Derive the path from the raw
  // request URL instead, after the `/<domain>/<day>` part of the route.
  const requestUrl = new URL(c.req.url);
  const marker = `/${domain}/${day}`;
  const at = requestUrl.pathname.indexOf(marker);
  const path = at >= 0 ? requestUrl.pathname.slice(at + marker.length) || "/" : "/";

  const destination = c.req.header("Sec-Fetch-Dest") ?? "";
  if (destination === "document") {
    // The viewer lives on the app origin; a frame-origin URL opened on its own goes there.
    const appOrigin = frameAppOrigin(c.env);
    if (appOrigin) return redirectTo(`${appOrigin}${requestUrl.pathname}`);
    if (c.env.ASSETS) return appShell(c.env, c.req.raw);
  }

  // A relative URL a page's script built against the snapshot `<base>`: an asset, not a
  // page. Browsers that send no `Sec-Fetch-Dest` are recognised by the path instead.
  const original = urlForSnapshotRoute(domain, path);
  if (ARCHIVE_SUBRESOURCE_DESTINATIONS.has(destination) || (!destination && !isNavigablePage(original))) {
    return fetchOnDemandResource(dayTimestamp(day), original, c.env, c.executionCtx, destination);
  }

  return serveSnapshotPage(c.env, c.executionCtx, domain, day, path, requestUrl.origin);
});

async function serveSnapshotPage(
  env: Env,
  ctx: Deferrer,
  domain: string,
  day: string,
  path: string,
  origin: string,
): Promise<Response> {
  const key = pageCacheKey(origin, domain, day, path);
  const cached = await matchEdge(key);
  if (cached) {
    const hit = mutableCopy(cached);
    hit.headers.set("Cache-Control", "no-store");
    hit.headers.set("X-Custom-Wayback-Cache", "hit");
    return hit;
  }
  return storeAtEdge(ctx, key, await renderSnapshotPage(env, ctx, domain, day, path, origin));
}

// ── Serve archived page ───────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  r2_key: string | null;
  url: string | null;
  ts: string;
  resolved_day: string | null;
  delta_days: number | null;
  purged_at: number | null;
  served_at: number | null;
}

/**
 * The ledger row for one route on one day, or null.
 *
 * ## Why this matches `page_id` and not `url LIKE '%…'`
 *
 * It used to be `WHERE domain = ? AND day = ? AND url LIKE ?` with `%\${path}`. That
 * has two defects, and both were live:
 *
 *   1. **It matches the wrong row.** `LIKE '%/about'` matches
 *      `https://example.com/team/about` as readily as `https://example.com/about`, so a
 *      request could be answered with a different page's bytes under the requested
 *      URL.
 *   2. **It cannot find the right row when the path is `/`.** `LIKE '%/'` only matches
 *      URLs that *end* in a slash, which is fine for a homepage and useless for
 *      everything else, so a request for a page stored without a trailing slash
 *      missing its own row and fell through to the 404.
 *
 * `page_id` is the route the ingest wrote for exactly this purpose (`pageIdFor` in
 * `queue/ingest.ts`): the path plus the percent-encoded query. Matching it is an
 * equality on the same key the URL uses, which is both correct and cheap.
 *
 * `url LIKE` survives only as the fallback for rows written before `page_id` was
 * populated, and the `mime` ordering keeps a legacy asset row (an image stored as a
 * page by an older crawl) from shadowing a real HTML capture on the same route.
 */
async function findSnapshot(
  env: Env,
  domain: string,
  day: string,
  pageId: string,
): Promise<SnapshotRow | null> {
  const byRoute = await env.DB.prepare(
    `SELECT id, r2_key, url, ts, resolved_day, delta_days, purged_at, served_at
     FROM snapshots
     WHERE domain = ? AND day = ? AND page_id = ?
     ORDER BY (mime LIKE 'text/html%') DESC, ts ASC
     LIMIT 1`,
  )
    .bind(domain, day, pageId)
    .first<SnapshotRow>();
  if (byRoute) return byRoute;

  // Legacy rows: `page_id` was added by a later migration, so an older crawl's rows
  // have it NULL and are only addressable by URL.
  return env.DB.prepare(
    `SELECT id, r2_key, url, ts, resolved_day, delta_days, purged_at, served_at
     FROM snapshots
     WHERE domain = ? AND day = ? AND page_id IS NULL AND url LIKE ?
     ORDER BY (mime LIKE 'text/html%') DESC, ts ASC
     LIMIT 1`,
  )
    .bind(domain, day, `%${pageId}`)
    .first<SnapshotRow>();
}

/** The closest day to `day` that has a capture of `pageId`, within `windowDays`. */
async function nearestDay(
  env: Env,
  domain: string,
  day: string,
  pageId: string,
  windowDays = 62,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT day
     FROM snapshots
     WHERE domain = ? AND page_id = ?
       AND ABS(julianday(day) - julianday(?)) <= ?
       AND mime LIKE 'text/html%'
     ORDER BY ABS(julianday(day) - julianday(?)) ASC, day ASC
     LIMIT 1`,
  )
    .bind(domain, pageId, day, windowDays, day)
    .first<{ day: string }>();
  return row?.day ?? null;
}

/**
 * The closest day that has *any* HTML capture, used when the requested day has none.
 *
 * Deliberately looser than `nearestDay`: that one needs a capture of a specific route,
 * and a day whose only HTML page is, say, the homepage under a query string has no
 * `page_id = '/'` to match. This asks the weaker question — "is there anything to show
 * near here?" — which is the one that stops a date picker from dead-ending on a day
 * between two captures.
 */
async function nearestHtmlDay(
  env: Env,
  domain: string,
  day: string,
  windowDays = 62,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT day
     FROM snapshots
     WHERE domain = ? AND mime LIKE 'text/html%'
       AND ABS(julianday(day) - julianday(?)) <= ?
     ORDER BY ABS(julianday(day) - julianday(?)) ASC, day ASC
     LIMIT 1`,
  )
    .bind(domain, day, windowDays, day)
    .first<{ day: string }>();
  return row?.day && row.day !== day ? row.day : null;
}

/**
 * The shallowest HTML capture of `day` that is a real route, or null.
 *
 * `isNavigablePage` and not just the SQL filter: rows written by the old crawler carry
 * `mime = 'text/html'` even when the URL is `…/arrows.png`, because the insert hard-coded
 * that value. Redirecting to one of those would serve an image as a document. The URL is
 * the reliable signal.
 */
async function shallowestHtmlPage(env: Env, domain: string, day: string): Promise<string | null> {
  const rows = await env.DB.prepare(
    `SELECT page_id FROM snapshots
     WHERE domain = ? AND day = ? AND mime LIKE 'text/html%' AND page_id IS NOT NULL
     ORDER BY LENGTH(page_id) ASC, ts ASC
     LIMIT 10`,
  )
    .bind(domain, day)
    .all<{ page_id: string }>();

  const found = (rows.results ?? []).find((row) =>
    isNavigablePage(`https://${domain}${row.page_id}`),
  );
  return found?.page_id ?? null;
}

/**
 * Produce the page for one route, without the edge cache in front of it.
 *
 * `warming` is set when the request is a prefetch rather than a visit: it must not mark
 * a stored page as served, or the purge job would delete a blob nobody has looked at.
 */
async function renderSnapshotPage(
  env: Env,
  ctx: Deferrer,
  domain: string,
  day: string,
  path: string,
  origin: string,
  warming = false,
  critical?: CriticalResource[],
): Promise<Response> {
  // 1. Look up the snapshot ledger for this exact route.
  const snap = await findSnapshot(env, domain, day, path);

  // 1b. A missing ledger row is a *cache miss*, not a dead end.
  //
  // Nothing about reading a page ever required a crawl: archive.org serves the raw bytes
  // of any capture, and this route knows how to rewrite and serve them. Requiring a
  // ledger row first meant the app could show *nothing* until a crawl had succeeded —
  // and the crawl is precisely the part archive.org throttles. The crawl is an
  // optimisation — warm pages from R2, cold ones from the archive — not a gate.
  let archiveTrouble: CaptureOutcome | null = null;
  if (!snap) {
    const capture = await locateCapture(env, {
      domain,
      day,
      path,
      ts: dayTimestamp(day),
      useKv: true,
      defer: (promise) => ctx.waitUntil(promise),
    });
    if (capture.kind === "page") {
      return renderCapture(capture, { domain, day, origin, frameRole: frameAppOrigin(env) !== null, critical });
    }
    if (capture.kind === "redirect") return captureRedirect(capture.route);
    if (capture.kind === "error") archiveTrouble = capture;
  }

  // 2. Never a dead end (plan.md §2.3). Before answering 404, look for something
  //    honest to show instead of nothing:
  //
  //      a. the same day's *homepage*, when a deeper page is missing;
  //      b. the nearest day that captured this page at all;
  //      c. the nearest day that captured the homepage.
  //
  //    Each is a redirect, so the toolbar and URL bar end up describing what is
  //    actually on screen.
  if (!snap) {
    if (path !== "/") {
      const rootToday = await findSnapshot(env, domain, day, "/");
      if (rootToday) return redirectTo(`/a/${domain}/${day}/`);
    }

    const otherDay = path === "/" ? null : await nearestDay(env, domain, day, path);
    if (otherDay) return redirectTo(`/a/${domain}/${otherDay}${path}`);

    const rootElsewhere = await nearestDay(env, domain, day, "/");
    if (rootElsewhere && rootElsewhere !== day) {
      return redirectTo(`/a/${domain}/${rootElsewhere}/`);
    }

    // Nothing matched the requested route. Before giving up, open the shallowest HTML
    // page that *does* exist — this day first, then the nearest day that has one.
    //
    // This is what makes a month browsable at all when a site's homepage is captured
    // under an unexpected route. In the live archive the only HTML capture of
    // university.com's day was `https://www.university.com/?a=ctjzgrgkbb`, whose route
    // is `/%3Fa=ctjzgrgkbb`; no request for `/` will ever ask for it, so without this
    // the ledger holds a real page and the browser shows 404.
    for (const candidateDay of [day, await nearestHtmlDay(env, domain, day)]) {
      if (!candidateDay) continue;
      const pageId = await shallowestHtmlPage(env, domain, candidateDay);
      if (!pageId) continue;
      return redirectTo(`/a/${domain}/${candidateDay}${pageId}`);
    }

    // The link-resolution ledger carries the nearest capture the *crawl* recorded,
    // which covers links that were resolved at ingest time but never stored as a
    // snapshot of their own.
    if (env.SNAPSHOT_BEHAVIOR === "nearest") {
      const nearest = await env.DB.prepare(
        `SELECT resolved_day FROM link_resolutions
         WHERE domain = ? AND to_url LIKE ? AND resolved_day IS NOT NULL
         ORDER BY ABS(delta_days) ASC LIMIT 1`,
      )
        .bind(domain, `%${path}`)
        .first<{ resolved_day: string }>();
      if (nearest) {
        return redirectTo(`/a/${domain}/${nearest.resolved_day}${path}`);
      }
    }

    // An archive that was down or throttling is not "nothing was captured": say which.
    if (archiveTrouble?.kind === "error") {
      if (archiveTrouble.status !== 429) {
        return viewerFailure(
          502,
          "The archive could not serve this page",
          `archive.org answered HTTP ${archiveTrouble.status}. Reload to try again.`,
        );
      }
      noteThrottle(ctx);
      return throttled(
        viewerFailure(
          502,
          "The archive could not serve this page",
          "archive.org is rate-limiting requests right now. Wait a minute, then reload.",
        ),
      );
    }

    // The one honest 404 left. It says what was asked for and what to do next rather
    // than leaving a bare wall (§2.3 "errors are designed").
    return viewerFailure(
      404,
      "No archived page was found",
      `No capture of https://${domain}${path} on ${day} was found, and this month has no HTML capture to fall back to. Start or re-run the crawl for this month.`,
    );
  }

  // 3. If content already purged, do an on-demand id_ fetch.
  const onDemand = {
    resolvedDay: snap.resolved_day,
    deltaDays: snap.delta_days,
    sourceUrl: snap.url ?? undefined,
    resourceOrigin: origin,
    critical,
  };
  if (snap.purged_at !== null || !snap.r2_key) {
    return fetchOnDemand(domain, day, path, snap.ts, env, onDemand);
  }

  // 4. Try Workers Cache API → R2.
  const cacheKey = `https://cache.internal/a/${domain}/${day}${path}`;
  const response = await serveCachedPage(snap.r2_key, cacheKey, env, ctx as unknown as ExecutionContext);
  if (response) {
    // Record served_at (fire-and-forget) so purge job can act.
    if (!warming) ctx.waitUntil(markServed(env, snap.id));
    // `serveCachedPage` guarantees a response we own, so both of these are safe
    // even when the bytes came straight out of the CDN cache. Attaching the §10
    // policy here matters: without it the R2 path served archived pages with no
    // content policy at all, while the on-demand path had one — the same URL
    // getting a different security posture depending on which path served it.
    const page = prepareCachedSnapshot(
      response,
      snap.ts,
      domain,
      day,
      snap.url ?? `https://${domain}${path}`,
      snap.resolved_day,
      snap.delta_days,
    );
    page.headers.set("Content-Security-Policy", snapshotCspHeader(origin, frameAppOrigin(env) !== null));
    page.headers.set(EDGE_STORE_HEADER, "1");
    injectToolbarHeaders(page, snap.resolved_day, snap.delta_days);
    return page;
  }

  // 5. Full cache miss — on-demand fetch.
  return fetchOnDemand(domain, day, path, snap.ts, env, onDemand);
}

/** Refresh embedded runtime/CSP metadata on cached HTML so existing R2 captures get current replay fixes. */
function prepareCachedSnapshot(
  response: Response,
  ts: string,
  domain: string,
  day: string,
  url: string,
  resolvedDay?: string | null,
  deltaDays?: number | null,
): Response {
  if (!(response.headers.get("Content-Type") ?? "").toLowerCase().startsWith("text/html")) return response;

  const mirrorContent = JSON.stringify({
    day,
    url,
    ts,
    source: "r2",
    resolvedDay: resolvedDay ?? day,
    deltaDays: deltaDays ?? 0,
    resourceProxy: true,
  });
  const runtimeMarkup = `<style id="${RUNTIME_STYLE_ID}">${RUNTIME_CSS}</style><script id="${RUNTIME_SCRIPT_ID}">${RUNTIME_SCRIPT}</script>`;
  let headSeen = false;
  const rewritten = new HTMLRewriter()
    .on("head", {
      element(el) {
        if (headSeen) return;
        headSeen = true;
        el.prepend(`${metaTagsHtml({ "cw-mirror": mirrorContent })}${runtimeMarkup}`, { html: true });
      },
    })
    .on(`script#${RUNTIME_SCRIPT_ID}`, { element(el) { el.remove(); } })
    .on(`style#${RUNTIME_STYLE_ID}`, {
      element(el) { el.remove(); },
    })
    .on("a[data-cw-dead]", {
      element(el) {
        const href = el.getAttribute("data-cw-dead");
        if (!href) return;
        const canonical = canonicalize(href);
        if (!canonical || !sameSite(canonical, url)) return;
        el.setAttribute("href", snapshotPath(domain, day, canonical));
        el.removeAttribute("data-cw-dead");
        const classes = (el.getAttribute("class") ?? "")
          .split(/\s+/)
          .filter((name) => name && name !== "cw-dead-link");
        if (classes.length) el.setAttribute("class", classes.join(" "));
        else el.removeAttribute("class");
        if (el.getAttribute("title") === "not captured in the archived range") el.removeAttribute("title");
      },
    })
    .on("meta", {
      element(el) {
        const equiv = (el.getAttribute("http-equiv") ?? "").trim().toLowerCase();
        if (equiv === "content-security-policy" || equiv === "content-security-policy-report-only") {
          el.remove();
          return;
        }
        if ((el.getAttribute("name") ?? "").trim().toLowerCase() === "cw-mirror") el.remove();
      },
    })
    .transform(response);
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.set("Cache-Control", "no-store");
  return new Response(rewritten.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── Finding the capture ──────────────────────────────────────────────────────

type CaptureOutcome =
  | { kind: "page"; response: Response; ts: string; url: string }
  | { kind: "redirect"; route: string }
  | { kind: "missing"; status: number }
  | { kind: "error"; status: number };

interface LocateOptions {
  domain: string;
  day: string;
  path: string;
  /** A 14-digit timestamp: exact from the ledger, or the day's midpoint. */
  ts: string;
  /** The capture's original URL, when the ledger knows it. */
  sourceUrl?: string | undefined;
  /** Consult and fill the KV resolution cache (only when `ts` is a guess). */
  useKv: boolean;
  /** Where to park the KV write so it does not delay the page. */
  defer?: (promise: Promise<unknown>) => void;
}

/** What the KV cache remembers about a route on a day. */
type Resolution = { ts: string; url: string } | { route: string } | "missing";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_ARCHIVE_HOPS = 6;

/**
 * Host (without `www.`), port, path and query: what makes two URLs the same document
 * as far as the archive is concerned. Its index folds scheme and `www.` together, and
 * so does this.
 */
function documentKey(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.host.toLowerCase().replace(/^www\./, "")}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * Parse an archive redirect's target into the capture it names.
 *
 * `new URL()` puts the original URL's `?query` into the archive URL's search, so it is
 * put back. Anything that leaves web.archive.org is refused: the Worker never follows a
 * redirect to the live web.
 */
function archiveLocation(location: string | null, current: string): { ts: string; url: string } | null {
  if (!location) return null;
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return null;
  }
  if (next.protocol !== "https:" || next.hostname !== "web.archive.org") return null;
  const match = /^\/web\/(\d{14})[a-z_]*\/(.+)$/i.exec(next.pathname);
  if (!match) return null;
  const raw = /^https?:/i.test(match[2]!) ? match[2]! : `http://${match[2]!}`;
  const url = safeHttpUrl(`${raw}${next.search}`);
  return url ? { ts: match[1]!, url } : null;
}

/** The viewer route for a same-site page URL, or null for anything else. */
function sameSiteRoute(domain: string, day: string, url: string): string | null {
  const canonical = canonicalize(url);
  if (!canonical || !sameSite(canonical, `https://${domain}/`) || !isNavigablePage(canonical)) return null;
  return snapshotPath(domain, day, canonical);
}

async function readResolution(env: Env, key: string): Promise<Resolution | null> {
  try {
    const raw = await env.COVERAGE_KV.get(key, "text");
    if (!raw) return null;
    if (raw === "-") return "missing";
    const parsed = JSON.parse(raw) as { ts?: string; url?: string; route?: string };
    if (typeof parsed.route === "string" && parsed.route.startsWith("/a/")) return { route: parsed.route };
    const url = safeHttpUrl(parsed.url);
    if (url && /^\d{14}$/.test(parsed.ts ?? "")) return { ts: parsed.ts!, url };
  } catch {
    // KV is a cache; a miss or an error both mean "ask archive.org".
  }
  return null;
}

function rememberResolution(env: Env, key: string, value: Resolution, defer?: LocateOptions["defer"]): Promise<void> {
  const write = (async () => {
    try {
      await env.COVERAGE_KV.put(key, value === "missing" ? "-" : JSON.stringify(value), {
        // A miss is re-checked daily, so a capture the archive adds later appears.
        expirationTtl: value === "missing" ? 60 * 60 * 24 : 60 * 60 * 24 * 30,
      });
    } catch {
      // Losing the entry only costs the archive round trips again next time.
    }
  })();
  if (defer) {
    defer(write);
    return Promise.resolve();
  }
  return write;
}

/**
 * Find the capture to show for a route, following the archive's redirects ourselves.
 *
 * ## Why the redirects are followed by hand
 *
 * `id_` replay answers with two kinds of redirect, and they mean different things:
 *
 *   - **the archive's own** — "the nearest capture of this URL is at another timestamp",
 *     or the same page filed under `www.` or `http:`. Same document; follow it.
 *   - **the site's own** — the capture *is* a redirect: samsung.com's homepage was
 *     captured as a 301 to `/us/`. A different document; the viewer must move to that
 *     route, or every relative link on the page resolves against the wrong directory.
 *
 * `fetch()`'s automatic following erased that distinction and served `/us/` under the
 * `/` route. The availability API, used before this, has the opposite problem: it skips
 * redirect captures entirely and returns the nearest *200* — for samsung.com in March 2024
 * that was a capture from July 2025, of an ISP block page. Asking `id_` directly is also one
 * round trip cheaper, and resolves `bare ↔ www` aliases the archive's index already folds.
 *
 * Availability survives as the fallback for a 4xx: no capture under this URL at all, or
 * a nearest capture that is itself an archived error page.
 */
export async function locateCapture(env: Env, options: LocateOptions): Promise<CaptureOutcome> {
  const { domain, day, path, useKv, defer } = options;
  const requestedRoute = `/a/${domain}/${day}${path}`;
  const kvKey = `capture:v3:${domain}${path}:${day}`;
  let url = safeHttpUrl(options.sourceUrl) ?? urlForSnapshotRoute(domain, path);
  let ts = options.ts;

  if (useKv) {
    const remembered = await readResolution(env, kvKey);
    if (remembered === "missing") return { kind: "missing", status: 404 };
    if (remembered && "route" in remembered) return { kind: "redirect", route: remembered.route };
    if (remembered) ({ ts, url } = remembered);
  }

  let triedAvailability = false;
  for (let hop = 0; hop < MAX_ARCHIVE_HOPS; hop++) {
    const archiveUrl = `${WAYBACK_RAW_BASE}/${ts}id_/${url}`;
    let response: Response;
    try {
      response = await fetch(archiveUrl, {
        headers: { "User-Agent": env.CRAWLER_USER_AGENT },
        redirect: "manual",
      });
    } catch {
      return { kind: "error", status: 502 };
    }

    if (response.ok) {
      if (useKv) await rememberResolution(env, kvKey, { ts, url }, defer);
      return { kind: "page", response, ts, url };
    }
    await response.body?.cancel();

    if (REDIRECT_STATUSES.has(response.status)) {
      const next = archiveLocation(response.headers.get("Location"), archiveUrl);
      if (!next) return { kind: "error", status: 502 };
      if (documentKey(next.url) !== documentKey(url)) {
        const route = sameSiteRoute(domain, day, next.url);
        if (route && route !== requestedRoute) {
          if (useKv) await rememberResolution(env, kvKey, { route }, defer);
          return { kind: "redirect", route };
        }
      }
      ({ ts, url } = next);
      continue;
    }

    if (response.status === 429 || response.status >= 500) return { kind: "error", status: response.status };

    if (!triedAvailability) {
      triedAvailability = true;
      const alternative = await probeAvailability(env, domain, path, day);
      if (alternative && !(alternative.ts === ts && alternative.url === url)) {
        ({ ts, url } = alternative);
        continue;
      }
    }
    if (useKv) await rememberResolution(env, kvKey, "missing", defer);
    return { kind: "missing", status: response.status };
  }
  return { kind: "error", status: 508 };
}

/**
 * The nearest *200* capture across host and scheme aliases, from the availability API.
 *
 * All four aliases are asked at once and an HTTPS answer is preferred, so a miss on the
 * HTTPS forms costs the slowest probe instead of every probe in sequence. The exact URL
 * that answered travels with the timestamp, or the viewer could replay a different
 * host's page.
 */
async function probeAvailability(
  env: Env,
  domain: string,
  path: string,
  day: string,
): Promise<{ ts: string; url: string } | null> {
  const stamp = day.replace(/-/g, "");
  const primary = domain.replace(/^www\./i, "");
  const hosts = domain.toLowerCase().startsWith("www.") ? [domain, primary] : [domain, `www.${domain}`];

  const probe = async (target: string): Promise<{ ts: string; url: string } | null> => {
    try {
      const res = await fetch(`${AVAILABILITY_ENDPOINT}?url=${encodeURIComponent(target)}&timestamp=${stamp}`, {
        headers: { "User-Agent": env.CRAWLER_USER_AGENT },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        archived_snapshots?: { closest?: { available?: boolean; timestamp?: string; status?: string } };
      };
      const closest = body.archived_snapshots?.closest;
      // A capture of an error page is not a page worth serving.
      if (closest?.available && closest.status === "200" && /^\d{14}$/.test(closest.timestamp ?? "")) {
        return { ts: closest.timestamp!, url: target };
      }
    } catch {
      // A network blip must not become a 404; the other aliases still answer.
    }
    return null;
  };

  const firstHit = (targets: string[]) =>
    Promise.all(targets.map(probe)).then((results) => results.find(Boolean) ?? null);
  const https = firstHit([...new Set(hosts.map((host) => urlForSnapshotRoute(host, path)))]);
  const http = firstHit([...new Set(hosts.map((host) => urlForSnapshotRoute(host, path, "http:")))]);
  return (await https) ?? (await http);
}

/**
 * A redirect within the viewer. Built by hand rather than with `Response.redirect()`,
 * whose headers are immutable: `secureHeaders` decorates every response in place, and
 * an immutable header list turns that into a 500.
 */
function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

/** The viewer moving to the route of a redirect the site itself made when captured. */
function captureRedirect(route: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: route, "Cache-Control": "no-store", [EDGE_STORE_HEADER]: "1" },
  });
}

// ── On-demand id_ fetch ───────────────────────────────────────────────────────

export interface OnDemandOptions {
  resolvedDay?: string | null | undefined;
  deltaDays?: number | null | undefined;
  /** The capture's original URL from the ledger; the route's host and path otherwise. */
  sourceUrl?: string | undefined;
  /** The viewer's origin, which the CSP allows for mirrored resources. */
  resourceOrigin?: string | undefined;
  /** Filled with the page's render-blocking resources, for warming. */
  critical?: CriticalResource[] | undefined;
}

/**
 * Reconstruct one page from archive.org's raw `id_` bytes.
 *
 * ## Why this path exists at all
 *
 * plan.md §3.1 says "nothing is rewritten at read time … reads are byte serving".
 * The post-serve purge job (`lib/r2.ts purgeStaleCachedPages`, runbook §5) deletes the
 * stored blob once a page has been served and its grace period has passed, so the
 * *second* visit to a page has no bytes to serve. §5 allows exactly one exception —
 * "the first time you click an un-crawled page, the viewer worker fetches that one page
 * via `id_`, rewrites and caches it, then serves it" — and this is it. The edge page
 * cache in front of it is the "and caches it".
 *
 * The rewrite is the *same contract* the ingest rewriter applies, driven by data and pure
 * decisions from `@custom-wayback/pipeline` (`HEAD_CONTRACT`, `headInjection`,
 * `scriptDisposition`, `formNeutralisation`, `isStrippedMeta`, `isForeignBase`):
 *
 *   1. every upstream `<base>` is removed                       (§6.4 de-base)
 *   2. `<meta http-equiv="refresh">` and `<meta name="robots">` are removed
 *   3. the head contract is injected at the top of `<head>`: the §10 CSP meta, the
 *      runtime stylesheet, the runtime script — ahead of every archived script, so the
 *      shims exist before page code runs — then the `<base href>` for the snapshot
 *      route                                            (§6.4 shim injection, CSP)
 *   4. `<script src>` is triaged: dead analytics/ad/tag-manager hosts become inert
 *      `text/plain` markers instead of live requests            (§6.4 script triage)
 *   5. archived asset URLs are routed through the same-origin resource proxy
 *   6. form actions are disabled so captures cannot submit into the live internet
 *   7. the response identifies its source, refuses indexing, and is not cached by the
 *      browser (the edge holds the copy)
 *
 * Streaming matters: `HTMLRewriter` rewrites as the bytes arrive, with constant memory
 * and no DOM for a 2 MB page (§4).
 *
 * Exported for `apps/api/test/viewer.test.ts`. There are no test-only branches inside.
 */
export async function fetchOnDemand(
  domain: string,
  day: string,
  path: string,
  ts: string,
  env: Env,
  options: OnDemandOptions = {},
): Promise<Response> {
  const capture = await locateCapture(env, { domain, day, path, ts, sourceUrl: options.sourceUrl, useKv: false });
  if (capture.kind === "redirect") return captureRedirect(capture.route);
  if (capture.kind === "error" && capture.status === 502) {
    return viewerFailure(502, "The archive could not be reached", "The archived page could not be downloaded. Reload to try again.");
  }
  if (capture.kind === "error" && capture.status === 429) {
    return throttled(
      viewerFailure(502, "The archive could not serve this page", "archive.org is rate-limiting requests right now. Wait a minute, then reload."),
    );
  }
  if (capture.kind !== "page") {
    return viewerFailure(502, "The archive could not serve this page", `The archived page returned HTTP ${capture.status}. Reload to try again.`);
  }
  return renderCapture(capture, {
    domain,
    day,
    frameRole: frameAppOrigin(env) !== null,
    origin: options.resourceOrigin,
    resolvedDay: options.resolvedDay,
    deltaDays: options.deltaDays,
    critical: options.critical,
  });
}

/** Encodings `HTMLRewriter` decodes: the ASCII-compatible ones in the WHATWG list. */
const REWRITABLE_CHARSET =
  /^(?:utf-?8|us-ascii|ascii|iso-8859-\d{1,2}|windows-125\d|shift_jis|sjis|euc-jp|euc-kr|gbk|gb2312|gb18030|big5|koi8-[ru]|macintosh)$/i;

/**
 * The document's declared encoding, and its body with the bytes read to find it put back.
 *
 * The header wins when it says; otherwise the first 4 KB are searched for a
 * `<meta charset>`. It matters because the injected head is ~20 KB and goes *in front of*
 * the page's own `<meta charset>`, pushing it past the 1024 bytes a browser scans for
 * one — so a page that declared its encoding only in markup would be decoded as
 * windows-1252. The encoding is therefore always stated in our header.
 */
async function declaredCharset(upstream: Response): Promise<{ body: ReadableStream<Uint8Array> | null; charset: string }> {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(upstream.headers.get("Content-Type") ?? "")?.[1];
  const usable = (value: string | undefined | null) => (value && REWRITABLE_CHARSET.test(value) ? value.toLowerCase() : null);
  if (fromHeader) return { body: upstream.body, charset: usable(fromHeader) ?? "utf-8" };
  if (!upstream.body) return { body: null, charset: "utf-8" };

  const reader = upstream.body.getReader();
  const head: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size < 4096) {
    const chunk = await reader.read();
    if (chunk.done) {
      done = true;
      break;
    }
    head.push(chunk.value);
    size += chunk.value.byteLength;
  }
  const prefix = new TextDecoder().decode(head.length === 1 ? head[0] : concatBytes(head, size));
  const fromMarkup = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(prefix)?.[1];

  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { body: replay, charset: usable(fromMarkup) ?? "utf-8" };
}

function concatBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * The `<base>` for a page: its own directory under the snapshot route.
 *
 * Every URL in the markup is rewritten to an absolute one, so the base only decides how
 * the page's *script* resolves a relative URL. Against the route root, `img.src =
 * "hero.jpg"` on `/iphone/` meant `/hero.jpg`; against the page's directory it means
 * `/iphone/hero.jpg`, which is what the original page loaded.
 */
function baseHrefFor(domain: string, day: string, pageUrl: string): string {
  const root = `/a/${domain}/${day}/`;
  try {
    const url = new URL(pageUrl);
    if (!sameSite(url.href, `https://${domain}/`)) return root;
    const directory = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/";
    return `/a/${domain}/${day}${directory}`;
  } catch {
    return root;
  }
}

/** A resource the browser must have before it can paint the page. */
interface CriticalResource {
  ts: string;
  url: string;
  destination: "style" | "script";
}

interface RenderContext {
  domain: string;
  day: string;
  /**
   * When present, filled with the page's stylesheets and parser-blocking scripts as the
   * rewrite meets them — the resources a click on this page would wait for.
   */
  critical?: CriticalResource[] | undefined;
  /** Served from the archive-only frame origin (see `FRAME_SANDBOX_DIRECTIVE`). */
  frameRole?: boolean | undefined;
  origin?: string | undefined;
  resolvedDay?: string | null | undefined;
  deltaDays?: number | null | undefined;
}

/** Rewrite one located capture into the page the iframe shows. */
async function renderCapture(
  capture: { response: Response; ts: string; url: string },
  context: RenderContext,
): Promise<Response> {
  const { domain, day, origin, resolvedDay, deltaDays } = context;
  const frameRole = context.frameRole === true;
  const { ts, url: originalUrl } = capture;
  const pageCsp = origin ? snapshotCspForOrigin(origin) : snapshotCsp();

  // A capture that is not a document — a PDF or an image opened from a link — is served
  // as itself. Rewriting it as HTML would show its bytes as text.
  const upstreamType = capture.response.headers.get("Content-Type") ?? "";
  if (upstreamType && !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(upstreamType)) {
    return new Response(capture.response.body, {
      status: 200,
      headers: {
        "Content-Type": upstreamType,
        "Content-Security-Policy": snapshotCspHeader(origin, frameRole),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Custom-Wayback-Source": "on-demand",
        "X-Robots-Tag": HEAD_CONTRACT.robotsContent,
        [EDGE_STORE_HEADER]: "1",
      },
    });
  }

  const { body, charset } = await declaredCharset(capture.response);
  const upstream = new Response(body, { headers: { "Content-Type": `text/html; charset=${charset}` } });

  const injection = headInjection({
    baseHref: baseHrefFor(domain, day, originalUrl),
    csp: pageCsp,
    // The runtime reads this for the toolbar bridge ("you are looking at the
    // on-demand rendition of X"). Its flag counts stay at the runtime's zero
    // defaults: `HTMLRewriter` streams, so this meta is emitted before the scripts
    // that would be counted have been seen, and a partial count would be worse than
    // none. The stub markers themselves are the record of what was stubbed.
    metas: {
      "cw-mirror": JSON.stringify({
        day,
        url: originalUrl,
        ts,
        source: "on-demand",
        resolvedDay: resolvedDay ?? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
        deltaDays: deltaDays ?? null,
        resourceProxy: true,
      }),
    },
  });

  // Set when the head contract has been injected, so the no-head fallback below
  // cannot inject it twice.
  let injected = false;
  let inlineStyle = "";
  const seen = new Set<string>();
  const resource = (raw: string) => onDemandResourceUrl(raw, originalUrl, ts, seen);
  const recordCritical = (raw: string, destination: CriticalResource["destination"]) => {
    if (!context.critical) return;
    try {
      const target = new URL(raw.trim(), originalUrl);
      target.hash = "";
      if ((target.protocol !== "http:" && target.protocol !== "https:") || isTrackerUrl(target)) return;
      if (context.critical.some((item) => item.url === target.href)) return;
      context.critical.push({ ts, url: target.href, destination });
    } catch {
      // Not a URL; nothing to warm.
    }
  };

  const rewritten = new HTMLRewriter()
    // 1. De-base. Everything that is not the base we are about to inject is the
    //    capture's own and must go: two bases mean "whichever comes first wins", and
    //    relative URLs would silently resolve against the original host or not at all.
    .on(HEAD_CONTRACT.base.element, {
      element(el) {
        if (isForeignBase(el.getAttribute(HEAD_CONTRACT.base.hrefAttribute), injection.baseHref)) {
          el.remove();
        }
      },
    })
    // 2. Head hygiene. A meta refresh navigates the visitor out of the mirror, and an
    //    archived robots directive speaks for a site we are not — our own noindex
    //    intent is on the response instead.
    .on("meta", {
      element(el) {
        const httpEquiv = (el.getAttribute("http-equiv") ?? "").trim().toLowerCase();
        // The capture's own policy goes — it names hosts that are not ours — but ours
        // stays, should a rewriter ever hand the injected block back to this handler.
        const ownPolicy = httpEquiv === "content-security-policy" && el.getAttribute("content") === pageCsp;
        if (
          isStrippedMeta(httpEquiv, el.getAttribute("name")) ||
          (httpEquiv === "content-security-policy" && !ownPolicy) ||
          httpEquiv === "content-security-policy-report-only"
        ) {
          el.remove();
        }
      },
    })
    // 3. The head contract, prepended as one block so the CSP meta governs everything
    //    after it and the runtime shims exist before any archived script runs.
    .on("head", {
      element(el) {
        if (injected) return;
        injected = true;
        el.prepend(injection.html, { html: true });
      },
    })
    // Some captures have a `<body>` and no `<head>`, because the original document was
    // malformed and `id_` serves it as it was. Give the document a head rather than
    // dropping the runtime, the base and the CSP on the floor. A capture with neither
    // head nor body is a fragment, not a document, and is left alone.
    .on("body", {
      element(el) {
        if (injected) return;
        injected = true;
        el.before(`<head>\n${injection.html}\n</head>`, { html: true });
      },
    })
    // 4. Script triage. Attribute values arrive already entity-decoded from the
    //    parser, so unlike the ingest rewriter (which reads a DOM attribute and has to
    //    decode entities itself) the URL is used as-is. Inline scripts with no `src`
    //    are left alone, exactly as the ingest rewriter leaves them.
    .on(HEAD_CONTRACT.stubScript.element, {
      element(el) {
        const src = el.getAttribute("src");
        if (!src) return;
        if (scriptDisposition(src) === "stub") {
          el.replace(stubScriptHtml(src), { html: true });
          return;
        }
        // A classic script without async/defer stops the parser until it has run.
        const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
        if (!el.hasAttribute("async") && !el.hasAttribute("defer") && type !== "module") recordCritical(src, "script");
        el.setAttribute("src", resource(src));
      },
    })
    // 5. Archived assets are rewritten to the same-origin resource route.
    .on("img[src], source[src], video[src], audio[src], track[src], embed[src], input[type=\"image\"][src]", {
      element(el) {
        const src = el.getAttribute("src");
        if (src) el.setAttribute("src", resource(src));
      },
    })
    .on("video[poster]", {
      element(el) {
        const poster = el.getAttribute("poster");
        if (poster) el.setAttribute("poster", resource(poster));
      },
    })
    .on("img[srcset], source[srcset]", {
      element(el) {
        const srcset = el.getAttribute("srcset");
        if (srcset) el.setAttribute("srcset", rewriteOnDemandSrcset(srcset, originalUrl, ts, seen));
      },
    })
    .on("img[data-src], img[data-original], img[data-lazy-src], img[data-original-src], img[data-image], img[data-srcset], img[data-lazy-srcset]", {
      element(el) {
        for (const attr of ["data-src", "data-original", "data-lazy-src", "data-original-src", "data-image"]) {
          const value = el.getAttribute(attr);
          if (value) el.setAttribute(attr, resource(value));
        }
        for (const attr of ["data-srcset", "data-lazy-srcset"]) {
          const value = el.getAttribute(attr);
          if (value) el.setAttribute(attr, rewriteOnDemandSrcset(value, originalUrl, ts, seen));
        }
      },
    })
    .on("link[href]", {
      element(el) {
        const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
        if (!rel.some((item) => ["stylesheet", "icon", "preload", "modulepreload", "mask-icon", "apple-touch-icon"].includes(item))) return;
        const href = el.getAttribute("href");
        if (!href) return;
        if (rel.includes("stylesheet")) recordCritical(href, "style");
        el.setAttribute("href", resource(href));
      },
    })
    .on("a[href], area[href]", {
      element(el) {
        const href = el.getAttribute("href");
        if (!href || href.trim().startsWith("#")) return;
        let resolved: URL;
        try {
          resolved = new URL(href, originalUrl);
        } catch {
          return;
        }
        const canonical = canonicalize(resolved.href);
        if (!canonical) return;

        if (sameSite(canonical, originalUrl)) {
          const suffix = resolved.hash;
          if (isNavigablePage(canonical)) {
            el.setAttribute("href", `${snapshotPath(domain, day, canonical)}${suffix}`);
          } else {
            el.setAttribute("href", resource(canonical));
          }
          return;
        }

        el.setAttribute("href", canonical);
        el.setAttribute("rel", "noopener noreferrer nofollow");
        el.setAttribute("target", "_blank");
        el.setAttribute("data-cw-external", "1");
      },
    })
    .on("[style]", {
      element(el) {
        const style = el.getAttribute("style");
        if (style) el.setAttribute("style", rewriteOnDemandCss(style, originalUrl, ts, seen));
      },
    })
    .on("style", {
      text(text) {
        inlineStyle += text.text;
        if (!text.lastInTextNode) {
          text.remove();
          return;
        }
        text.replace(rewriteOnDemandCss(inlineStyle, originalUrl, ts, seen));
        inlineStyle = "";
      },
    })
    // 6. Keep archived form submissions disabled under the shared ingest contract.
    .on(HEAD_CONTRACT.form.element, {
      element(el) {
        const neutralised = formNeutralisation(el.getAttribute(HEAD_CONTRACT.form.actionAttribute));
        el.removeAttribute(neutralised.removeAttribute);
        for (const [name, value] of Object.entries(neutralised.attributes)) {
          el.setAttribute(name, value);
        }
      },
    })
    .transform(upstream);

  // 7. Our own headers, on a `Headers` object this function owns.
  //
  // `rewritten.headers` is not reused: `HTMLRewriter.transform()` hands back the
  // upstream response's header guard, and downstream middleware (`secureHeaders` in
  // `src/index.ts`) decorates responses by mutating headers in place. Mutating an
  // immutable header list throws "Can't modify immutable headers", which would turn
  // every on-demand page into a 500. Constructing the Response from a fresh `Headers`
  // gives us a mutable list, so the decoration works.
  const headers = new Headers({
    "Content-Type": `text/html; charset=${charset}`,
    // The same content policy the R2 path sets as a header, plus the sandbox. The
    // rewrite also emits it as a `<meta http-equiv>`, but a header is the one the
    // browser enforces before parsing and the one that survives anything the page does
    // to its own `<head>`.
    "Content-Security-Policy": snapshotCspHeader(origin, frameRole),
    // The browser never keeps this page: the copy lives at the edge (`storeAtEdge`),
    // and a sandboxed iframe's opaque origin gets no HTTP cache in any case.
    "Cache-Control": "no-store",
    "X-Custom-Wayback-Source": "on-demand",
    "X-Robots-Tag": HEAD_CONTRACT.robotsContent,
    [EDGE_STORE_HEADER]: "1",
  });
  // Nearest-capture badge: same headers the R2 path attaches via
  // injectToolbarHeaders, so the ViewerPage shell sees them regardless of which
  // plane served the page.
  if (resolvedDay) headers.set("X-Wayback-Resolved-Day", resolvedDay);
  if (deltaDays !== null && deltaDays !== undefined) headers.set("X-Wayback-Delta-Days", String(deltaDays));
  return new Response(rewritten.body, { status: 200, headers });
}

// ── Prefetch ─────────────────────────────────────────────────────────────────

/**
 * What one warm request may do. Sized for the Workers Free plan with room to spare: about
 * 50 subrequests per invocation (each archive redirect hop counts as one), 30 s of
 * `waitUntil`, and a CPU allowance that rewriting a large page and its stylesheets eats
 * into. The viewer sends its likely links in batches of this size, a moment apart.
 */
const WARM_LIMIT = 2;
const WARM_ASSETS_PER_PAGE = 4;
const WARM_ASSETS_TOTAL = 6;
const WARM_BUDGET_MS = 20_000;

/**
 * Prepare the pages a visitor is likely to open next, so the click is an edge hit.
 *
 * plan.md §2.2 promises "click → next page < 100 ms perceived" by pre-warming the most
 * likely links. The service worker cannot do it: a sandboxed iframe's navigation is not
 * controlled by the app's service worker, and its opaque origin has no HTTP cache, so a
 * copy prefetched into the browser was never used. The edge is the cache the iframe does
 * use, so this warms that instead.
 *
 * Each page is followed by the stylesheets and blocking scripts it would wait for — a
 * page whose HTML is at the edge but whose section stylesheet is not still opens slowly.
 * Most of those are shared across a site and already cached, and a cached one costs
 * nothing; the rest are capped (`WARM_ASSETS_*`).
 *
 * Everything is prepared **one at a time** in a single background task — the request
 * rate a reader clicking through the site would produce, not a burst — and anything
 * already at the edge costs no archive.org request at all (§12 rules 1 and 3).
 */
export function scheduleWarm(env: Env, ctx: Deferrer, origin: string, routes: unknown): number {
  if (!Array.isArray(routes)) return 0;
  const targets: { key: string; domain: string; day: string; path: string }[] = [];
  const keys = new Set<string>();
  for (const raw of routes) {
    if (typeof raw !== "string" || raw.length > 2048) continue;
    let pathname: string;
    try {
      pathname = new URL(raw, origin).pathname;
    } catch {
      continue;
    }
    const route = parseSnapshotRoute(pathname);
    if (!route) continue;
    const key = pageCacheKey(origin, route.domain, route.day, route.path);
    if (keys.has(key)) continue;
    keys.add(key);
    targets.push({ key, ...route });
    if (targets.length >= WARM_LIMIT) break;
  }
  if (targets.length === 0) return 0;

  ctx.waitUntil(
    (async () => {
      // archive.org is throttling this data centre: a prefetch now only prolongs it.
      if (await archiveThrottled()) return;
      const started = Date.now();
      const overBudget = () => Date.now() - started > WARM_BUDGET_MS;
      let assetsWarmed = 0;
      let redirectsFollowed = 0;
      // `targets` may grow while this runs: a page that is a site redirect brings its
      // destination along, since that is the page the click will actually show.
      for (const target of targets) {
        if (overBudget()) break;
        if (await matchEdge(target.key)) continue;
        const critical: CriticalResource[] = [];
        try {
          const response = await renderSnapshotPage(env, ctx, target.domain, target.day, target.path, origin, true, critical);
          if (response.headers.get(EDGE_STORE_HEADER) !== "1") {
            await response.body?.cancel();
            if (response.headers.has(THROTTLED_HEADER)) {
              noteThrottle(ctx);
              return;
            }
            continue;
          }
          const location = response.status === 302 ? response.headers.get("Location") : null;
          await caches.default.put(target.key, forEdge(response));
          const next = location ? parseSnapshotRoute(location) : null;
          if (next && redirectsFollowed < WARM_LIMIT) {
            redirectsFollowed += 1;
            targets.push({ key: pageCacheKey(origin, next.domain, next.day, next.path), ...next });
          }
        } catch {
          // A page that cannot be warmed is simply fetched when it is opened.
          continue;
        }
        // Site-wide stylesheets and scripts come first in most pages and are usually
        // cached already; only what archive.org is actually asked for counts.
        let fetchedForPage = 0;
        for (const item of critical) {
          if (overBudget() || assetsWarmed >= WARM_ASSETS_TOTAL || fetchedForPage >= WARM_ASSETS_PER_PAGE) break;
          try {
            const asset = await fetchOnDemandResource(item.ts, item.url, env, ctx, item.destination);
            await asset.arrayBuffer();
            // fetchOnDemandResource has already noted the throttle.
            if (asset.headers.has(THROTTLED_HEADER)) return;
            if (asset.headers.get("X-Custom-Wayback-Cache") !== "hit") {
              assetsWarmed += 1;
              fetchedForPage += 1;
            }
          } catch {
            // Fetched when the page asks for it instead.
          }
        }
      }
    })(),
  );
  return targets.length;
}

// ── Resource rewriting ───────────────────────────────────────────────────────

/**
 * Build a local resource URL while preserving fragments used by SVG sprites.
 *
 * ## There is deliberately no cap here
 *
 * There used to be: `MAX_ON_DEMAND_RESOURCES = 120`, and once a page had referenced 120
 * distinct resources every further URL was returned **unchanged**. Unchanged means it
 * points at the live host, which the snapshot's CSP blocks — so past the 120th reference
 * the page's images, stylesheets and scripts silently broke. Measured on
 * `www.walmart.com`: exactly 120 distinct proxied URLs, with 66 `<img>` tags in the
 * document, so a large share of its imagery was dead.
 *
 * A cap on *rewriting* buys nothing. Rewriting is a string transformation during the
 * stream — the page's size is unchanged by a few hundred more attributes, and the cost of
 * a resource is paid only if the browser requests it, at which point the resource route
 * serves it through the same cache and the same politeness budget as any other request.
 * The browser fetches what it displays; a page that references 400 images does not cause
 * 400 fetches on a phone. So the only effect of the cap was to break the tail of a
 * modern page's assets.
 *
 * `seen` remains, because it de-duplicates: the same URL appearing in `src`, `srcset`
 * and a CSS `url()` is mapped once, which keeps the generated markup identical for
 * identical input.
 */
function onDemandResourceUrl(raw: string, base: string, ts: string, seen: Set<string>): string {
  const value = raw.trim();
  if (!value || /^(?:data|blob|javascript):/i.test(value) || value.startsWith("#")) return raw;

  try {
    const target = new URL(value, base);
    if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password) return raw;
    if (isTrackerUrl(target)) return raw;
    const fragment = target.hash;
    target.hash = "";
    seen.add(target.href);
    return `${resourcePath(ts, target)}${fragment}`;
  } catch {
    return raw;
  }
}

/**
 * An analytics endpoint: a tracker host, or an Adobe Analytics path on a site's own
 * metrics subdomain. Left pointing where it pointed, the page's policy refuses it in the
 * browser, free. Proxied, every page view would ask archive.org for a unique,
 * never-captured beacon URL. The runtime applies the same rule to URLs built in script.
 */
export function isTrackerUrl(url: URL): boolean {
  return (
    shouldStubScript(url.href) ||
    /^(?:s?metrics|securemetrics|sstats)\./i.test(url.hostname) ||
    url.pathname.startsWith("/b/ss/")
  );
}

/** Rewrite srcset candidates without splitting the commas inside data URLs. */
function rewriteOnDemandSrcset(value: string, base: string, ts: string, seen: Set<string>): string {
  const candidates: string[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    while (cursor < value.length && /[\s,]/.test(value[cursor] ?? "")) cursor++;
    if (cursor >= value.length) break;

    const start = cursor;
    while (cursor < value.length && !/\s/.test(value[cursor] ?? "")) cursor++;
    const token = value.slice(start, cursor);
    const trailingComma = /,+$/.exec(token)?.[0] ?? "";
    const rawUrl = trailingComma ? token.slice(0, -trailingComma.length) : token;
    let descriptor = "";

    if (!trailingComma) {
      while (cursor < value.length && /\s/.test(value[cursor] ?? "")) cursor++;
      const descriptorStart = cursor;
      while (cursor < value.length && value[cursor] !== ",") cursor++;
      descriptor = value.slice(descriptorStart, cursor).trim();
      if (value[cursor] === ",") cursor++;
    }

    if (rawUrl) {
      const rewritten = onDemandResourceUrl(rawUrl, base, ts, seen);
      candidates.push(descriptor ? `${rewritten} ${descriptor}` : rewritten);
    }
  }

  return candidates.join(", ");
}

/** Rewrite CSS url() and quoted @import references against the CSS file's URL. */
function rewriteOnDemandCss(css: string, base: string, ts: string, seen: Set<string>): string {
  let rewritten = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, quote: string, raw: string) => {
    const target = onDemandResourceUrl(raw, base, ts, seen);
    if (target === raw) return whole;
    const delimiter = quote || '"';
    return `url(${delimiter}${target}${delimiter})`;
  });

  rewritten = rewritten.replace(/(@import\s+)(['"])([^'"]+)\2/gi, (whole, prefix: string, quote: string, raw: string) => {
    const target = onDemandResourceUrl(raw, base, ts, seen);
    return target === raw ? whole : `${prefix}${quote}${target}${quote}`;
  });
  return rewritten;
}

// ── The resource route ───────────────────────────────────────────────────────

/** Types a file extension implies, for the archive's many captures served as octet-stream. */
const EXTENSION_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  wasm: "application/wasm",
  json: "application/json; charset=utf-8",
};

const RESOURCE_CACHE_CONTROL = "public, max-age=604800, s-maxage=31536000, immutable";

/**
 * "The archive has nothing here", typed for whoever asked.
 *
 * A stylesheet or script request answered with `text/plain` is blocked by the browser
 * (ORB) and logged as an error; answered with an empty body of the right type, it is the
 * same absence without the noise. It is cached for a day: a 404 asked again on every
 * page view is an archive.org request on every page view.
 */
function missingResource(status: number, destination: string): Response {
  const type =
    destination === "style" ? "text/css; charset=utf-8" : destination === "script" ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8";
  return new Response(destination === "style" || destination === "script" ? "" : `Archived resource unavailable: ${status}`, {
    status: 404,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "X-Custom-Wayback-Source": "on-demand-resource",
    },
  });
}

/** Fetch one archived dependency, rewriting CSS imports and caching the response. */
export async function fetchOnDemandResource(
  ts: string,
  rawUrl: string,
  env: Env,
  ctx?: Deferrer,
  destination = "",
): Promise<Response> {
  if (!/^\d{14}$/.test(ts) || rawUrl.length > 2048) {
    return new Response("Invalid archived resource request", { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return new Response("Invalid archived resource URL", { status: 400 });
  }
  if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password) {
    return new Response("Unsupported archived resource URL", { status: 400 });
  }
  target.hash = "";

  const cacheQuery = new URLSearchParams({ ts, url: target.href });
  const cacheKey = `https://cache.internal/_cw/resource?${cacheQuery.toString()}`;
  const cached = await matchEdge(cacheKey);
  if (cached) {
    const hit = mutableCopy(cached);
    hit.headers.set("X-Custom-Wayback-Cache", "hit");
    return hit;
  }

  const store = (response: Response): Response => {
    const cacheWrite = caches.default.put(cacheKey, response.clone()).catch(() => void 0);
    if (ctx) ctx.waitUntil(cacheWrite);
    return response;
  };

  let upstream: Response;
  try {
    upstream = await fetchArchivedResource(ts, target.href, env);
  } catch {
    return new Response("Archive resource request failed", {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (upstream.status === 404 || upstream.status === 410) {
    await upstream.body?.cancel();
    return store(missingResource(upstream.status, destination));
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel();
    const failure = new Response(`Archived resource unavailable: ${upstream.status}`, {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
    if (upstream.status !== 429) return failure;
    noteThrottle(ctx);
    return throttled(failure);
  }

  const upstreamType = upstream.headers.get("Content-Type") ?? "application/octet-stream";
  const extension = target.pathname.split(".").pop()?.toLowerCase() ?? "";
  const isHtml = /^text\/html(?:\s*;|$)/i.test(upstreamType);
  // The archive replays whatever type the original server sent, and servers of every era
  // sent CSS and JS as text/plain or octet-stream. Under `nosniff` a mislabelled
  // stylesheet is ignored and a mislabelled script refused, so the destination the
  // browser declared — and failing that the extension — decides.
  const isCss =
    destination === "style" ||
    (!isHtml && (/^text\/css(?:\s*;|$)/i.test(upstreamType) || extension === "css"));
  let body: BodyInit | null = upstream.body;
  let contentType = upstreamType;
  if (isCss) {
    const css = await upstream.text();
    body = rewriteOnDemandCss(css, target.href, ts, new Set<string>());
    contentType = "text/css; charset=utf-8";
  } else if (destination === "script" && !/(?:java|ecma)script/i.test(upstreamType)) {
    contentType = "text/javascript; charset=utf-8";
  } else if (/^(?:application\/octet-stream|binary\/octet-stream|application\/x-download|text\/plain)(?:\s*;|$)/i.test(upstreamType)) {
    contentType = EXTENSION_TYPES[extension] ?? upstreamType;
  }

  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": RESOURCE_CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "X-Custom-Wayback-Source": "on-demand-resource",
  });
  return store(new Response(body, { status: 200, headers }));
}

/** Keep archive redirects on the archive host; never let a resource URL redirect the Worker off-site. */
async function fetchArchivedResource(ts: string, target: string, env: Env): Promise<Response> {
  let current = `${WAYBACK_RAW_BASE}/${ts}id_/${target}`;
  for (let redirects = 0; redirects <= MAX_ARCHIVE_HOPS; redirects++) {
    const response = await fetch(current, {
      headers: { "User-Agent": env.CRAWLER_USER_AGENT },
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("Location");
    if (!location || redirects === MAX_ARCHIVE_HOPS) return response;
    await response.body?.cancel();
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return new Response("Invalid archive redirect", { status: 502 });
    }
    if (next.protocol !== "https:" || next.hostname !== "web.archive.org") {
      return new Response("Archive redirect was blocked", { status: 502 });
    }
    current = next.href;
  }
  return new Response("Too many archive redirects", { status: 502 });
}

// ── Toolbar headers ───────────────────────────────────────────────────────────

function injectToolbarHeaders(
  response: Response,
  resolvedDay: string | null,
  deltaDays: number | null,
): void {
  if (resolvedDay) {
    response.headers.set("X-Wayback-Resolved-Day", resolvedDay);
  }
  if (deltaDays !== null) {
    response.headers.set("X-Wayback-Delta-Days", String(deltaDays));
  }
}

