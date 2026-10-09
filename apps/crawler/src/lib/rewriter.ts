/**
 * HTML rewriter + asset extractor (§6.4 of plan.md).
 *
 * Runs once at ingest. Uses Cheerio (DOM-convenient, not streaming —
 * acceptable in the crawler process; Workers use HTMLRewriter at serve time).
 *
 * Steps:
 *  1. De-toolbar  — nothing to do: id_ gives raw bytes.
 *  2. De-base     — remove original <base>, inject ours.
 *  3. Asset rewrite — src/href/srcset/url() → /a/:domain/:day/<hash>
 *  4. Link remap  — internal links → /a/:domain/:day/<path>
 *  5. Script triage — stub analytics / ads / dead CDNs.
 *  6. Shim injection — no-op window.ga, gtag, fbq, dataLayer stubs.
 *  7. Error shield  — global onerror swallow.
 *  8. CSP meta    — strict CSP meta tag.
 */

import * as cheerio from "cheerio";
import * as crypto from "node:crypto";

export interface RewriteResult {
  html: string;
  /** Unique asset references discovered (original URL → wayback ts). */
  assets: Array<{ url: string; ts: string; hash?: string }>;
  /** Internal links discovered (original URL). */
  links: string[];
}

const STUB_SCRIPTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "connect.facebook.net",
  "bat.bing.com",
  "cdn.mouseflow.com",
  "hotjar.com",
  "doubleclick.net",
  "googlesyndication.com",
  "adnxs.com",
  "quantserve.com",
];

const SHIMS = `
<script>
(function(){
  var noop=function(){};
  window.ga=noop; window._gaq={push:noop};
  window.gtag=noop; window.dataLayer=window.dataLayer||{push:noop};
  window.fbq=noop; window._fbq=noop;
  window.onerror=function(){return true;};
  window.addEventListener('unhandledrejection',function(e){e.preventDefault();});
})();
</script>`;

const CSP_META = `<meta http-equiv="Content-Security-Policy"
  content="default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self';">`;

/**
 * Rewrite an HTML page for our viewer.
 *
 * @param html     Raw HTML from id_ fetch.
 * @param domain   e.g. "samsung.com"
 * @param day      e.g. "2024-03-15"
 * @param ts       14-digit Wayback timestamp for asset resolution.
 * @param pageUrl  Original absolute URL of the page.
 */
export function rewritePage(
  html: string,
  domain: string,
  day: string,
  ts: string,
  pageUrl: string,
): RewriteResult {
  const $ = cheerio.load(html, { decodeEntities: false });
  const assets: RewriteResult["assets"] = [];
  const links: string[] = [];
  const seenAssets = new Set<string>();
  const seenLinks = new Set<string>();

  const pageOrigin = new URL(pageUrl).origin;
  const baseRewritePrefix = `/a/${domain}/${day}`;

  // ── 1. Remove existing <base> tags ────────────────────────────────────────
  $("base").remove();
  $("head").prepend(`<base href="${baseRewritePrefix}/">`);
  $("head").prepend(CSP_META);

  // ── 2. Script triage ──────────────────────────────────────────────────────
  $("script[src]").each((_i, el) => {
    const src = $(el).attr("src") ?? "";
    if (STUB_SCRIPTS.some((s) => src.includes(s))) {
      $(el).remove();
    }
  });

  // Remove tracking pixels and beacon img tags.
  $("img[src]").each((_i, el) => {
    const src = $(el).attr("src") ?? "";
    if (STUB_SCRIPTS.some((s) => src.includes(s))) {
      $(el).remove();
    }
  });

  // ── 3. Shim injection ─────────────────────────────────────────────────────
  $("head").prepend(SHIMS);

  // ── 4. Asset rewrite (src, href for CSS/images/fonts, srcset) ─────────────
  const rewriteUrl = (raw: string | undefined): string | undefined => {
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("#")) {
      return raw;
    }
    let absolute: URL;
    try {
      absolute = raw.startsWith("//")
        ? new URL(`https:${raw}`)
        : new URL(raw, pageOrigin);
    } catch {
      return raw;
    }

    const urlStr = absolute.toString();
    if (!seenAssets.has(urlStr)) {
      seenAssets.add(urlStr);
      assets.push({ url: urlStr, ts });
    }
    const hash = sha256Short(urlStr);
    // Asset path: /a/:domain/:day/assets/<hash>
    return `${baseRewritePrefix}/assets/${hash}`;
  };

  // Images.
  $("img[src]").each((_i, el) => {
    const rewritten = rewriteUrl($(el).attr("src"));
    if (rewritten) $(el).attr("src", rewritten);

    const srcset = $(el).attr("srcset");
    if (srcset) $(el).attr("srcset", rewriteSrcset(srcset, rewriteUrl));
  });

  // Link tags (CSS, favicons).
  $("link[href]").each((_i, el) => {
    const rel = $(el).attr("rel") ?? "";
    if (rel.includes("stylesheet") || rel.includes("icon") || rel.includes("preload")) {
      const rewritten = rewriteUrl($(el).attr("href"));
      if (rewritten) $(el).attr("href", rewritten);
    }
  });

  // Script src.
  $("script[src]").each((_i, el) => {
    const rewritten = rewriteUrl($(el).attr("src"));
    if (rewritten) $(el).attr("src", rewritten);
  });

  // Video / audio source.
  $("source[src]").each((_i, el) => {
    const rewritten = rewriteUrl($(el).attr("src"));
    if (rewritten) $(el).attr("src", rewritten);
  });

  // ── 5. Internal link remap ────────────────────────────────────────────────
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;

    let absolute: URL;
    try {
      absolute = href.startsWith("//")
        ? new URL(`https:${href}`)
        : new URL(href, pageOrigin);
    } catch {
      return;
    }

    const isInternal =
      absolute.hostname === new URL(pageOrigin).hostname ||
      absolute.hostname.endsWith(`.${domain}`);

    if (isInternal) {
      const originalPath = absolute.pathname + absolute.search;
      if (!seenLinks.has(absolute.toString())) {
        seenLinks.add(absolute.toString());
        links.push(absolute.toString());
      }
      $(el).attr("href", `${baseRewritePrefix}${originalPath}`);
    } else {
      // External — open in new tab to escape the sandbox.
      $(el).attr("target", "_blank").attr("rel", "noopener noreferrer");
    }
  });

  return { html: $.html(), assets, links };
}

/** Rewrite a srcset attribute, applying rewriteUrl to each URL component. */
function rewriteSrcset(
  srcset: string,
  rewriteUrl: (u: string | undefined) => string | undefined,
): string {
  return srcset
    .split(",")
    .map((part) => {
      const [url, descriptor] = part.trim().split(/\s+/);
      const rewritten = rewriteUrl(url);
      return descriptor ? `${rewritten} ${descriptor}` : (rewritten ?? "");
    })
    .join(", ");
}

function sha256Short(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}
