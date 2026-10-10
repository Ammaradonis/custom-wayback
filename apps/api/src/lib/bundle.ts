/**
 * Static export bundles (plan.md §15, "Snapshot export as a static ZIP").
 *
 * ## What this file is, and what it deliberately is not
 *
 * Everything here is a **pure function over plain data**: paths in, paths out;
 * bytes in, ZIP bytes out. No R2, no D1, no `fetch`, no `HTMLRewriter`, and no
 * Node builtin import of any kind. That is what makes the interesting half of this
 * feature testable in Node (`test/bundle.test.ts`), where none of those exist — and
 * it is also the only way the ZIP writer can be exercised at all, because the
 * Worker runtime has no zip library and `apps/api` bundles into a Worker, so adding
 * one is not an option (a runtime zip library is either far too large or reaches
 * for Node builtins).
 *
 * The route (`routes/export.ts`) is a thin shell over this: it finds the rows,
 * reads the blobs, hands the bytes to `buildZip`, and writes the result to R2.
 * The one thing it does that this file cannot is walk HTML with `HTMLRewriter` —
 * every *decision* about what a rewritten URL becomes is made here, and the route
 * only applies it.
 *
 * ## Why the bundle has to be self-contained
 *
 * The point of the export is to hand a month of a site to somebody who does not
 * have this tool, or to keep it after this tool is gone. The stored HTML refers to
 * viewer routes (`/a/<domain>/<day>/<path>`) and to content-addressed assets
 * (`/assets/<hh>/<hash>`) that exist only on our origin, so every one of those
 * references has to be re-pointed at a file inside the archive. The rewritten URL
 * is therefore **relative to the page that contains it**, which is what makes the
 * result work from `file://`, from a static host at a domain root, and from a
 * static host under a path prefix (`/colleague/2024-03/`) — the last of which a
 * root-absolute URL silently breaks.
 *
 * ## Layout
 *
 *   index.html                          the landing page, no JS, no CDN
 *   README.txt                          what this is, counts, attribution
 *   pages/<host>/<day>/<path…>.html     one file per captured page
 *   assets/<hh>/<hash>                  content-addressed, same key as R2
 *
 * The day is a directory level because an archive is *about* dates and somebody
 * looking inside the zip should see them. Assets keep their R2 key, so an asset's
 * name is still its content hash — the property the whole storage design rests on
 * (plan.md §3.1) — and two pages that share a logo share one file.
 *
 * ## Determinism
 *
 * Nothing in here reads a clock. Entry order is a fixed sort, ZIP entry
 * timestamps come from the capture timestamp (`snapshots.ts`) clamped into the
 * range MS-DOS timestamps can represent, and DEFLATE is used only when it
 * actually shrinks an entry — so the same input produces byte-identical output.
 * That is what makes the format testable, and it is also the honest answer to
 * "did this export change?".
 */

import { assetPath, hashString, snapshotPath } from "@custom-wayback/pipeline";

// ── Bundle entry names ───────────────────────────────────────────────────────

/** The plain listing at the zip root. */
export const INDEX_ENTRY = "index.html";
/** The human-readable explanation at the zip root. */
export const README_ENTRY = "README.txt";

interface ParsedUrl {
  /** Lowercased host, default port removed — `new URL().host` for http(s). */
  host: string;
  /** Path portion only, leading slash included, query and fragment dropped. */
  pathname: string;
}

/**
 * Split an http(s) URL without `new URL`.
 *
 * `lib/bundle.ts` is imported by tests that run in Node, where `URL` exists — but
 * this file's contract is "pure over plain data", and a parser that is available
 * everywhere, imports nothing and cannot be surprised by a `base` argument is
 * nine lines. The narrow shape also makes the http(s)-only rule explicit, which
 * is the whole of what the ingest path can have produced.
 */
function parseHttpUrl(url: string): ParsedUrl | undefined {
  const match = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!match) return undefined;
  const authority = (match[1] ?? "").toLowerCase();
  let pathname = match[2] ?? "";
  if (pathname === "") pathname = "/";
  let host = authority;
  if (authority.endsWith(":80")) host = authority.slice(0, -3);
  else if (authority.endsWith(":443")) host = authority.slice(0, -4);
  return { host, pathname };
}

/**
 * One path segment, made safe for a filesystem and for a URL.
 *
 * Percent-decoding first is what turns the ingest path's `search%3Fq%3Dshoes`
 * into `search_q_shoes` rather than a name full of percent signs. The replacement
 * set is the union of what Windows and POSIX reject plus the characters a browser
 * would re-interpret, and a segment that is nothing but dots is neutralised —
 * `..` inside a zip is how an archive escapes its own directory.
 */
function safeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape is left as it is; it is still sanitised below.
  }
  const cleaned = decoded
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*'`#%&{}[\]@!$()+;,=~^]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[.\s]+$/, "_");
  const trimmed = cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
  return trimmed.length > 0 ? trimmed : "_";
}

interface SplitPath {
  /** True when the original path ended at a directory boundary. */
  directory: boolean;
  segments: string[];
}

function splitPath(pathname: string): SplitPath {
  const directory = pathname.endsWith("/");
  const segments = pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map(safeSegment);
  return { directory, segments };
}

/**
 * The zip entry a captured page lives at.
 *
 * `pages/<host>/<day>/…` mirrors the shape of the R2 key (`pages/<domain>/<day>/…`)
 * with the host kept as a directory, so a month that spans `www.` and a CDN host
 * stays two browsable trees. Uniqueness comes from the readable path plus
 * `hashString(url)` in the filename — the same 16-hex digest the ingest path
 * already uses for page keys. Two URLs that slugify identically (`/About` and
 * `/about`) are different pages and must not collide.
 *
 * The filename is what gets trimmed when a path is absurdly deep, never the
 * directories, because the digest in the filename is the only thing keeping the
 * archive unambiguous. Windows refuses a path over 260 characters by default and
 * no filesystem is comfortable past that, so a 40-segment marketing URL has to
 * lose something; it loses the middle segments, which is also the part a human
 * reading the extracted tree would skip.
 */
export function pageEntryName(day: string, url: string): string {
  const parsed = parseHttpUrl(url);
  if (!parsed) return `pages/unknown/${day}/${hashString(url)}.html`;
  const { directory, segments } = splitPath(parsed.pathname);
  const last = segments[segments.length - 1];
  const parents = directory || last === undefined ? segments : segments.slice(0, -1);
  const stem = directory || last === undefined ? "index" : last;
  const file = `${stem}-${hashString(url)}.html`;

  const head = ["pages", safeSegment(parsed.host), day];
  let kept = parents;
  while (kept.length > 1 && [...head, ...kept, file].join("/").length > 240) {
    kept = kept.slice(0, -2).concat(kept.slice(-1));
  }
  return [...head, ...kept, file].join("/");
}

/**
 * The zip entry an asset lives at: `assets/<hh>/<hash>`, the same key it has in
 * R2, minus the leading slash that makes it a URL rather than a path.
 */
export function assetEntryName(hash: string): string {
  return assetPath(hash).replace(/^\//, "");
}

/** Where a captured page sits, in the archive the export produced. */
export interface PageLocation {
  /** The page's original URL — the key the link map is built from. */
  url: string;
  /** Its entry inside the zip. */
  entry: string;
}

// ── Relative paths ───────────────────────────────────────────────────────────

function directoryOf(entry: string): string[] {
  const cut = entry.lastIndexOf("/");
  return cut < 0 ? [] : entry.slice(0, cut).split("/");
}

/**
 * `to` expressed relative to the *directory* of `from`.
 *
 * The target keeps its filename and the source does not: a link from a page points
 * at a file, never at the directory that contains it, because `file://` has no
 * index resolution — `about/` reaches nothing there while `about.html` reaches the
 * page. Both entries are at the same depth in the common case, which is what makes
 * the result read as a plain filename.
 *
 * A page and the asset it references live under different top-level directories
 * (`pages/…` and `assets/…`), so this emits `../` for each level the page is deep
 * before descending. Nothing here assumes the archive is unpacked at a server
 * root, which is exactly the assumption that would break `file://`.
 */
export function relativeHref(fromEntry: string, toEntry: string): string {
  const from = directoryOf(fromEntry);
  const to = toEntry.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  const up = new Array(from.length - common).fill("..");
  const parts = [...up, ...to.slice(common)];
  return parts.join("/");
}

/** `/assets/<hh>/<64 hex>` — content-addressed, so it can only ever be an asset. */
const ASSET_TOKEN = /^\/assets\/[0-9a-f]{2}\/[0-9a-f]{64}$/i;
/** The same token anywhere in a string, for collecting what a page references. */
const ASSET_TOKEN_GLOBAL = /\/assets\/[0-9a-f]{2}\/[0-9a-f]{64}/gi;

// ── Rewriting a stored page ──────────────────────────────────────────────────

/** Everything the route needs to repoint one page's URLs at the bundle. */
export interface PageRewrite {
  /** What the injected `<base href>` becomes. */
  base: string;
  /** Viewer route → path of the bundled page, relative to this page. */
  links: Map<string, string>;
  /** `/assets/<hh>/<hash>` → path of the bundled asset, relative to this page. */
  assets: Map<string, string>;
}

/**
 * Every spelling of the viewer route that can point at one bundled page.
 *
 * The stored href is `snapshotPath(domain, day, url)` for whatever day the view
 * was showing, and the ingest resolver may have picked a day other than the
 * page's own — so the map is built from the page list rather than from a guess,
 * and a link to a day the bundle does not contain is simply absent.
 *
 * Two spellings are registered, because the query suffix the ingest path
 * percent-encodes into the path (`%3Fq%3Dshoes`) is decoded by some parsers and
 * re-encoded by others before a value ever reaches `rewriteValue`. Registering
 * both means a link resolves whichever way it is spelled.
 */
function viewerPathsFor(domain: string, loc: PageLocation): string[] {
  const parsed = parseHttpUrl(loc.url);
  if (!parsed) return [];
  const day = dayOfEntry(loc.entry);
  if (!day) return [];
  const paths = [snapshotPath(domain, day, loc.url)];
  try {
    const decoded = decodeURIComponent(paths[0] as string);
    if (!paths.includes(decoded)) paths.push(decoded);
  } catch {
    // Not a decodable path; the encoded spelling is all there is.
  }
  return paths;
}

/** `pages/<host>/<day>/…` → `YYYY-MM-DD`. */
function dayOfEntry(entry: string): string | undefined {
  const match = /^pages\/[^/]+\/(\d{4}-\d{2}-\d{2})\//.exec(entry);
  return match?.[1];
}

/**
 * Build the whole rewrite plan for one page.
 *
 * Three things have to change for stored HTML to work outside our origin:
 *
 *  1. **Links.** `/a/<domain>/<day>/<path>` → the bundled file, relative to this
 *     page.
 *  2. **Assets.** `/assets/<hh>/<hash>` → the bundled asset, relative to this
 *     page. Content-addressed, so one entry covers every reference to it.
 *  3. **`<base href="/">`.** The ingest rewriter injects it so that the relative
 *     URLs it could *not* map still resolve against our router. Inside a zip, `/`
 *     is the filesystem root when the archive is opened from `file://` and the
 *     host root when it is served from a subdirectory — in both cases outside the
 *     archive, which breaks every path the bundle itself uses. It becomes `./`:
 *     the element stays (so an unmapped relative URL still resolves against the
 *     page's own directory, exactly as it did on our origin) and it is a no-op
 *     for every URL the bundle owns.
 */
export function pageRewrites(
  domain: string,
  loc: PageLocation,
  pages: PageLocation[],
  assetHashes: string[],
): PageRewrite {
  const links = new Map<string, string>();
  for (const other of pages) {
    if (other.entry === loc.entry) continue;
    const href = relativeHref(loc.entry, other.entry);
    for (const key of viewerPathsFor(domain, other)) {
      if (!links.has(key)) links.set(key, href);
    }
  }

  const assets = new Map<string, string>();
  for (const hash of assetHashes) {
    const key = assetPath(hash);
    if (!assets.has(key)) assets.set(key, relativeHref(loc.entry, assetEntryName(hash)));
  }

  return { base: "./", links, assets };
}

/**
 * Apply a rewrite to a single URL value, or leave it alone.
 *
 * The route calls this for every attribute it visits. Returning `undefined`
 * rather than the input string is deliberate: the caller has to be able to tell
 * "nothing to do" from "rewrite to this value", because an untouched attribute is
 * not the same as one rewritten to itself.
 */
export function rewriteValue(plan: PageRewrite, value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (ASSET_TOKEN.test(value)) return plan.assets.get(value);
  const link = plan.links.get(value);
  if (link !== undefined) return link;
  // A percent-encoded spelling of the same route (`%3F` for the query suffix, or
  // an encoded path segment) is worth one more lookup before giving up.
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) return plan.links.get(decoded);
  } catch {
    // Not a decodable value; there is nothing else to try.
  }
  return undefined;
}

/**
 * Apply a rewrite list to every URL *inside* a CSS or `srcset` string.
 *
 * Needed because a rewritten page can carry asset references in places
 * `HTMLRewriter` sees as text rather than as an attribute: `style="background:
 * url(/assets/…)"`, a `<style>` block, and `srcset` with several candidates. The
 * tokens are absolute and machine-generated, so a literal substitution is exact —
 * there is no ambiguity to resolve and nothing to parse.
 */
export function rewriteUrlsInText(text: string, plan: PageRewrite): string {
  if (text.length === 0) return text;
  let out = text;
  for (const [from, to] of plan.assets) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  for (const [from, to] of plan.links) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

/**
 * Every content-addressed asset a stored page references.
 *
 * A scan of the rewritten HTML rather than a DOM walk, because at this point the
 * URLs are already absolute and machine-generated: the ingest rewriter produced
 * `/assets/<hh>/<hash>` in `src`, `srcset`, `href` and CSS `url()` alike, and that
 * token cannot appear in prose or collide with page text. So one pass over the
 * bytes is exact, and it is the same pass that decides what the bundle must
 * include — which is why a page can never ship with a reference to an asset the
 * bundle forgot.
 */
export function collectAssetHashes(html: string, into: Set<string> = new Set()): Set<string> {
  for (const match of html.matchAll(ASSET_TOKEN_GLOBAL)) {
    const token = match[0];
    into.add(token.slice(token.lastIndexOf("/") + 1).toLowerCase());
  }
  return into;
}

// ── Text files in the bundle ─────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a stranger's bytes for element text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** One bundled page, as the landing page and the counts need it. */
export interface IndexPage {
  day: string;
  url: string;
  entry: string;
  /** The capture's own `<title>`, when the crawl recorded one. */
  title?: string | undefined;
}

export interface IndexInput {
  domain: string;
  month: string;
  pages: IndexPage[];
  assetCount: number;
  /** Pages the bundle could not include because their blob had been purged. */
  missing: number;
}

function displayName(page: IndexPage): string {
  const parsed = parseHttpUrl(page.url);
  if (!parsed) return page.url;
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const full = `${parsed.host}${path}`;
  return page.title && page.title.length > 0 ? page.title : full;
}

/**
 * The landing page.
 *
 * Plain HTML and a handful of inline CSS rules: no framework, no webfont, no CDN,
 * no script. It has to work offline, from `file://`, and in ten years, so the only
 * dependency it is allowed is the browser's own HTML parser. Dates lead, because
 * a month of a site is organised by day and that is how somebody looks for
 * something in it.
 */
export function buildIndexHtml(input: IndexInput): string {
  const byDay = new Map<string, IndexPage[]>();
  for (const page of input.pages) {
    const bucket = byDay.get(page.day);
    if (bucket) bucket.push(page);
    else byDay.set(page.day, [page]);
  }
  const days = [...byDay.keys()].sort();

  const sections = days.map((day) => {
    const items = (byDay.get(day) ?? [])
      .map((page) => {
        const parsed = parseHttpUrl(page.url);
        const path = parsed ? parsed.pathname : page.url;
        const href = relativeHref(INDEX_ENTRY, page.entry);
        return (
          `      <li><a href="${escapeHtml(href)}">${escapeHtml(displayName(page))}</a>` +
          `<span class="p">${escapeHtml(path)}</span></li>`
        );
      })
      .join("\n");
    return `    <section>\n      <h2>${escapeHtml(day)}</h2>\n      <ul>\n${items}\n      </ul>\n    </section>`;
  });

  const missingNote =
    input.missing > 0
      ? `\n    <p class="warn">${input.missing} page(s) captured in this month are not in this bundle: ` +
        `their stored copy had already been removed by the archive's cleanup job. See README.txt.</p>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${escapeHtml(input.domain)} — ${escapeHtml(input.month)} — static archive</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 54rem; padding: 1.5rem 1rem 4rem;
         font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 2rem 0 .5rem; padding-bottom: .25rem;
       border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  p.meta { margin: 0 0 1rem; opacity: .75; }
  p.warn { padding: .6rem .8rem; border-left: 3px solid #c60; background: color-mix(in srgb, #c60 12%, transparent); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: .25rem 0; display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
  li .p { opacity: .6; font-size: .85em; word-break: break-all; }
  footer { margin-top: 3rem; padding-top: 1rem; font-size: .85rem; opacity: .8;
           border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  a { color: inherit; }
</style>
</head>
<body>
  <h1>${escapeHtml(input.domain)} — ${escapeHtml(input.month)}</h1>
  <p class="meta">${input.pages.length} page(s), ${input.assetCount} asset(s), ${days.length} capture day(s).
     Static archive: every link points at a file in this folder.</p>${missingNote}
${sections.join("\n")}
  <footer>
    <p>Archived from the <a href="https://web.archive.org/">Internet Archive Wayback Machine</a>.
       Captures remain the property of their original authors; this copy is for research and reference.
       <a href="${README_ENTRY}">README.txt</a> explains what this bundle contains.</p>
  </footer>
</body>
</html>
`;
}

// ── README.txt ───────────────────────────────────────────────────────────────

export interface ReadmeInput {
  domain: string;
  month: string;
  /** Every capture date present in the bundle, ascending. */
  days: string[];
  pages: number;
  assets: number;
  missing: number;
  /** The earliest capture timestamp (`YYYYMMDDHHMMSS`) in the bundle, if any. */
  firstTs?: string | undefined;
  /** The latest. */
  lastTs?: string | undefined;
}

/** `20240315120000` → `2024-03-15 12:00:00 UTC`, or undefined if malformed. */
export function formatCaptureTs(ts: string | undefined): string | undefined {
  if (!ts || !/^\d{14}$/.test(ts)) return undefined;
  return (
    `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ` +
    `${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)} UTC`
  );
}

/**
 * The file that has to answer "what am I holding?" without this tool present.
 *
 * plan.md §12 rule 7 asks for visible attribution and a link back to the original
 * capture, so the credit is part of the format rather than decoration. The
 * `missing` count is here for the same reason it is in the API response: an
 * archive that is quietly incomplete is worse than one that says so.
 */
export function buildReadme(input: ReadmeInput): string {
  const first = formatCaptureTs(input.firstTs);
  const last = formatCaptureTs(input.lastTs);
  const captureRange = first && last ? (first === last ? first : `${first} to ${last}`) : "not recorded";

  const missingParagraph =
    input.missing > 0
      ? `
INCOMPLETE — ${input.missing} page(s) missing
----------------------------------------
${input.missing} page(s) were captured for this month but are NOT in this bundle. Their
stored copies had already been deleted by the archive's post-serve cleanup job before
this export ran, so there was nothing left to include. Re-crawling the month and
exporting again is the only way to get them back.
`
      : "";

  return `${input.domain} — ${input.month}
Static archive of one month of a website, captured from the Internet Archive
Wayback Machine.
${"=".repeat(72)}

WHAT THIS IS
------------
A self-contained copy of ${input.pages} page(s) from ${input.domain}, captured during
${input.month}. Open index.html in this folder to browse it. It needs no server, no
network connection, and no software from the tool that produced it.

WHAT IS IN HERE
---------------
  index.html                  browse the bundled days and pages
  README.txt                  this file
  pages/<host>/<day>/…        the pages, one file per capture
  assets/<hh>/<hash>          images, stylesheets, fonts, scripts
                              (the file name is the SHA-256 of its contents)

  Source domain:              ${input.domain}
  Month:                      ${input.month}
  Capture dates:              ${input.days.join(", ") || "none"} (${input.days.length} day(s))
  Capture timestamps:         ${captureRange}
  Pages in this bundle:       ${input.pages}
  Assets in this bundle:      ${input.assets}
  Pages missing (purged):     ${input.missing}
${missingParagraph}
HOW TO OPEN IT
--------------
Double-click index.html. Everything works straight from the local filesystem: the
pages were rewritten so that every link and every asset reference is a relative path
inside this folder, and nothing points back at the tool that made the export.

If you would rather serve it, any static file server works
(python -m http.server, nginx, S3, GitHub Pages) — at the root or in a subdirectory,
it makes no difference. There is no server-side code and no build step.

WHAT IT IS NOT
--------------
  * Not a live website. Links out to other sites point at the live internet and will
    have changed or disappeared.
  * Not guaranteed complete. An archived page is whatever the Wayback Machine
    happened to capture on a given day — see the missing count above.
  * Not interactive in the way the original was. Third-party analytics, advertising
    and tag-manager scripts were replaced with inert placeholders when the pages were
    archived, form submissions are disabled, and JavaScript that depended on dead
    services will not work. Layout and text are what this preserves.

ATTRIBUTION
-----------
Archived from the Internet Archive Wayback Machine — https://web.archive.org/
Original captures: https://web.archive.org/web/*/${input.domain}

The captured pages and assets remain the property of their original authors and
publishers. This bundle is a research and reference copy, not a redistribution of the
work; please credit the Internet Archive and the original site if you pass it on.

Generated by custom-wayback (plan.md §15, "Snapshot export as a static ZIP").
`;
}

// ── Text decoding/encoding ───────────────────────────────────────────────────

const textEncoder = new TextEncoder();
/** Invalid UTF-8 becomes U+FFFD rather than throwing: a capture is untrusted input. */
const textDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/** UTF-8 bytes for a string. One encoder, so nothing depends on the caller's. */
export function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

/** The capture's `<title>`, for the landing page. `undefined` if it has none. */
export function extractPageTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (!match?.[1]) return undefined;
  const title = match[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 0 ? title : undefined;
}

/**
 * Just enough of a stored page to read its `<title>` — for pages the crawl
 * recorded no title for.
 *
 * The route reads the full blob anyway, so this exists for the case where it needs
 * the title *before* it has the bytes: the landing page is written first, and a
 * listing where half the entries are bare URLs is materially worse to browse than
 * one with real page names. Decoding a bounded prefix costs nothing and cannot
 * trip over a multi-megabyte page.
 */
export function titleFromPrefix(bytes: Uint8Array, limit = 4096): string | undefined {
  const end = Math.min(bytes.length, limit);
  return extractPageTitle(textDecoder.decode(bytes.subarray(0, end)));
}

// ── How much of the month is actually present ────────────────────────────────

/** Pages present in the ledger, and how many of them the bundle can include. */
export interface SnapshotCounts {
  /** Distinct page URLs captured for this month. */
  total: number;
  /** Distinct page URLs whose stored bytes are still in R2. */
  stored: number;
}

/**
 * How much of the month the bundle is unable to contain.
 *
 * Counted per *URL*, not per row: a page captured on eight days of the month is
 * one page, and reporting it as eight would overstate what is missing by an order
 * of magnitude. `missing` is a deliverable in its own right (see the route) — it
 * is the amount of the archive the bundle could not include, and a reader handed
 * a partial month without being told is being misled.
 */
export function countMissing(counts: SnapshotCounts): number {
  return Math.max(0, counts.total - counts.stored);
}

// ── CRC-32 ───────────────────────────────────────────────────────────────────

/**
 * The CRC-32 table, built once.
 *
 * This is the polynomial ZIP has used since 1989 (reflected 0xEDB88320) — not a
 * checksum of our choosing, because the whole point is that `unzip` on a machine
 * that has never heard of this tool agrees with the value we wrote.
 */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte range, as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── DEFLATE ──────────────────────────────────────────────────────────────────

/** A compressor: the same bytes in, raw DEFLATE out (or `undefined` to store). */
export type Deflate = (bytes: Uint8Array) => Promise<Uint8Array | undefined> | Uint8Array | undefined;

/** Below this, compression costs more than it saves and is not attempted. */
const DEFLATE_MIN_BYTES = 128;

/**
 * Raw DEFLATE via the platform's own compressor.
 *
 * `deflate-raw` is the format ZIP method 8 expects: a bare DEFLATE stream with no
 * zlib header and no checksum, because ZIP carries its own CRC-32. The compression
 * runs in the platform's implementation rather than in JavaScript, which matters
 * twice over in a Worker — it costs no CPU budget and it cannot be the thing that
 * blows the memory limit.
 *
 * A missing compressor is not a failure: the entry is stored instead. A stored
 * entry is a perfectly valid ZIP, just a larger one, so the failure mode of an
 * older runtime is "bigger download", never "broken archive". Only worth calling
 * for text — images, fonts and archives are already compressed, and re-deflating
 * them spends CPU to save nothing.
 */
export const platformDeflate: Deflate = async (bytes) => {
  if (bytes.length < DEFLATE_MIN_BYTES) return undefined;
  const Compressor = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (typeof Compressor !== "function") return undefined;
  try {
    const parts = [bytes] as unknown as (ArrayBuffer | ArrayBufferView)[];
    const source = new Blob(parts).stream();
    const stream = source.pipeThrough(new Compressor("deflate-raw"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return compressed.length > 0 && compressed.length < bytes.length ? compressed : undefined;
  } catch {
    return undefined;
  }
};

// ── ZIP container ────────────────────────────────────────────────────────────
//
// The format, exactly as PKWARE defined it in 1989 and as every unzipper reads it:
//
//   [local header + name + data] × n
//   [central directory record + name] × n
//   [end of central directory]
//
// There is no other way to produce a file the rest of the world calls a zip, which
// is why this is written out by hand rather than approximated. Every multi-byte
// field is little-endian; offsets in the central directory are absolute from the
// start of the file.

/** ZIP compression methods we emit. */
export const ZIP_STORED = 0;
export const ZIP_DEFLATE = 8;

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
/** General purpose flag bit 11: names and comments are UTF-8. */
const FLAG_UTF8 = 0x0800;

/** One member of the archive, ready to write. */
export interface ZipEntry {
  /** Path inside the zip, forward slashes, no leading slash. */
  name: string;
  /** Uncompressed contents. */
  bytes: Uint8Array;
  /**
   * MS-DOS timestamp fields, or `undefined` for a fixed, reproducible default.
   * Deliberately never `Date.now()` — see `dosTimestamp`.
   */
  dosTime?: number | undefined;
  dosDate?: number | undefined;
  /** Pre-compressed raw DEFLATE bytes, when the caller already ran the encoder. */
  deflated?: Uint8Array | undefined;
}

export interface ZipOptions {
  /** Compressor for entries that arrive with no `deflated` bytes. */
  deflate?: Deflate | undefined;
  /** Timestamp for entries that carry none. Fixed by default, so output repeats. */
  defaultDos?: { time: number; date: number } | undefined;
}

/**
 * A fixed default timestamp: 1980-01-01 00:00:00.
 *
 * MS-DOS timestamps cannot represent anything earlier than 1980, and zero in both
 * fields is a time some unzippers render as garbage, so the epoch of the format
 * itself is the honest value for "the caller did not say when this was captured".
 */
const DOS_EPOCH = { time: 0, date: (1 << 5) | 1 };

/**
 * The MS-DOS date and time pair ZIP stores per entry.
 *
 * Given a capture timestamp (`snapshots.ts`, `YYYYMMDDHHMMSS`) it returns a real
 * modification time, because "the archive says this page was taken then" is
 * genuinely interesting to somebody looking at the extracted files. Given nothing
 * it returns a constant — which is what makes an export reproducible, so a test
 * can assert byte-identity and a human can diff two exports.
 *
 * `second >> 1` is not a bug: MS-DOS time has a two-second resolution.
 * The arithmetic is on digits, not on `Date`, so no timezone can leak in.
 */
export function dosTimestamp(compressed?: string): { time: number; date: number } {
  if (!compressed || !/^\d{14}$/.test(compressed)) return { ...DOS_EPOCH };
  const year = Math.min(Math.max(Number(compressed.slice(0, 4)), 1980), 2107);
  const month = Math.min(Math.max(Number(compressed.slice(4, 6)), 1), 12);
  const day = Math.min(Math.max(Number(compressed.slice(6, 8)), 1), 31);
  const hour = Math.min(Number(compressed.slice(8, 10)), 23);
  const minute = Math.min(Number(compressed.slice(10, 12)), 59);
  const second = Math.min(Number(compressed.slice(12, 14)), 59);
  return {
    time: (hour << 11) | (minute << 5) | (second >> 1),
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

interface EntryMeta {
  nameBytes: Uint8Array;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  size: number;
  method: number;
  offset: number;
}

/** The local file header and its name — the record that precedes the data. */
function localHeader(meta: Omit<EntryMeta, "offset">): Uint8Array {
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
  view.setUint16(4, 20, true); // version needed to extract: 2.0 (deflate)
  view.setUint16(6, FLAG_UTF8, true);
  view.setUint16(8, meta.method, true);
  view.setUint16(10, meta.time, true);
  view.setUint16(12, meta.date, true);
  view.setUint32(14, meta.crc, true);
  view.setUint32(18, meta.compressedSize, true);
  view.setUint32(22, meta.size, true);
  view.setUint16(26, meta.nameBytes.length, true);
  view.setUint16(28, 0, true); // no extra field
  return header;
}

/** The central directory record — 46 bytes of header, then the name. */
function centralHeader(meta: EntryMeta): Uint8Array {
  const header = new Uint8Array(46);
  const view = new DataView(header.buffer);
  view.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
  view.setUint16(4, 20, true); // version made by: MS-DOS / FAT, 2.0
  view.setUint16(6, 20, true); // version needed to extract
  view.setUint16(8, FLAG_UTF8, true);
  view.setUint16(10, meta.method, true);
  view.setUint16(12, meta.time, true);
  view.setUint16(14, meta.date, true);
  view.setUint32(16, meta.crc, true);
  view.setUint32(20, meta.compressedSize, true);
  view.setUint32(24, meta.size, true);
  view.setUint16(28, meta.nameBytes.length, true);
  view.setUint16(30, 0, true); // extra field length
  view.setUint16(32, 0, true); // file comment length
  view.setUint16(34, 0, true); // disk number start
  view.setUint16(36, 0, true); // internal file attributes
  view.setUint32(38, 0, true); // external file attributes
  view.setUint32(42, meta.offset, true);
  return header;
}

/** End of central directory: the record that tells a reader where to start. */
function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(4, 0, true); // number of this disk
  view.setUint16(6, 0, true); // disk with the start of the central directory
  view.setUint16(8, count, true); // entries in the central directory on this disk
  view.setUint16(10, count, true); // entries in the central directory, total
  view.setUint32(12, size, true); // size of the central directory
  view.setUint32(16, offset, true); // offset of the central directory
  view.setUint16(20, 0, true); // no archive comment
  return record;
}

/**
 * Emit the archive in ~32 KiB slices rather than as one buffer.
 *
 * A month of a site is tens of megabytes. Holding the whole zip *and* every input
 * blob *and* a second copy of the output at once is how a Worker reaches its
 * memory ceiling, so this generator never accumulates the archive: the caller
 * streams it into R2 and only one input blob is resident at a time. The route
 * writes the bytes and keeps the count, which is why the count is returned rather
 * than measured afterwards.
 */
export async function* buildZipStream(entries: ZipEntry[], options: ZipOptions = {}): AsyncGenerator<Uint8Array> {
  const defaultDos = options.defaultDos ?? DOS_EPOCH;
  const slice = 32 * 1024;

  const central: EntryMeta[] = [];
  /** Total bytes of the archive emitted so far — absolute, as the format requires. */
  let offset = 0;
  let pending: Uint8Array[] = [];
  /** Read position inside `pending[0]`, so a huge blob is never re-sliced. */
  let headAt = 0;
  let pendingBytes = 0;

  /**
   * Hand back at most `slice` bytes and keep the rest queued.
   *
   * Slicing rather than draining-and-returning-everything is the whole point: an
   * input blob can be any size (an R2 body is whatever somebody stored), so a
   * flush that returned the entire pending buffer would hand the caller a 60 MB
   * chunk while claiming to stream. Always returns bytes when there are any, which
   * is what makes the caller's loop terminate.
   */
  const take = (): Uint8Array | undefined => {
    if (pendingBytes === 0) return undefined;
    const out = new Uint8Array(Math.min(slice, pendingBytes));
    let written = 0;
    while (written < out.length) {
      const head = pending[0] as Uint8Array;
      const take_ = Math.min(head.length - headAt, out.length - written);
      out.set(head.subarray(headAt, headAt + take_), written);
      written += take_;
      headAt += take_;
      if (headAt >= head.length) {
        pending.shift();
        headAt = 0;
      }
    }
    pendingBytes -= out.length;
    offset += out.length;
    return out;
  };

  /** Queue bytes, then yield one bounded piece if the window is full. */
  const flush = function* (): Generator<Uint8Array> {
    while (pendingBytes >= slice) {
      const piece = take();
      if (!piece) break;
      yield piece;
    }
  };

  for (const entry of entries) {
    // Defence in depth: names come from `pageEntryName`/`assetEntryName`, both of
    // which sanitise — but a zip whose member escapes its own directory is a
    // security bug in whoever opens it, so it is refused here as well.
    if (entry.name.startsWith("/") || entry.name.split("/").includes("..")) {
      throw new Error(`refusing to write unsafe zip entry name: ${entry.name}`);
    }

    const raw = entry.bytes;
    const deflated =
      entry.deflated !== undefined ? entry.deflated : options.deflate ? await options.deflate(raw) : undefined;
    const method = deflated === undefined ? ZIP_STORED : ZIP_DEFLATE;
    const stored = deflated ?? raw;

    const dos =
      entry.dosTime !== undefined && entry.dosDate !== undefined
        ? { time: entry.dosTime, date: entry.dosDate }
        : defaultDos;
    const nameBytes = textEncoder.encode(entry.name);
    const meta: EntryMeta = {
      nameBytes,
      time: dos.time,
      date: dos.date,
      crc: crc32(raw),
      compressedSize: stored.length,
      size: raw.length,
      method,
      offset,
    };

    // The header, the name and the payload are queued and drained through the
    // 32 KiB window, so one member never becomes a single unbounded allocation.
    // The `offset` is advanced by what was *queued*, not by what happened to be
    // emitted in this pass — they are the same number, but only one of them is the
    // truth the central directory needs.
    for (const chunk of [localHeader(meta), nameBytes, stored]) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      yield* flush();
    }
    central.push(meta);
    offset += 30 + nameBytes.length + stored.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const meta of central) {
    const record = centralHeader(meta);
    centralSize += record.length + meta.nameBytes.length;
    for (const chunk of [record, meta.nameBytes]) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      yield* flush();
    }
  }

  // The EOCD is the last record in the file and the first thing a reader looks
  // for, so it is flushed unconditionally rather than waiting for a full window.
  pending.push(endOfCentralDirectory(central.length, centralSize, centralOffset));
  pendingBytes += pending[pending.length - 1]?.length ?? 0;
  for (;;) {
    const piece = take();
    if (!piece) break;
    yield piece;
  }
}

/** The whole archive as one buffer. Convenience for tests and small exports. */
export async function buildZip(entries: ZipEntry[], options: ZipOptions = {}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of buildZipStream(entries, options)) chunks.push(chunk);
  return concat(chunks);
}
