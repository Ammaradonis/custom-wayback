/**
 * HTML rewriting for the cloud ingest path.
 *
 * The output contract is identical to the local runner's
 * (`apps/crawler-local/src/rewrite.ts`) because the viewer Worker and the PWA
 * already depend on it:
 *
 *   - every asset URL points at our immutable content-addressed route `/assets/<hh>/<hash>`
 *   - every internal link points at `/a/<domain>/<day>/<path>`, annotated with
 *     `data-cw-delta` when the resolved day is not the day being viewed
 *   - unresolvable internal links keep their text but lose `href`, gaining
 *     `data-cw-dead` and `.cw-dead-link` so the shell can explain them
 *   - dead third-party scripts become inert `text/plain` markers
 *   - base, meta-refresh, and form actions are neutralised; a runtime shim is
 *     injected first in `<head>`
 *
 * It differs in *how* it is done: the local runner parses with linkedom in Node,
 * this one parses with linkedom's Workers build. Both are the same DOM API, so
 * the same code shape works in both places.
 */

import { RUNTIME_CSS, RUNTIME_SCRIPT, RUNTIME_SCRIPT_ID, RUNTIME_STYLE_ID } from "@custom-wayback/pipeline";

// linkedom's types are wide; this is the subset we use, kept explicit so a
// linkedom upgrade cannot silently change what we depend on.
interface El {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
  replaceWith(node: unknown): void;
  insertBefore(node: unknown, ref: unknown): void;
  appendChild(node: unknown): void;
  /** Readable and writable: the rewrite pass replaces <style> contents. */
  textContent: string | null;
  readonly firstChild: unknown;
  readonly classList: { add(name: string): void };
}

interface Doc {
  querySelectorAll(selector: string): ArrayLike<El>;
  querySelector(selector: string): El | null;
  createElement(tag: string): El;
  readonly head: El | null;
  readonly documentElement: El | null;
  toString(): string;
}

// ── URL helpers (mirrors of urlutil.ts, dependency-free) ─────────────────────

const TRACKING = [/^utm_/i, /^gclid$/i, /^fbclid$/i, /^mc_(cid|eid)$/i, /^_ga$/i, /^ref$/i, /^igshid$/i];

export function canonicalize(input: string, base?: string): string | undefined {
  try {
    const u = new URL(input, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
    const keep: [string, string][] = [];
    for (const [k, v] of u.searchParams) if (!TRACKING.some((re) => re.test(k))) keep.push([k, v]);
    u.search = "";
    for (const [k, v] of keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) u.searchParams.append(k, v);
    if (u.pathname === "") u.pathname = "/";
    return u.toString();
  } catch {
    return undefined;
  }
}

const TWO_LEVEL_TLDS = new Set(["co.uk", "com.au", "co.jp", "com.br", "co.kr", "com.cn", "co.in"]);

function registrable(host: string): string {
  const parts = host.toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return TWO_LEVEL_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function sameSite(a: string, b: string): boolean {
  return registrable(hostOf(a)) === registrable(hostOf(b));
}

/** `/a/samsung.com/2024-03-15/phones/` — query strings are percent-encoded into the path. */
export function snapshotPath(domain: string, day: string, originalUrl: string): string {
  const url = new URL(originalUrl);
  let path = url.pathname;
  if (!path.startsWith("/")) path = `/${path}`;
  const suffix = url.search ? `%3F${encodeURIComponent(url.search.slice(1))}` : "";
  return `/a/${domain}/${day}${path}${suffix}`;
}

export function assetPath(hash: string): string {
  return `/assets/${hash.slice(0, 2)}/${hash}`;
}

const STUB_SCRIPT_HOSTS: RegExp[] = [
  /google-analytics\.com$/i, /googletagmanager\.com$/i, /googletagservices\.com$/i, /doubleclick\.net$/i,
  /googleadservices\.com$/i, /googlesyndication\.com$/i, /facebook\.(net|com)$/i, /hotjar\.com$/i,
  /mouseflow\.com$/i, /crazyegg\.com$/i, /optimizely\.com$/i, /segment\.(io|com)$/i, /mixpanel\.com$/i,
  /amplitude\.com$/i, /newrelic\.com$/i, /nr-data\.net$/i, /sentry-cdn\.com$/i, /quantserve\.com$/i,
  /scorecardresearch\.com$/i, /adnxs\.com$/i, /criteo\.(com|net)$/i, /taboola\.com$/i, /outbrain\.com$/i,
  /chartbeat\.(com|net)$/i, /parsely\.com$/i, /tealiumiq\.com$/i, /demdex\.net$/i, /omtrdc\.net$/i,
  /2o7\.net$/i, /bluekai\.com$/i, /krxd\.net$/i, /bat\.bing\.com$/i, /clarity\.ms$/i, /yieldmo\.com$/i,
  /sharethrough\.com$/i, /moatads\.com$/i, /adsafeprotected\.com$/i, /serving-sys\.com$/i,
  /flashtalking\.com$/i, /mathtag\.com$/i, /turn\.com$/i, /rubiconproject\.com$/i, /pubmatic\.com$/i,
  /openx\.net$/i, /indexww\.com$/i, /casalemedia\.com$/i,
];

export function shouldStubScript(urlStr: string): boolean {
  const host = hostOf(urlStr);
  return host ? STUB_SCRIPT_HOSTS.some((re) => re.test(host)) : false;
}

const LAZY_ATTRS = [
  "data-src", "data-original", "data-lazy-src", "data-srcset", "data-lazy-srcset",
  "data-original-src", "data-image",
];

const URL_IN_CSS = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const IMPORT_IN_CSS = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function isRewritable(url: string): boolean {
  if (!url) return false;
  const t = url.trim();
  if (t.startsWith("data:") || t.startsWith("blob:") || t.startsWith("javascript:") || t.startsWith("#")) return false;
  return t !== "about:blank";
}

function cssUrls(css: string): string[] {
  const out = new Set<string>();
  for (const m of css.matchAll(URL_IN_CSS)) if (m[2]) out.add(decodeEntities(m[2]).trim());
  for (const m of css.matchAll(IMPORT_IN_CSS)) {
    const raw = m[2] ?? m[4];
    if (raw) out.add(decodeEntities(raw).trim());
  }
  return [...out].filter(isRewritable);
}

function rewriteCss(css: string, pageUrl: string, assetMap: Map<string, string>): string {
  const resolve = (raw: string): string | undefined => {
    const decoded = decodeEntities(raw).trim();
    if (!isRewritable(decoded)) return undefined;
    const canonical = canonicalize(decoded, pageUrl);
    return canonical ? assetMap.get(canonical) : undefined;
  };
  let out = css.replace(URL_IN_CSS, (whole, quote: string, raw: string) => {
    const mapped = resolve(raw ?? "");
    if (!mapped) return whole;
    const q = quote || '"';
    return `url(${q}${mapped}${q})`;
  });
  out = out.replace(IMPORT_IN_CSS, (whole, _q1: string, raw1: string, _q2: string, raw2: string) => {
    const raw = raw1 ?? raw2;
    if (!raw) return whole;
    const mapped = resolve(raw);
    return mapped ? `@import url("${mapped}")` : whole;
  });
  return out;
}

function rewriteSrcset(value: string, pageUrl: string, assetMap: Map<string, string>): string {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawUrl, ...descriptor] = part.split(/\s+/);
      if (!rawUrl) return part;
      const canonical = canonicalize(decodeEntities(rawUrl), pageUrl);
      const mapped = canonical ? assetMap.get(canonical) : undefined;
      return [mapped ?? rawUrl, ...descriptor].join(" ");
    })
    .join(", ");
}

// ── Reference extraction ─────────────────────────────────────────────────────

/**
 * Every asset URL a page references, in priority order (images, stylesheets,
 * fonts, kept scripts). Called before anything is fetched, so the caller can
 * fetch each unique URL exactly once and build the asset map.
 */
export function extractReferences(document: Doc, pageUrl: string): { assets: string[]; links: string[] } {
  const assets = new Map<string, true>();
  const links = new Map<string, true>();

  const add = (raw: string | null | undefined): void => {
    if (!raw) return;
    const decoded = decodeEntities(raw).trim();
    if (!isRewritable(decoded)) return;
    const canonical = canonicalize(decoded, pageUrl);
    if (canonical) assets.set(canonical, true);
  };

  for (const img of Array.from(document.querySelectorAll("img"))) {
    add(img.getAttribute("src"));
    for (const attr of LAZY_ATTRS) {
      const value = img.getAttribute(attr);
      if (!value) continue;
      if (attr.endsWith("srcset")) for (const part of value.split(",")) add(part.trim().split(/\s+/)[0]);
      else add(value);
    }
    const srcset = img.getAttribute("srcset");
    if (srcset) for (const part of srcset.split(",")) add(part.trim().split(/\s+/)[0]);
  }
  for (const source of Array.from(document.querySelectorAll("source"))) {
    const srcset = source.getAttribute("srcset");
    if (srcset) for (const part of srcset.split(",")) add(part.trim().split(/\s+/)[0]);
    add(source.getAttribute("src"));
  }
  for (const el of Array.from(document.querySelectorAll("link"))) {
    const rel = (el.getAttribute("rel") ?? "").toLowerCase();
    const href = el.getAttribute("href");
    if (!href) continue;
    if (rel.includes("stylesheet") || rel.includes("icon") || rel.includes("preload") || rel.includes("mask-icon")) {
      add(href);
    }
  }
  for (const el of Array.from(document.querySelectorAll("script"))) {
    const src = el.getAttribute("src");
    if (src && !shouldStubScript(src)) add(src);
  }
  for (const el of Array.from(document.querySelectorAll("video, audio"))) {
    add(el.getAttribute("src"));
    add(el.getAttribute("poster"));
  }
  for (const el of Array.from(document.querySelectorAll("video source, audio source, track, embed"))) {
    add(el.getAttribute("src"));
  }
  // CSS can hide the real images: url() inside <style> and inline style attributes.
  for (const el of Array.from(document.querySelectorAll("style"))) {
    for (const url of cssUrls(el.textContent ?? "")) add(url);
  }
  for (const el of Array.from(document.querySelectorAll("[style]"))) {
    const style = el.getAttribute("style");
    if (style) for (const url of cssUrls(style)) add(url);
  }

  // In-site links, collected up front so the caller can resolve them all in one
  // pass against the frozen day index instead of querying per link.
  for (const a of Array.from(document.querySelectorAll("a"))) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const decoded = decodeEntities(href).trim();
    if (!isRewritable(decoded)) continue;
    const canonical = canonicalize(decoded, pageUrl);
    if (!canonical) continue;
    if (sameSite(canonical, pageUrl)) links.set(canonical, true);
  }

  return { assets: [...assets.keys()], links: [...links.keys()] };
}

// ── The rewrite pass ─────────────────────────────────────────────────────────

export interface RewriteContext {
  domain: string;
  day: string;
  pageUrl: string;
  /** original asset URL → our content-addressed route. */
  assetMap: Map<string, string>;
  /** original page URL → the day we can actually serve it for. */
  linkMap: Map<string, { day: string; deltaDays: number }>;
}

export interface PageRewriteResult {
  html: string;
  internalLinks: string[];
  deadLinks: string[];
  missingAssets: number;
  stubbedScripts: number;
}

export function rewriteHtml(document: Doc, ctx: RewriteContext): PageRewriteResult {
  const missing = new Set<string>();
  const internalLinks = new Set<string>();
  const deadLinks = new Set<string>();
  let stubbedScripts = 0;

  const mapAsset = (raw: string | null | undefined): string | undefined => {
    if (!raw) return undefined;
    const decoded = decodeEntities(raw).trim();
    if (!isRewritable(decoded)) return undefined;
    const canonical = canonicalize(decoded, ctx.pageUrl);
    if (!canonical) return undefined;
    const mapped = ctx.assetMap.get(canonical);
    if (!mapped) missing.add(canonical);
    return mapped;
  };

  // ---- head hygiene -------------------------------------------------------
  for (const el of Array.from(document.querySelectorAll("base"))) el.remove();
  for (const el of Array.from(document.querySelectorAll("meta[http-equiv]"))) {
    if ((el.getAttribute("http-equiv") ?? "").toLowerCase() === "refresh") el.remove();
  }
  for (const el of Array.from(document.querySelectorAll('meta[name="robots"]'))) el.remove();

  const head = document.head ?? document.createElement("head");
  if (!document.head && document.documentElement) {
    document.documentElement.insertBefore(head, document.documentElement.firstChild);
  }
  if (document.documentElement) {
    // Re-running the rewriter must not stack chrome (a re-ingest would otherwise
    // inject a second runtime script and a second shim block).
    for (const id of [RUNTIME_SCRIPT_ID, RUNTIME_STYLE_ID]) {
      for (const stale of Array.from(document.querySelectorAll(`#${id}`))) stale.remove();
    }

    const base = document.createElement("base");
    base.setAttribute("href", "/");
    head.insertBefore(base, head.firstChild);

    const robots = document.createElement("meta");
    robots.setAttribute("name", "robots");
    robots.setAttribute("content", "noindex,nofollow,noarchive");
    head.appendChild(robots);

    const style = document.createElement("style");
    style.setAttribute("id", RUNTIME_STYLE_ID);
    style.textContent = RUNTIME_CSS;
    head.appendChild(style);

    const meta = document.createElement("meta");
    meta.setAttribute("name", "cw-mirror");
    meta.setAttribute("content", JSON.stringify({ day: ctx.day, url: ctx.pageUrl }));
    head.appendChild(meta);

    // Runtime goes in first so the shims exist before any archived script runs.
    const script = document.createElement("script");
    script.setAttribute("id", RUNTIME_SCRIPT_ID);
    script.textContent = RUNTIME_SCRIPT;
    head.insertBefore(script, head.firstChild);
  }

  // ---- images -------------------------------------------------------------
  for (const img of Array.from(document.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    let mapped = mapAsset(src);
    if (!mapped) {
      // Lazy-loading pages hide the real URL in data-* attributes; if the
      // primary src is missing, promote a lazy candidate so the image appears.
      for (const attr of LAZY_ATTRS) {
        if (attr.endsWith("srcset")) continue;
        const candidate = mapAsset(img.getAttribute(attr));
        if (candidate) {
          mapped = candidate;
          break;
        }
      }
    }
    if (mapped) img.setAttribute("src", mapped);
    else if (src && isRewritable(decodeEntities(src).trim())) img.setAttribute("data-cw-missing", "src");

    for (const attr of LAZY_ATTRS) {
      const value = img.getAttribute(attr);
      if (!value) continue;
      if (attr.endsWith("srcset")) img.setAttribute(attr, rewriteSrcset(value, ctx.pageUrl, ctx.assetMap));
      else {
        const candidate = mapAsset(value);
        if (candidate) img.setAttribute(attr, candidate);
      }
    }
    const srcset = img.getAttribute("srcset");
    if (srcset) img.setAttribute("srcset", rewriteSrcset(srcset, ctx.pageUrl, ctx.assetMap));
    img.removeAttribute("crossorigin");
  }

  for (const source of Array.from(document.querySelectorAll("source"))) {
    const srcset = source.getAttribute("srcset");
    if (srcset) source.setAttribute("srcset", rewriteSrcset(srcset, ctx.pageUrl, ctx.assetMap));
    const mapped = mapAsset(source.getAttribute("src"));
    if (mapped) source.setAttribute("src", mapped);
  }

  // ---- stylesheets --------------------------------------------------------
  for (const el of Array.from(document.querySelectorAll("link"))) {
    const rel = (el.getAttribute("rel") ?? "").toLowerCase();
    const href = el.getAttribute("href");
    if (!href) continue;
    const relevant =
      rel.includes("stylesheet") || rel.includes("icon") || rel.includes("apple-touch-icon") ||
      rel.includes("mask-icon") || rel.includes("preload");
    if (!relevant) continue;
    const mapped = mapAsset(href);
    if (mapped) {
      el.setAttribute("href", mapped);
      el.removeAttribute("crossorigin");
    } else if (rel.includes("stylesheet")) {
      el.remove(); // a 404ing stylesheet blocks render; gone is better
    }
  }

  // ---- scripts ------------------------------------------------------------
  for (const el of Array.from(document.querySelectorAll("script"))) {
    const src = el.getAttribute("src");
    if (!src) continue; // inline script: kept as-is
    const decoded = decodeEntities(src).trim();
    const stub = (value: string, attribute: string): void => {
      const marker = document.createElement("script");
      marker.setAttribute("type", "text/plain");
      marker.setAttribute(attribute, value);
      marker.setAttribute("class", "cw-stub");
      el.replaceWith(marker);
    };
    if (shouldStubScript(decoded)) {
      stub(decoded, "data-cw-stub");
      stubbedScripts += 1;
      continue;
    }
    const mapped = mapAsset(src);
    if (mapped) {
      el.setAttribute("src", mapped);
      el.removeAttribute("crossorigin");
      el.removeAttribute("integrity"); // the hash no longer matches after rewriting
    } else {
      stub(decoded, "data-cw-missing");
    }
  }

  // ---- inline CSS ---------------------------------------------------------
  for (const el of Array.from(document.querySelectorAll("[style]"))) {
    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", rewriteCss(style, ctx.pageUrl, ctx.assetMap));
  }
  for (const el of Array.from(document.querySelectorAll("style"))) {
    const text = el.textContent ?? "";
    if (text && !text.includes(RUNTIME_CSS.trim().slice(0, 24))) {
      el.textContent = rewriteCss(text, ctx.pageUrl, ctx.assetMap);
    }
  }

  // ---- media --------------------------------------------------------------
  for (const el of Array.from(document.querySelectorAll("video, audio, embed, iframe"))) {
    const mapped = mapAsset(el.getAttribute("src"));
    if (mapped) el.setAttribute("src", mapped);
  }
  for (const el of Array.from(document.querySelectorAll("video, audio"))) {
    const mapped = mapAsset(el.getAttribute("poster"));
    if (mapped) el.setAttribute("poster", mapped);
  }

  // ---- links --------------------------------------------------------------
  for (const a of Array.from(document.querySelectorAll("a"))) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const decoded = decodeEntities(href).trim();
    if (!isRewritable(decoded)) continue;
    const canonical = canonicalize(decoded, ctx.pageUrl);
    if (!canonical) continue;

    if (!sameSite(canonical, ctx.pageUrl)) {
      a.setAttribute("href", canonical);
      a.setAttribute("rel", "noopener noreferrer nofollow");
      a.setAttribute("target", "_blank");
      a.setAttribute("data-cw-external", "1");
      continue;
    }

    internalLinks.add(canonical);
    const resolved = ctx.linkMap.get(canonical);
    if (resolved) {
      a.setAttribute("href", snapshotPath(ctx.domain, resolved.day, canonical));
      if (resolved.deltaDays !== 0) {
        a.setAttribute("data-cw-delta", String(resolved.deltaDays));
        a.setAttribute(
          "title",
          `captured ${Math.abs(resolved.deltaDays)} day(s) ${resolved.deltaDays < 0 ? "earlier" : "later"}`,
        );
      }
      a.removeAttribute("target");
      continue;
    }

    // No capture anywhere in range: keep the text, drop the link, mark it.
    a.removeAttribute("href");
    a.setAttribute("data-cw-dead", canonical);
    a.setAttribute("title", "not captured in the archived range");
    a.classList.add("cw-dead-link");
    deadLinks.add(canonical);
  }

  // ---- forms must not post into the live internet -------------------------
  for (const form of Array.from(document.querySelectorAll("form"))) {
    form.setAttribute("data-cw-action", form.getAttribute("action") ?? "");
    form.removeAttribute("action");
    form.setAttribute("onsubmit", "return false");
    form.setAttribute("data-cw-disabled", "1");
  }

  // ---- legacy plugin content ---------------------------------------------
  for (const el of Array.from(document.querySelectorAll("object, param"))) el.remove();

  // Written last: the counts are only known now, and the runtime forwards them
  // to the shell so it can show "3 dead links, 12 missing images".
  const mirrorMeta = document.querySelector('meta[name="cw-mirror"]');
  if (mirrorMeta) {
    mirrorMeta.setAttribute(
      "content",
      JSON.stringify({
        day: ctx.day,
        url: ctx.pageUrl,
        flags: {
          deadLinks: deadLinks.size,
          missingAssets: missing.size,
          stubbedScripts,
        },
      }),
    );
  }

  const serialized = document.toString();
  const html =
    serialized.startsWith("<!DOCTYPE") || serialized.startsWith("<!doctype")
      ? serialized
      : `<!DOCTYPE html>\n${serialized}`;

  return {
    html,
    internalLinks: [...internalLinks],
    deadLinks: [...deadLinks],
    missingAssets: missing.size,
    stubbedScripts,
  };
}

export { assetPath as toAssetPath };
