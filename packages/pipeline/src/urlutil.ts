/**
 * URL helpers: canonicalisation, classification, snapshot-path mapping.
 *
 * Snapshot routes look like  /a/<domain>/<day>/<encoded-path>
 * so the local viewer can be swapped for the Cloudflare Worker in Phase 2 without
 * changing any stored HTML.
 */

const TRACKING_PARAMS = [
  /^utm_/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^mc_(cid|eid)$/i,
  /^_ga$/i,
  /^ref$/i,
  /^igshid$/i,
  /^yclid$/i,
  /^msclkid$/i,
];

/** Extensions we never mirror: waste of bytes and never part of "how the site looked". */
const SKIP_EXTENSIONS = new Set([
  'exe', 'dmg', 'msi', 'pkg', 'apk', 'iso', 'bin', 'zip', 'rar', '7z', 'gz', 'tgz', 'bz2', 'xz',
  'mp3', 'ogg', 'wav', 'flac', 'm4a', 'aac',
  'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv',
]);

export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff']);
export const STYLE_EXT = new Set(['css']);
export const SCRIPT_EXT = new Set(['js', 'mjs', 'cjs']);
export const FONT_EXT = new Set(['woff2', 'woff', 'ttf', 'otf', 'eot']);

export function stripTracking(url: URL): URL {
  const keep: [string, string][] = [];
  for (const [k, v] of url.searchParams) {
    if (!TRACKING_PARAMS.some((re) => re.test(k))) keep.push([k, v]);
  }
  const sorted = keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of sorted) url.searchParams.append(k, v);
  return url;
}

/**
 * Canonical form used as the ledger key: host lowercased, default port dropped,
 * tracking params removed, params sorted, fragment dropped.
 *
 * ## Credentials in the URL are dropped
 *
 * `http://email@example.com/` was in the live ledger next to `https://example.com/` and
 * `http://example.com/`: three rows for one page, because archive.org's index contains
 * captures crawled from a URL that carried userinfo. Two URLs that differ only in
 * `user:pass@` fetch the same resource — the userinfo is transport credentials, not
 * addressing — so keeping it in the key means the same page is crawled, stored and
 * counted repeatedly, and the day picker shows a duplicate. Removing it is also the
 * safer default: a mirror should not carry credentials forward into its own routes.
 */
export function canonicalize(input: string | URL, base?: string): string | undefined {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.hash = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  stripTracking(url);
  if (url.pathname === '') url.pathname = '/';
  return url.toString();
}

export function extensionOf(urlStr: string): string {
  try {
    const last = new URL(urlStr).pathname.split('/').pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot <= 0) return '';
    return last.slice(dot + 1).toLowerCase();
  } catch {
    return '';
  }
}

/** Should this asset URL be mirrored at all? */
export function isMirrorableAsset(urlStr: string): boolean {
  const ext = extensionOf(urlStr);
  if (!ext) return true; // extension-less asset endpoints (image CDNs) are common
  return !SKIP_EXTENSIONS.has(ext);
}

export function looksLikeImage(urlStr: string, mime?: string): boolean {
  if (mime?.startsWith('image/')) return true;
  return IMAGE_EXT.has(extensionOf(urlStr));
}

export function looksLikeStylesheet(urlStr: string, mime?: string): boolean {
  if (mime === 'text/css') return true;
  return STYLE_EXT.has(extensionOf(urlStr));
}

export function looksLikeScript(urlStr: string, mime?: string): boolean {
  if (mime && /(javascript|ecmascript)/i.test(mime)) return true;
  return SCRIPT_EXT.has(extensionOf(urlStr));
}

/** Depth of a page below the root, used for the crawl frontier and budgets. */
export function pathDepth(urlStr: string): number {
  try {
    const segments = new URL(urlStr).pathname.split('/').filter(Boolean);
    return segments.length;
  } catch {
    return 99;
  }
}

export function hostOf(urlStr: string): string {
  try {
    return new URL(urlStr).host;
  } catch {
    return '';
  }
}

const TWO_LEVEL_TLDS = new Set(['co.uk', 'com.au', 'co.jp', 'com.br', 'co.kr', 'com.cn', 'co.in']);

export function registrableFromHost(host: string): string {
  const parts = host.toLowerCase().split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/** Same registrable domain (so subdomains and their CDNs stay in scope). */
export function sameSite(a: string, b: string): boolean {
  return registrableFromHost(hostOf(a)) === registrableFromHost(hostOf(b));
}

/** 14-digit wayback timestamp -> YYYY-MM-DD */
export function tsToDay(ts: string): string {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

export function dayToEpoch(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function epochToDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((dayToEpoch(b) - dayToEpoch(a)) / 86_400_000);
}

/**
 * Snapshot route used inside mirrored HTML.
 *   /a/samsung.com/2024-03-15/phones/
 * The original query string is percent-encoded into the path so a browser never
 * re-associates it with our own origin's query.
 */
export function snapshotPath(domain: string, day: string, originalUrl: string): string {
  const url = new URL(originalUrl);
  let path = url.pathname;
  if (!path.startsWith('/')) path = `/${path}`;
  const suffix = url.search ? `%3F${encodeURIComponent(url.search.slice(1))}` : '';
  return `/a/${domain}/${day}${path}${suffix}`;
}

/** Absolute asset route: content-addressed, so it is immutable and cacheable forever. */
export function assetPath(hash: string): string {
  return `/assets/${hash.slice(0, 2)}/${hash}`;
}

/** A readable local filename for a page blob. */
export function pageBlobKey(domain: string, day: string, originalUrl: string): string {
  const url = new URL(originalUrl);
  const slug = `${url.host}${url.pathname}`
    .replace(/[^a-zA-Z0-9._/-]+/g, '_')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const base = slug.length > 0 ? slug : 'index';
  const queryTag = url.search ? `_q${hashString(url.search).slice(0, 8)}` : '';
  const trimmed = base.length > 140 ? base.slice(0, 140) : base;
  return `pages/${domain}/${day}/${trimmed}${queryTag}.html`;
}

export function assetBlobKey(hash: string): string {
  return `assets/${hash.slice(0, 2)}/${hash}`;
}

export function rawBlobKey(domain: string, day: string, originalUrl: string): string {
  return pageBlobKey(domain, day, originalUrl).replace(/^pages\//, 'raw/').replace(/\.html$/, '.orig');
}

/** Small stable non-cryptographic hash for filenames and cache keys. */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

/**
 * Hosts whose scripts are stubbed rather than fetched: dead analytics, ad networks
 * and tag managers. These cannot work in a mirror (their endpoints are gone or they
 * would leak the visitor's IP), and fetching them is what makes archived pages hang.
 */
const STUB_SCRIPT_HOSTS: RegExp[] = [
  /google-analytics\.com$/i,
  /googletagmanager\.com$/i,
  /googletagservices\.com$/i,
  /doubleclick\.net$/i,
  /googleadservices\.com$/i,
  /googlesyndication\.com$/i,
  /facebook\.(net|com)$/i,
  /hotjar\.com$/i,
  /mouseflow\.com$/i,
  /crazyegg\.com$/i,
  /optimizely\.com$/i,
  /segment\.(io|com)$/i,
  /mixpanel\.com$/i,
  /amplitude\.com$/i,
  /newrelic\.com$/i,
  /nr-data\.net$/i,
  /sentry-cdn\.com$/i,
  /quantserve\.com$/i,
  /scorecardresearch\.com$/i,
  /adnxs\.com$/i,
  /criteo\.(com|net)$/i,
  /taboola\.com$/i,
  /outbrain\.com$/i,
  /chartbeat\.(com|net)$/i,
  /parsely\.com$/i,
  /tealiumiq\.com$/i,
  /demdex\.net$/i,
  /omtrdc\.net$/i,
  /2o7\.net$/i,
  /bluekai\.com$/i,
  /krxd\.net$/i,
  /bat\.bing\.com$/i,
  /clarity\.ms$/i,
  /yieldmo\.com$/i,
  /sharethrough\.com$/i,
  /moatads\.com$/i,
  /adsafeprotected\.com$/i,
  /serving-sys\.com$/i,
  /flashtalking\.com$/i,
  /mathtag\.com$/i,
  /turn\.com$/i,
  /rubiconproject\.com$/i,
  /pubmatic\.com$/i,
  /openx\.net$/i,
  /indexww\.com$/i,
  /casalemedia\.com$/i,
  // Tag managers and pixels. Tag managers are usually a synchronous script in <head>,
  // so an archived copy that is slow to fetch holds up the whole page for nothing:
  // measured on samsung.com, Adobe Launch alone blocked first paint for 34 s.
  /adobedtm\.com$/i,
  /tiqcdn\.com$/i,
  /ensighten\.com$/i,
  /everesttech\.net$/i,
  /adsrvr\.org$/i,
  /snap\.licdn\.com$/i,
  /ads-twitter\.com$/i,
  /analytics\.tiktok\.com$/i,
  /sc-static\.net$/i,
  /heapanalytics\.com$/i,
  /hs-analytics\.net$/i,
  /mxpnl\.com$/i,
  /fullstory\.com$/i,
  /siteintercept\.qualtrics\.com$/i,
  /go-mpulse\.net$/i,
];

export function shouldStubScript(urlStr: string): boolean {
  const host = hostOf(urlStr);
  if (!host) return false;
  return STUB_SCRIPT_HOSTS.some((re) => re.test(host));
}

/** Global variables to no-op so legacy page code does not throw on load. */
export const SHIMMED_GLOBALS = [
  'dataLayer', 'ga', 'gaq', '_gaq', 'gtag', 'fbq', '_fbq', 'hj', '_hjSettings',
  'mixpanel', 'amplitude', '_paq', 'optimizely', 'utag', 'digitalData', 'adobeDataLayer', '_satellite',
] as const;
