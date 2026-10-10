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
  HEAD_CONTRACT,
  formNeutralisation,
  headInjection,
  isForeignBase,
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

  // 1. Look up the snapshot ledger.
  const snap = await c.env.DB.prepare(
    `SELECT id, r2_key, ts, resolved_day, delta_days, purged_at, served_at
     FROM snapshots
     WHERE domain = ? AND day = ? AND url LIKE ?
     LIMIT 1`,
  )
    .bind(domain, day, `%${path}`)
    .first<{
      id: string;
      r2_key: string | null;
      ts: string;
      resolved_day: string | null;
      delta_days: number | null;
      purged_at: number | null;
      served_at: number | null;
    }>();

  // 2. Nearest-capture redirect if no snapshot for this exact day.
  if (!snap) {
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
    return new Response("No capture found for this page.", { status: 404 });
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
