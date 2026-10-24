/**
 * Viewer Worker route: /a/:domain/:day/*
 *
 * Fast plane: Workers Cache API → R2 → on-demand id_ fetch.
 * After serving, records served_at in D1 so the purge job can delete the R2 blob.
 *
 * Nearest-capture resolution:
 *  If the requested day has no snapshot, the link_resolutions table is consulted
 *  and we redirect to the nearest captured day.
 */

import { Hono, type Context } from "hono";
import {
  AVAILABILITY_ENDPOINT,
  HEAD_CONTRACT,
  formNeutralisation,
  headInjection,
  isForeignBase,
  isNavigablePage,
  isStrippedMeta,
  scriptDisposition,
  snapshotCsp,
  stubScriptHtml,
} from "@custom-wayback/pipeline";
import type { Env } from "../env.js";
import { serveCachedPage, markServed } from "../lib/r2.js";
import { WAYBACK_RAW_BASE } from "@custom-wayback/shared";

type HonoCtx = Context<{ Bindings: Env }>;

export const viewerRouter = new Hono<{ Bindings: Env }>();

// ── Serve archived page ───────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  r2_key: string | null;
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
    `SELECT id, r2_key, ts, resolved_day, delta_days, purged_at, served_at
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
    `SELECT id, r2_key, ts, resolved_day, delta_days, purged_at, served_at
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

viewerRouter.get("/:domain/:day/*", async (c) => {
  const { domain, day } = c.req.param();

  // Hono 4 does not expose the wildcard segment via `c.req.param("*")` —
  // it returns undefined, making every lookup produce `"/undefined"` and
  // return "No capture found" for every page. Derive the path from the raw
  // request URL instead, stripping the known `/a/:domain/:day` prefix.
  const rawPath = new URL(c.req.url).pathname;
  const prefix = `/a/${domain}/${day}`;
  const path = rawPath.startsWith(prefix)
    ? rawPath.slice(prefix.length) || "/"
    : "/";

  // 1. Look up the snapshot ledger for this exact route.
  let snap = await findSnapshot(c.env, domain, day, path);

  // 1b. A missing ledger row is a *cache miss*, not a dead end.
  //
  // ## Why this is here, before any fallback
  //
  // Nothing about reading a page ever required a crawl: archive.org serves the raw bytes
  // of any capture, and this route already knows how to rewrite and serve them
  // (`fetchOnDemand`). Requiring a ledger row first meant the app could show *nothing*
  // until a crawl had succeeded — and the crawl is precisely the part archive.org
  // throttles. In practice the viewer answered 404 for pages the Internet Archive would
  // happily have served, which is the "View shows nothing" report.
  //
  // So: resolve the closest capture with one availability request and serve it. The
  // crawl goes back to being an optimisation — warm pages from R2, cold ones from the
  // archive — instead of a gate in front of the product.
  if (!snap) {
    const onDemandTs = await resolveOnDemandCapture(c.env, domain, day, path);
    if (onDemandTs) {
      return fetchOnDemand(domain, day, path, onDemandTs, c.env, null, 0);
    }
  }

  // 2. Never a dead end (plan.md §2.3). Before answering 404, look for something
  //    honest to show instead of nothing:
  //
  //      a. the same day's *homepage*, when a deeper page is missing;
  //      b. the nearest day that captured this page at all;
  //      c. the nearest day that captured the homepage.
  //
  //    Each is a redirect, so the toolbar and URL bar end up describing what is
  //    actually on screen. The old behaviour — a bare "No capture found for this
  //    page." — was the failure the plan explicitly rules out, and it is what a
  //    visitor saw for every deep link and every asset-only month.
  if (!snap) {
    if (path !== "/") {
      const rootToday = await findSnapshot(c.env, domain, day, "/");
      if (rootToday) return c.redirect(`/a/${domain}/${day}/`, 302);
    }

    const otherDay = path === "/" ? null : await nearestDay(c.env, domain, day, path);
    if (otherDay) return c.redirect(`/a/${domain}/${otherDay}${path}`, 302);

    const rootElsewhere = await nearestDay(c.env, domain, day, "/");
    if (rootElsewhere && rootElsewhere !== day) {
      return c.redirect(`/a/${domain}/${rootElsewhere}/`, 302);
    }

    // Nothing matched the requested route. Before giving up, open the shallowest HTML
    // page that *does* exist — this day first, then the nearest day that has one.
    //
    // This is what makes a month browsable at all when a site's homepage is captured
    // under an unexpected route. In the live archive the only HTML capture of
    // university.com's day was `https://www.university.com/?a=ctjzgrgkbb`, whose route
    // is `/%3Fa=ctjzgrgkbb`; no request for `/` will ever ask for it, so without this
    // the ledger holds a real page and the browser shows 404.
    //
    // Same day first, because a day picker that silently shows a different day is
    // confusing; the nearest day is the fallback for a day with no capture at all.
    for (const candidateDay of [day, await nearestHtmlDay(c.env, domain, day)]) {
      if (!candidateDay) continue;
      const pageId = await shallowestHtmlPage(c.env, domain, candidateDay);
      if (!pageId) continue;
      return c.redirect(`/a/${domain}/${candidateDay}${pageId}`, 302);
    }

    // The link-resolution ledger carries the nearest capture the *crawl* recorded,
    // which covers links that were resolved at ingest time but never stored as a
    // snapshot of their own.
    if (c.env.SNAPSHOT_BEHAVIOR === "nearest") {
      const nearest = await c.env.DB.prepare(
        `SELECT resolved_day FROM link_resolutions
         WHERE domain = ? AND to_url LIKE ? AND resolved_day IS NOT NULL
         ORDER BY ABS(delta_days) ASC LIMIT 1`,
      )
        .bind(domain, `%${path}`)
        .first<{ resolved_day: string }>();
      if (nearest) {
        return c.redirect(`/a/${domain}/${nearest.resolved_day}${path}`, 302);
      }
    }

    // The one honest 404 left. It says what was asked for and what to do next rather
    // than leaving a bare wall (§2.3 "errors are designed").
    return new Response(
      `No capture of https://${domain}${path} on ${day} was found, and this month has no ` +
        `HTML capture to fall back to. Start (or re-run) the crawl for this month: a month ` +
        `whose ledger holds only images means the CDX survey returned assets instead of ` +
        `pages, which the current crawler no longer does.\n`,
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  // 3. If content already purged, do an on-demand id_ fetch.
  if (snap.purged_at !== null || !snap.r2_key) {
    return fetchOnDemand(domain, day, path, snap.ts, c.env, snap.resolved_day, snap.delta_days);
  }

  // 4. Try Workers Cache API → R2.
  const cacheKey = `https://cache.internal/a/${domain}/${day}${path}`;
  const response = await serveCachedPage(snap.r2_key, cacheKey, c.env, c.executionCtx as unknown as ExecutionContext);
  if (response) {
    // Record served_at (fire-and-forget) so purge job can act.
    c.executionCtx.waitUntil(markServed(c.env, snap.id));
    // `serveCachedPage` guarantees a response we own, so both of these are safe
    // even when the bytes came straight out of the CDN cache. Attaching the §10
    // policy here matters: without it the R2 path served archived pages with no
    // content policy at all, while the on-demand path had one — the same URL
    // getting a different security posture depending on which path served it.
    response.headers.set("Content-Security-Policy", snapshotCsp());
    injectToolbarHeaders(response, snap.resolved_day, snap.delta_days);
    return response;
  }

  // 5. Full cache miss — on-demand fetch.
  return fetchOnDemand(domain, day, path, snap.ts, c.env, snap.resolved_day, snap.delta_days);
});

/**
 * The closest capture of one page enough to serve it on demand, or null.
 *
 * One availability request per (page, day), cached in KV: the answer is immutable
 * history, so a repeat visit costs nothing and the viewer never re-probes a URL it has
 * already asked about. A negative result is cached for a day, because "this page was
 * never captured" is true until a new crawl says otherwise, but a re-crawl should not be
 * blocked by a stale "no" for a week.
 */
async function resolveOnDemandCapture(
  env: Env,
  domain: string,
  day: string,
  path: string,
): Promise<string | null> {
  const stamp = day.replace(/-/g, "");
  if (!/^\d{8}$/.test(stamp)) return null;

  const key = `capture:${domain}${path}:${day}`;
  try {
    const cached = await env.COVERAGE_KV.get(key, "text");
    if (cached) return cached === "-" ? null : cached;
  } catch {
    // KV is a cache; a miss or an error both mean "ask archive.org".
  }

  /**
   * Try the bare host, then the `www.` form.
   *
   * The archive indexes captures under whatever host the page was crawled from, and the
   * two are not interchangeable: `https://university.com/` has **no capture at all**
   * (the availability API answers `{}`), while `https://www.university.com/` has one the
   * same week. Without the second probe the viewer answers 404 for a site that is
   * captured — the exact "nothing renders" symptom — so a miss on the bare host is worth
   * one more request.
   */
  const targets = [`https://${domain}${path}`];
  if (!domain.startsWith("www.")) targets.push(`https://www.${domain}${path}`);

  let ts: string | null = null;
  for (const target of targets) {
    const probe = `${AVAILABILITY_ENDPOINT}?url=${encodeURIComponent(target)}&timestamp=${stamp}`;
    try {
      const res = await fetch(probe, { headers: { "User-Agent": env.CRAWLER_USER_AGENT } });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        archived_snapshots?: {
          closest?: { available?: boolean; timestamp?: string; status?: string };
        };
      };
      const closest = body.archived_snapshots?.closest;
      // A capture of an error page is not a page worth serving.
      if (closest?.available && closest.status === "200" && /^\d{14}$/.test(closest.timestamp ?? "")) {
        ts = closest.timestamp ?? null;
        break;
      }
    } catch {
      // Try the next host form; a network blip must not become a 404.
    }
  }

  try {
    await env.COVERAGE_KV.put(key, ts ?? "-", {
      expirationTtl: ts ? 60 * 60 * 24 * 7 : 60 * 60 * 24,
    });
  } catch {
    // Losing the cache entry only costs one extra probe next time.
  }
  return ts;
}

// ── On-demand id_ fetch ───────────────────────────────────────────────────────

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
 * via `id_`, rewrites and caches it, then serves it" — and this is it.
 *
 * ## What went wrong before, and what this does instead
 *
 * This function used to prepend a `<base>` and a CSP meta and call it a rewrite. The
 * result was a page that behaved differently on its second visit than on its first:
 * no runtime shim (so legacy analytics globals were `undefined` and old page code
 * threw where it had not thrown a minute earlier), no script triage (so dead
 * third-party scripts were fetched, which is the "page hangs for 30 s and sprays
 * console errors" failure §6.4 exists to prevent), a surviving `<base>` competing with
 * the injected one, a live `<meta http-equiv="refresh">` that yanked the visitor out of
 * the mirror, live `<form action>` posting to the internet, and a weaker CSP.
 *
 * The rewrite is now the *same contract* the ingest rewriter applies, in the order
 * plan.md implies, all of it driven by data and pure decisions from
 * `@custom-wayback/pipeline` (`HEAD_CONTRACT`, `headInjection`, `scriptDisposition`,
 * `formNeutralisation`, `isStrippedMeta`, `isForeignBase`):
 *
 *   1. every upstream `<base>` is removed                       (§6.4 de-base)
 *   2. `<meta http-equiv="refresh">` and `<meta name="robots">` are removed
 *   3. the head contract is injected at the top of `<head>`: the §10 CSP meta, the
 *      runtime stylesheet, the runtime script — ahead of every archived script, so the
 *      shims exist before page code runs — then the `<base href>` for the snapshot
 *      route                                            (§6.4 shim injection, CSP)
 *   4. `<script src>` is triaged: dead analytics/ad/tag-manager hosts become inert
 *      `text/plain` markers instead of live requests            (§6.4 script triage)
 *   5. `<form action>` is moved to `data-cw-action`, with submission disabled (§10)
 *   6. the response says which plane produced it, refuses indexing, and is not cached
 *
 * ## Deliberate scope limit: asset URLs are NOT rewritten here
 *
 * An on-demand page's `src`/`href`/`srcset`/CSS `url()` still point at their original
 * absolute URLs. That is not an oversight, and it cannot be fixed at read time:
 *
 *   - Remapping assets requires the content-addressed `assetMap` (original URL → hash),
 *     which only exists after the bytes have been fetched *and hashed*. That is the
 *     ingest job (§6.5); nothing on this path may fetch assets, because doing so would
 *     put archive.org back on the critical path that §3.1 removed and would turn one
 *     page view into hundreds of upstream requests.
 *   - The §10 CSP is applied unchanged, so those un-rewritten requests are blocked
 *     rather than allowed to leak the visitor's IP to whatever those hosts resolve to
 *     today (§10 "no third-party live network"). Blocking is instant; a page that
 *     fetches dead endpoints is the thirty-second hang §6.4 is about. That is what
 *     "contained rather than silently broken" means here, and the
 *     `X-Custom-Wayback-Source: on-demand` header is how a human can tell which plane
 *     served what they are looking at.
 *   - A deployment that wants images to load anyway can relax the policy per call with
 *     `headInjection({ csp: snapshotCsp("img-src 'self' data: blob: https://example.com") })`;
 *     that is a product decision, not a default.
 *
 * Streaming matters: `HTMLRewriter` rewrites as the bytes arrive, with constant memory
 * and no DOM for a 2 MB page (§4). A parser that needs the whole document is the wrong
 * shape for a Worker on the critical path.
 *
 * Exported for `apps/api/test/viewer.test.ts`. There are no test-only branches inside.
 */
export async function fetchOnDemand(
  domain: string,
  day: string,
  path: string,
  ts: string,
  env: Env,
  resolvedDay?: string | null,
  deltaDays?: number | null,
): Promise<Response> {
  const originalUrl = `https://${domain}${path}`;
  const rawUrl = `${WAYBACK_RAW_BASE}/${ts}id_/${originalUrl}`;

  const upstream = await fetch(rawUrl, {
    headers: { "User-Agent": env.CRAWLER_USER_AGENT },
  });

  if (!upstream.ok) {
    return new Response(`Archive fetch failed: ${upstream.status}`, {
      status: 502,
    });
  }

  const injection = headInjection({
    baseHref: `/a/${domain}/${day}/`,
    // The runtime reads this for the toolbar bridge ("you are looking at the
    // on-demand rendition of X"). Its flag counts stay at the runtime's zero
    // defaults: `HTMLRewriter` streams, so this meta is emitted before the scripts
    // that would be counted have been seen, and a partial count would be worse than
    // none. The stub markers themselves are the record of what was stubbed.
    metas: { "cw-mirror": JSON.stringify({ day, url: originalUrl, source: "on-demand" }) },
  });

  // Set when the head contract has been injected, so the no-head fallback below
  // cannot inject it twice.
  let injected = false;

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
        if (isStrippedMeta(el.getAttribute("http-equiv"), el.getAttribute("name"))) {
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
        if (scriptDisposition(src) !== "stub") return;
        el.replace(stubScriptHtml(src), { html: true });
      },
    })
    // 5. Forms must not post into the live internet (§10). Same attributes as the
    //    ingest rewriter writes, from the same contract data.
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

  // 6. Our own headers, on a `Headers` object this function owns.
  //
  // `rewritten.headers` is not reused: `HTMLRewriter.transform()` hands back the
  // upstream response's header guard, and downstream middleware (`secureHeaders` in
  // `src/index.ts`) decorates responses by mutating headers in place. Mutating an
  // immutable header list throws "Can't modify immutable headers", which would turn
  // every on-demand page into a 500. Constructing the Response from a fresh `Headers`
  // gives us a mutable list, so the decoration works.
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    // The same content policy the R2 path sets as a header. The rewrite also emits it as
    // a `<meta http-equiv>`, but a header is the one the browser enforces before parsing
    // and the one that survives anything the page does to its own `<head>`; serving the
    // two planes with different strengths meant a page's security posture depended on
    // whether it happened to be cached.
    "Content-Security-Policy": snapshotCsp(),
    // Not the ingest path's `immutable, max-age=31536000`: this rendition is missing
    // the asset rewrite, and it becomes the *good* rendition again after a re-ingest
    // clears `purged_at`. Freezing the weaker one in a browser or CDN cache would make
    // the difference permanent, and the CDN entry that matters is the one the R2 path
    // populates deliberately.
    "Cache-Control": "no-store",
    "X-Custom-Wayback-Source": "on-demand",
    "X-Robots-Tag": HEAD_CONTRACT.robotsContent,
  });
  const response = new Response(rewritten.body, { status: 200, headers });
  // Nearest-capture badge: same headers the R2 path attaches via
  // injectToolbarHeaders, so the ViewerPage shell sees them regardless of which
  // plane served the page.
  if (resolvedDay) headers.set("X-Wayback-Resolved-Day", resolvedDay);
  if (deltaDays !== null && deltaDays !== undefined) headers.set("X-Wayback-Delta-Days", String(deltaDays));
  return response;
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
