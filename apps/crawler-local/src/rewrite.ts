/**
 * HTML rewriter. Runs once per page at ingest, never at read time.
 *
 * Everything here exists to make an archived page behave like a normal page inside
 * our shell:
 *   - all assets point at our content-addressed cache
 *   - internal links point at our snapshot routes, annotated with how far the resolved
 *     capture is from the day being viewed ("2 days earlier")
 *   - dead third-party scripts are stubbed instead of fetched
 *   - links with no capture anywhere are visibly marked instead of silently 404ing
 *   - form posts and meta refreshes cannot fire into the live internet
 */

import { parseHTML } from 'linkedom';
import {
  assetPath,
  canonicalize,
  extensionOf,
  sameSite,
  shouldStubScript,
  snapshotPath,
  IMAGE_EXT,
  STYLE_EXT,
  SCRIPT_EXT,
  FONT_EXT,
  RUNTIME_CSS,
  RUNTIME_SCRIPT,
  RUNTIME_SCRIPT_ID,
  RUNTIME_STYLE_ID,
} from '@custom-wayback/pipeline';

export type AssetRole = 'image' | 'stylesheet' | 'script' | 'font' | 'media' | 'other';

export interface AssetRequest {
  url: string;
  role: AssetRole;
}

export interface ExtractedPage {
  title: string;
  lang: string;
  assets: AssetRequest[];
  inlineCss: string[];
  internalLinks: string[];
}

export interface LinkResolutionInfo {
  targetUrl: string;
  day: string;
  deltaDays: number;
  ts: string;
}

export interface RewriteContext {
  domain: string;
  day: string;
  pageUrl: string;
  seedOrigin: string;
  /** original asset URL -> our cachable path. Absent = we do not have the bytes. */
  assetMap: Map<string, string>;
  /** original page URL -> resolved capture. Absent = never captured in range. */
  linkMap: Map<string, LinkResolutionInfo>;
  lazyAttrs?: string[];
}

export interface RewriteResult {
  html: string;
  title: string;
  lang: string;
  missingAssets: string[];
  internalLinks: string[];
  externalLinks: number;
  stubbedScripts: string[];
  keptScripts: number;
  strippedNodes: number;
  deadLinks: string[];
}

const DEFAULT_LAZY_ATTRS = [
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-srcset',
  'data-lazy-srcset',
  'data-original-src',
  'data-image',
];

const URL_IN_CSS = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const IMPORT_IN_CSS = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function isRewritable(url: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) return false;
  if (trimmed.startsWith('#')) return false;
  if (trimmed === 'about:blank') return false;
  return true;
}

export function roleFor(url: string, hint?: AssetRole): AssetRole {
  if (hint) return hint;
  const ext = extensionOf(url);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (STYLE_EXT.has(ext)) return 'stylesheet';
  if (SCRIPT_EXT.has(ext)) return 'script';
  if (FONT_EXT.has(ext)) return 'font';
  return 'other';
}

/**
 * Extract every asset reference and internal link from a page, before fetching.
 * The caller uses this to fetch assets and build the assetMap, which makes the
 * rewrite pass synchronous and single-shot.
 */
export function extractPage(
  html: string,
  pageUrl: string,
  lazyAttrs: string[] = DEFAULT_LAZY_ATTRS,
): ExtractedPage {
  const { document } = parseHTML(html);
  const assets = new Map<string, AssetRequest>();
  const inlineCss: string[] = [];
  const internalLinks = new Set<string>();

  const addAsset = (raw: string | null | undefined, hint?: AssetRole): void => {
    if (!raw) return;
    const decoded = decodeEntities(raw).trim();
    if (!isRewritable(decoded)) return;
    const canonical = canonicalize(decoded, pageUrl);
    if (!canonical) return;
    if (!assets.has(canonical)) assets.set(canonical, { url: canonical, role: roleFor(canonical, hint) });
  };

  for (const img of document.querySelectorAll('img')) {
    addAsset(img.getAttribute('src'), 'image');
    for (const attr of lazyAttrs) {
      const value = img.getAttribute(attr);
      if (!value) continue;
      if (attr.endsWith('srcset')) {
        for (const part of value.split(',')) addAsset(part.trim().split(/\s+/)[0], 'image');
      } else {
        addAsset(value, 'image');
      }
    }
    const srcset = img.getAttribute('srcset');
    if (srcset) for (const part of srcset.split(',')) addAsset(part.trim().split(/\s+/)[0], 'image');
    const style = img.getAttribute('style');
    if (style) inlineCss.push(style);
  }
  for (const source of document.querySelectorAll('source')) {
    const srcset = source.getAttribute('srcset');
    if (srcset) for (const part of srcset.split(',')) addAsset(part.trim().split(/\s+/)[0], 'image');
    addAsset(source.getAttribute('src'), 'media');
  }
  for (const el of document.querySelectorAll('link')) {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase();
    const href = el.getAttribute('href');
    if (!href) continue;
    if (rel.includes('stylesheet')) addAsset(href, 'stylesheet');
    else if (rel.includes('icon') || rel.includes('apple-touch-icon') || rel.includes('mask-icon')) addAsset(href, 'image');
    else if (rel.includes('preload')) addAsset(href, roleFor(href));
  }
  for (const el of document.querySelectorAll('script')) {
    const src = el.getAttribute('src');
    if (!src) continue;
    if (shouldStubScript(src)) continue; // will be stubbed, never fetched
    addAsset(src, 'script');
  }
  for (const el of document.querySelectorAll('video, audio')) {
    addAsset(el.getAttribute('src'), 'media');
    addAsset(el.getAttribute('poster'), 'image');
  }
  for (const el of document.querySelectorAll('video source, audio source, track, embed')) {
    addAsset(el.getAttribute('src'), 'media');
  }
  for (const el of document.querySelectorAll('[style]')) {
    const style = el.getAttribute('style');
    if (style) inlineCss.push(style);
  }
  for (const el of document.querySelectorAll('style')) {
    const text = el.textContent ?? '';
    if (text) inlineCss.push(text);
  }
  for (const css of inlineCss) {
    for (const url of cssUrls(css)) addAsset(url);
  }

  for (const a of document.querySelectorAll('a')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const decoded = decodeEntities(href).trim();
    if (!isRewritable(decoded)) continue;
    const canonical = canonicalize(decoded, pageUrl);
    if (!canonical) continue;
    if (sameSite(canonical, pageUrl)) internalLinks.add(canonical);
  }

  return {
    title: (document.querySelector('title')?.textContent ?? '').trim().slice(0, 300),
    lang: document.documentElement?.getAttribute('lang') ?? '',
    assets: [...assets.values()],
    inlineCss,
    internalLinks: [...internalLinks],
  };
}

/** Extract every url() / @import target from a CSS string. */
export function cssUrls(css: string): string[] {
  const out = new Set<string>();
  for (const match of css.matchAll(URL_IN_CSS)) {
    const raw = match[2];
    if (raw) out.add(decodeEntities(raw).trim());
  }
  for (const match of css.matchAll(IMPORT_IN_CSS)) {
    const raw = match[2] ?? match[4];
    if (raw) out.add(decodeEntities(raw).trim());
  }
  return [...out].filter(isRewritable);
}

/** Rewrite url() and @import targets inside a CSS string using the asset map. */
export function rewriteCss(css: string, pageUrl: string, assetMap: Map<string, string>): string {
  const resolve = (raw: string): string | undefined => {
    const decoded = decodeEntities(raw).trim();
    if (!isRewritable(decoded)) return undefined;
    const canonical = canonicalize(decoded, pageUrl);
    if (!canonical) return undefined;
    return assetMap.get(canonical);
  };

  let out = css.replace(URL_IN_CSS, (whole, quote: string, raw: string) => {
    const mapped = resolve(raw ?? '');
    if (!mapped) return whole;
    const q = quote || '"';
    return `url(${q}${mapped}${q})`;
  });

  out = out.replace(IMPORT_IN_CSS, (whole, _q1: string, raw1: string, _q2: string, raw2: string) => {
    const raw = raw1 ?? raw2;
    if (!raw) return whole;
    const mapped = resolve(raw);
    if (!mapped) return whole;
    return `@import url("${mapped}")`;
  });

  return out;
}

function rewriteSrcset(value: string, pageUrl: string, assetMap: Map<string, string>): string {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawUrl, ...descriptor] = part.split(/\s+/);
      if (!rawUrl) return part;
      const canonical = canonicalize(decodeEntities(rawUrl), pageUrl);
      const mapped = canonical ? assetMap.get(canonical) : undefined;
      return [mapped ?? rawUrl, ...descriptor].join(' ');
    })
    .join(', ');
}

/** Rewrite the page. `assetMap` and `linkMap` must already be resolved by the caller. */
export function rewritePage(html: string, ctx: RewriteContext): RewriteResult {
  const { document } = parseHTML(html);
  const lazyAttrs = ctx.lazyAttrs ?? DEFAULT_LAZY_ATTRS;
  const missingAssets = new Set<string>();
  const internalLinks = new Set<string>();
  const deadLinks = new Set<string>();
  const stubbedScripts: string[] = [];
  let externalLinks = 0;
  let keptScripts = 0;
  let strippedNodes = 0;

  const mapAsset = (raw: string | null | undefined): string | undefined => {
    if (!raw) return undefined;
    const decoded = decodeEntities(raw).trim();
    if (!isRewritable(decoded)) return undefined;
    const canonical = canonicalize(decoded, ctx.pageUrl);
    if (!canonical) return undefined;
    const mapped = ctx.assetMap.get(canonical);
    if (!mapped) {
      missingAssets.add(canonical);
      return undefined;
    }
    return mapped;
  };

  // ---- head hygiene ----
  for (const el of document.querySelectorAll('base')) {
    el.remove();
    strippedNodes += 1;
  }
  for (const el of document.querySelectorAll('meta[http-equiv]')) {
    if ((el.getAttribute('http-equiv') ?? '').toLowerCase() === 'refresh') {
      el.remove(); // a meta refresh would yank the user out of the mirror
      strippedNodes += 1;
    }
  }
  for (const el of document.querySelectorAll('meta[name="robots"]')) el.remove();

  const head = document.head ?? document.createElement('head');
  if (!document.head && document.documentElement) {
    document.documentElement.insertBefore(head, document.documentElement.firstChild);
  }
  if (document.documentElement) {
    // Re-running the rewriter over already-rewritten HTML must not stack chrome.
    // (A re-ingest, or a future read-time rewrite pass, would otherwise duplicate it.)
    for (const id of [RUNTIME_SCRIPT_ID, RUNTIME_STYLE_ID]) {
      for (const stale of document.querySelectorAll(`#${id}`)) stale.remove();
    }

    const base = document.createElement('base');
    base.setAttribute('href', '/');
    head.insertBefore(base, head.firstChild);

    const robots = document.createElement('meta');
    robots.setAttribute('name', 'robots');
    robots.setAttribute('content', 'noindex,nofollow,noarchive');
    head.appendChild(robots);

    const style = document.createElement('style');
    style.setAttribute('id', RUNTIME_STYLE_ID);
    style.textContent = RUNTIME_CSS;
    head.appendChild(style);

    const meta = document.createElement('meta');
    meta.setAttribute('name', 'cw-mirror');
    meta.setAttribute('content', JSON.stringify({ day: ctx.day, url: ctx.pageUrl }));
    head.appendChild(meta);
    // Runtime first in head so the shims exist before any page script runs.
    const script = document.createElement('script');
    script.setAttribute('id', RUNTIME_SCRIPT_ID);
    script.textContent = RUNTIME_SCRIPT;
    head.insertBefore(script, head.firstChild);
  }

  // ---- images ----
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    let mapped = mapAsset(src);
    if (!mapped) {
      for (const attr of lazyAttrs) {
        if (attr.endsWith('srcset')) continue;
        const candidate = mapAsset(img.getAttribute(attr));
        if (candidate) {
          mapped = candidate;
          break;
        }
      }
    }
    if (mapped) img.setAttribute('src', mapped);
    else if (src && isRewritable(decodeEntities(src).trim())) img.setAttribute('data-cw-missing', 'src');

    for (const attr of lazyAttrs) {
      const value = img.getAttribute(attr);
      if (!value) continue;
      if (attr.endsWith('srcset')) img.setAttribute(attr, rewriteSrcset(value, ctx.pageUrl, ctx.assetMap));
      else {
        const candidate = mapAsset(value);
        if (candidate) img.setAttribute(attr, candidate);
      }
    }
    const srcset = img.getAttribute('srcset');
    if (srcset) img.setAttribute('srcset', rewriteSrcset(srcset, ctx.pageUrl, ctx.assetMap));
    img.removeAttribute('crossorigin');
  }

  for (const source of document.querySelectorAll('source')) {
    const srcset = source.getAttribute('srcset');
    if (srcset) source.setAttribute('srcset', rewriteSrcset(srcset, ctx.pageUrl, ctx.assetMap));
    const mapped = mapAsset(source.getAttribute('src'));
    if (mapped) source.setAttribute('src', mapped);
  }

  // ---- stylesheets ----
  for (const el of document.querySelectorAll('link')) {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase();
    const href = el.getAttribute('href');
    if (!href) continue;
    const relevant =
      rel.includes('stylesheet') ||
      rel.includes('icon') ||
      rel.includes('apple-touch-icon') ||
      rel.includes('mask-icon') ||
      rel.includes('preload');
    if (!relevant) continue;
    const mapped = mapAsset(href);
    if (mapped) {
      el.setAttribute('href', mapped);
      el.removeAttribute('crossorigin');
    } else if (rel.includes('stylesheet')) {
      el.remove(); // a missing stylesheet is better gone than 404ing and blocking render
      strippedNodes += 1;
    }
  }

  // ---- scripts ----
  for (const el of document.querySelectorAll('script')) {
    const src = el.getAttribute('src');
    if (!src) continue; // inline script: keep as-is
    const decoded = decodeEntities(src).trim();
    const stub = (value: string, attribute: string): void => {
      const marker = document.createElement('script');
      marker.setAttribute('type', 'text/plain');
      marker.setAttribute(attribute, value);
      marker.setAttribute('class', 'cw-stub');
      el.replaceWith(marker);
    };
    if (shouldStubScript(decoded)) {
      stub(decoded, 'data-cw-stub');
      stubbedScripts.push(decoded);
      continue;
    }
    const mapped = mapAsset(src);
    if (mapped) {
      el.setAttribute('src', mapped);
      el.removeAttribute('crossorigin');
      el.removeAttribute('integrity'); // integrity hashes no longer match after rewriting
      keptScripts += 1;
    } else {
      stub(decoded, 'data-cw-missing');
      strippedNodes += 1;
    }
  }

  // ---- inline styles ----
  for (const el of document.querySelectorAll('[style]')) {
    const style = el.getAttribute('style');
    if (style) el.setAttribute('style', rewriteCss(style, ctx.pageUrl, ctx.assetMap));
  }
  for (const el of document.querySelectorAll('style')) {
    const text = el.textContent ?? '';
    if (text) el.textContent = rewriteCss(text, ctx.pageUrl, ctx.assetMap);
  }

  // ---- media ----
  for (const el of document.querySelectorAll('video, audio, embed, iframe')) {
    const mapped = mapAsset(el.getAttribute('src'));
    if (mapped) el.setAttribute('src', mapped);
  }
  for (const el of document.querySelectorAll('video, audio')) {
    const mapped = mapAsset(el.getAttribute('poster'));
    if (mapped) el.setAttribute('poster', mapped);
  }

  // ---- links ----
  for (const a of document.querySelectorAll('a')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const decoded = decodeEntities(href).trim();
    if (!isRewritable(decoded)) continue;
    const canonical = canonicalize(decoded, ctx.pageUrl);
    if (!canonical) continue;

    if (!sameSite(canonical, ctx.pageUrl)) {
      a.setAttribute('href', canonical);
      a.setAttribute('rel', 'noopener noreferrer nofollow');
      a.setAttribute('target', '_blank');
      a.setAttribute('data-cw-external', '1');
      externalLinks += 1;
      continue;
    }

    internalLinks.add(canonical);
    const resolved = ctx.linkMap.get(canonical);
    if (resolved) {
      a.setAttribute('href', snapshotPath(ctx.domain, resolved.day, canonical));
      if (resolved.deltaDays !== 0) {
        a.setAttribute('data-cw-delta', String(resolved.deltaDays));
        a.setAttribute(
          'title',
          `captured ${Math.abs(resolved.deltaDays)} day(s) ${resolved.deltaDays < 0 ? 'earlier' : 'later'}`,
        );
      }
      a.removeAttribute('target');
      continue;
    }

    a.removeAttribute('href');
    a.setAttribute('data-cw-dead', canonical);
    a.setAttribute('title', 'not captured in the archived range');
    a.classList.add('cw-dead-link');
    deadLinks.add(canonical);
  }

  // ---- forms must not post into the live internet ----
  for (const form of document.querySelectorAll('form')) {
    form.setAttribute('data-cw-action', form.getAttribute('action') ?? '');
    form.removeAttribute('action');
    form.setAttribute('onsubmit', 'return false');
    form.setAttribute('data-cw-disabled', '1');
  }

  // ---- legacy plugin content ----
  for (const el of document.querySelectorAll('object, param')) {
    el.remove();
    strippedNodes += 1;
  }

  // ---- per-page mirroring facts, for the shell's status chips ----
  // Written last because the counts are only known now. The runtime reads this meta
  // and forwards it to the host shell alongside cw:ready.
  const mirrorMeta = document.querySelector('meta[name="cw-mirror"]');
  if (mirrorMeta) {
    mirrorMeta.setAttribute(
      'content',
      JSON.stringify({
        day: ctx.day,
        url: ctx.pageUrl,
        flags: {
          deadLinks: deadLinks.size,
          missingAssets: missingAssets.size,
          stubbedScripts: stubbedScripts.length,
        },
      }),
    );
  }

  const serialized = document.toString();
  const htmlOut =
    serialized.startsWith('<!DOCTYPE') || serialized.startsWith('<!doctype')
      ? serialized
      : `<!DOCTYPE html>\n${serialized}`;

  return {
    html: htmlOut,
    title: (document.querySelector('title')?.textContent ?? '').trim().slice(0, 300),
    lang: document.documentElement?.getAttribute('lang') ?? '',
    missingAssets: [...missingAssets],
    internalLinks: [...internalLinks],
    externalLinks,
    stubbedScripts,
    keptScripts,
    strippedNodes,
    deadLinks: [...deadLinks],
  };
}

/** Convenience re-export so callers do not need urlutil for the common case. */
export { assetPath };
