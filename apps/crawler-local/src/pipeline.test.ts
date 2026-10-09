/**
 * Offline verification of the ingest pipeline's pure functions.
 *
 * Why offline: the rewriter, the day-selection policy and the URL helpers are where
 * the real logic lives, and they must not depend on archive.org being reachable (or
 * on being polite to it). This suite exercises them against archived markup that was
 * already fetched during the live run, so it is deterministic and costs zero requests.
 *
 * Run: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, pathDepth, snapshotPath, tsToDay, sameSite, shouldStubScript, isMirrorableAsset } from './urlutil.ts';
import { selectPages, resolveLink, pickAssetCapture, isNavigablePage } from './ledger.ts';
import { cssUrls, extractPage, rewriteCss, rewritePage } from './rewrite.ts';
import { parseCdxJson, buildIdUrl, buildSurveyUrl, htmlSurvey } from './wayback.ts';
import { parseMonth, registrableDomain } from './config.ts';
import { matchSnapshotRoute } from './viewer.ts';
import type { CdxRow } from './wayback.ts';

// --------------------------------------------------------------------- helpers

function row(url: string, ts: string, bytes = 1000, status = 200): CdxRow {
  return { url, ts, mime: 'text/html', status, digest: `D${ts}`, bytes, day: tsToDay(ts) };
}

/** A page that exercises every rewriting rule at once. */
const FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <base href="https://www.example.com/">
  <title>  Fixture Page  </title>
  <meta http-equiv="refresh" content="5;url=https://evil.example/live">
  <meta name="robots" content="index,follow">
  <link rel="stylesheet" href="/css/site.css">
  <link rel="stylesheet" href="https://fonts.dead-cdn.example/x.css">
  <link rel="icon" href="/favicon.ico">
  <script src="/js/app.js" integrity="sha384-abc"></script>
  <script src="https://www.googletagmanager.com/gtm.js?id=GTM-123"></script>
  <script src="https://cdn.dead.example/gone.js"></script>
  <style>
    .hero { background: url('/img/hero.jpg') no-repeat; }
    @import url("/css/extra.css");
    .inline { background-image: url("data:image/gif;base64,R0lGOD"); }
  </style>
  <style>.second { background: url(/img/second.png); }</style>
</head>
<body style="background-image:url('/img/body-bg.png')">
  <img src="/img/logo.png" alt="logo">
  <img src="data:image/gif;base64,R0lGOD" alt="inline">
  <img data-src="/img/lazy.jpg" alt="lazy">
  <img src="/img/dead.png" alt="dead">
  <img srcset="/img/a-1x.png 1x, /img/a-2x.png 2x" src="/img/a-1x.png" alt="responsive">
  <picture><source srcset="/img/b-1x.webp 1x"></picture>
  <a href="/about">About</a>
  <a href="/never-captured">Nowhere</a>
  <a href="https://www.iana.org/domains">External</a>
  <a href="#anchor">Anchor</a>
  <a href="mailto:hi@example.com">Mail</a>
  <form action="/search" method="get"><input name="q"></form>
  <object data="/flash.swf"></object>
  <video src="/media/clip.mp4" poster="/img/poster.jpg"></video>
</body>
</html>`;

const ASSET_MAP = new Map<string, string>([
  ['https://www.example.com/css/site.css', '/assets/aa/sitecss'],
  ['https://www.example.com/css/extra.css', '/assets/bb/extracss'],
  ['https://www.example.com/favicon.ico', '/assets/cc/favicon'],
  ['https://www.example.com/js/app.js', '/assets/dd/appjs'],
  ['https://www.example.com/img/hero.jpg', '/assets/ee/hero'],
  ['https://www.example.com/img/second.png', '/assets/ff/second'],
  ['https://www.example.com/img/body-bg.png', '/assets/11/bodybg'],
  ['https://www.example.com/img/logo.png', '/assets/22/logo'],
  ['https://www.example.com/img/lazy.jpg', '/assets/33/lazy'],
  ['https://www.example.com/img/a-1x.png', '/assets/44/a1x'],
  ['https://www.example.com/img/a-2x.png', '/assets/55/a2x'],
  ['https://www.example.com/img/b-1x.webp', '/assets/66/b1x'],
  ['https://www.example.com/img/poster.jpg', '/assets/77/poster'],
  ['https://www.example.com/media/clip.mp4', '/assets/88/clip'],
]);

const LINK_MAP = new Map([
  [
    'https://www.example.com/about',
    { targetUrl: 'https://www.example.com/about', day: '2024-01-06', deltaDays: 0, ts: '20240106120000' },
  ],
  [
    'https://www.example.com/older',
    { targetUrl: 'https://www.example.com/older', day: '2024-01-03', deltaDays: -3, ts: '20240103120000' },
  ],
]);

function rewriteFixture(overrides: Partial<Parameters<typeof rewritePage>[1]> = {}) {
  return rewritePage(FIXTURE, {
    domain: 'example.com',
    day: '2024-01-06',
    pageUrl: 'https://www.example.com/',
    seedOrigin: 'https://www.example.com',
    assetMap: ASSET_MAP,
    linkMap: LINK_MAP,
    ...overrides,
  });
}

// ------------------------------------------------------------------ url helpers

test('canonicalize normalises host, port, tracking params and fragment', () => {
  // Note: query params are re-emitted in sorted order, so `b=2&a=1` becomes `a=1&b=2`.
  assert.equal(
    canonicalize('HTTPS://WWW.Example.COM:443/a/b?utm_source=x&b=2&a=1#frag'),
    'https://www.example.com/a/b?a=1&b=2',
  );
  assert.equal(canonicalize('http://example.com:80/'), 'http://example.com/');
  assert.equal(canonicalize('/relative', 'https://example.com/dir/page'), 'https://example.com/relative');
  assert.equal(canonicalize('mailto:someone@example.com'), undefined);
  assert.equal(canonicalize('not a url'), undefined);
});

test('sameSite treats subdomains and CDNs as one site', () => {
  assert.ok(sameSite('https://images.example.com/a.png', 'https://www.example.com/'));
  assert.ok(sameSite('https://www.example.co.uk/', 'https://shop.example.co.uk/x'));
  assert.ok(!sameSite('https://example.org/', 'https://www.example.com/'));
});

test('pathDepth measures distance below the root', () => {
  assert.equal(pathDepth('https://e.com/'), 0);
  assert.equal(pathDepth('https://e.com/about'), 1);
  assert.equal(pathDepth('https://e.com/about/'), 1);
  assert.equal(pathDepth('https://e.com/about/team/'), 2);
  assert.equal(pathDepth('https://e.com/a/b/c/d'), 4);
});

test('snapshotPath percent-encodes the original query into the path', () => {
  assert.equal(snapshotPath('example.com', '2024-01-06', 'https://www.example.com/a/b'), '/a/example.com/2024-01-06/a/b');
  // The query is encoded *inside* the path, so the browser never re-associates it
  // with our own origin's query string. The viewer decodes this back to the original
  // URL before looking the page up in the ledger.
  assert.equal(
    snapshotPath('example.com', '2024-01-06', 'https://www.example.com/search?q=x&p=2'),
    '/a/example.com/2024-01-06/search%3Fq%3Dx%26p%3D2',
  );
});

test('asset policy skips heavyweight binaries but keeps images and css', () => {
  assert.ok(isMirrorableAsset('https://e.com/img/a.png'));
  assert.ok(isMirrorableAsset('https://e.com/css/a.css'));
  assert.ok(isMirrorableAsset('https://e.com/image?id=42'));
  assert.ok(!isMirrorableAsset('https://e.com/video.mp4'));
  assert.ok(!isMirrorableAsset('https://e.com/archive.zip'));
});

test('tracking and ad script hosts are stubbed', () => {
  assert.ok(shouldStubScript('https://www.googletagmanager.com/gtm.js'));
  assert.ok(shouldStubScript('https://connect.facebook.net/en_US/fbevents.js'));
  assert.ok(shouldStubScript('https://static.hotjar.com/c/hotjar.js'));
  assert.ok(!shouldStubScript('https://www.example.com/js/app.js'));
});

test('registrableDomain handles two-level public suffixes', () => {
  assert.equal(registrableDomain('www.samsung.com'), 'samsung.com');
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('parseMonth produces inclusive CDX ranges', () => {
  const r = parseMonth('2024-02');
  assert.equal(r.from, '20240201000000');
  assert.equal(r.to, '20240229235959'); // 2024 is a leap year
  assert.equal(r.lastDay, '2024-02-29');
  assert.throws(() => parseMonth('2024-13'));
  assert.throws(() => parseMonth('202401'));
});

// -------------------------------------------------------------------- CDX layer

test('parseCdxJson reads the header, rows and resumption key', () => {
  const body = JSON.stringify([
    ['timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
    ['20240101000832', 'https://www.example.com/', 'text/html', '200', 'JI6OR', '778'],
    [],
    ['org,example)/+20240101000832!'],
  ]);
  const { rows, resumeKey } = parseCdxJson(body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.url, 'https://www.example.com/');
  assert.equal(rows[0]!.day, '2024-01-01');
  assert.equal(rows[0]!.status, 200);
  assert.equal(resumeKey, 'org,example)/+20240101000832!');
});

test('parseCdxJson reports errors instead of throwing', () => {
  assert.ok(parseCdxJson('<html>Gateway Timeout</html>').error);
  assert.ok(parseCdxJson('[not json').error);
  assert.deepEqual(parseCdxJson('').rows, []);
});

test('id_ raw replay URL is built for the original capture', () => {
  assert.equal(
    buildIdUrl('20240101000832', 'https://www.example.com/'),
    'https://web.archive.org/web/20240101000832id_/https://www.example.com/',
  );
});

test('survey URL never uses showResumeKey (it forces a full index scan)', () => {
  const url = buildSurveyUrl(htmlSurvey('example.com', '20240101000000', '20240131235959', 2000));
  assert.ok(url.includes('limit=2000'));
  assert.ok(!url.includes('showResumeKey'));
  assert.ok(!url.includes('collapse'));
});

// ------------------------------------------------------------- day-selection

test('perday mode yields exactly one capture per URL per day', () => {
  const rows: CdxRow[] = [
    row('https://e.com/', '20240101010000', 500),
    row('https://e.com/', '20240101090000', 900), // same day, larger
    row('https://e.com/', '20240101180000', 800),
    row('https://e.com/', '20240102010000', 700),
    row('https://e.com/about', '20240101020000', 600),
  ];
  const result = selectPages(rows, 'perday', 'https://e.com/');
  assert.equal(result.pages.length, 3); // 2 days for "/" + 1 day for "/about"
  assert.equal(result.distinctUrls, 2);
  const rootDay1 = result.pages.find((p) => p.url === 'https://e.com/' && p.day === '2024-01-01')!;
  // Larger capture of the day wins.
  assert.equal(rootDay1.ts, '20240101090000');
  // The two other same-day captures are 8 h apart, so both are genuinely distinct
  // states of the page and are recorded as extras for the UI's capture counter.
  assert.equal(rootDay1.extras.length, 2);
});

test('perday collapses dense same-minute captures away', () => {
  const rows: CdxRow[] = [
    row('https://e.com/', '20240101010000', 500),
    row('https://e.com/', '20240101010030', 500), // 30 s later: same page state
    row('https://e.com/', '20240101010045', 500),
  ];
  const result = selectPages(rows, 'perday', 'https://e.com/');
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0]!.extras.length, 0);
  assert.equal(result.capturesDiscarded, 2);
});

test('anchor mode pins every URL to the best-captured day, falling back nearby', () => {
  const rows: CdxRow[] = [
    row('https://e.com/', '20240105000000'),
    row('https://e.com/', '20240106000000'),
    row('https://e.com/a', '20240106000000'),
    row('https://e.com/b', '20240106000000'),
    row('https://e.com/lonely', '20240120000000'), // 14 days later
  ];
  const result = selectPages(rows, 'anchor', 'https://e.com/');
  assert.equal(result.anchorDay, '2024-01-06');
  assert.equal(result.anchorCoverage, 3);
  assert.equal(result.pages.length, 4);
  const lonely = result.pages.find((p) => p.url === 'https://e.com/lonely')!;
  assert.equal(lonely.day, '2024-01-20'); // nearest available capture
});

test('non-200 captures and non-page paths are excluded', () => {
  const rows: CdxRow[] = [
    row('https://e.com/', '20240101000000', 100, 404),
    row('https://e.com/robots.txt', '20240101000000'),
    row('https://e.com/sitemap.xml', '20240101000000'),
    row('https://e.com/real', '20240101000000'),
  ];
  const result = selectPages(rows, 'perday', 'https://e.com/');
  assert.deepEqual(
    result.pages.map((p) => p.url),
    ['https://e.com/real'],
  );
  assert.ok(!isNavigablePage('https://e.com/feed/'));
  assert.ok(isNavigablePage('https://e.com/news'));
});

test('resolveLink prefers the same day, then the nearest, within tolerance', () => {
  const days = new Set(['2024-01-01', '2024-01-06', '2024-01-20']);
  assert.deepEqual(resolveLink(days, '2024-01-06'), { day: '2024-01-06', deltaDays: 0 });
  assert.deepEqual(resolveLink(days, '2024-01-05'), { day: '2024-01-06', deltaDays: 1 });
  assert.equal(resolveLink(new Set(['2024-03-01']), '2024-01-06', 31), undefined);
});

test('pickAssetCapture takes the largest successful capture', () => {
  const rows: CdxRow[] = [
    row('https://e.com/a.png', '20240101000000', 100),
    row('https://e.com/a.png', '20240102000000', 900),
    row('https://e.com/a.png', '20240103000000', 50, 404),
  ];
  assert.equal(pickAssetCapture(rows)!.ts, '20240102000000');
  assert.equal(pickAssetCapture([row('https://e.com/a.png', '20240101000000', 0, 500)]), undefined);
});

// ---------------------------------------------------------------- css

test('cssUrls extracts url() and @import targets, skipping data URIs', () => {
  const urls = cssUrls(`
    .a { background: url('/img/a.png'); }
    .b { background: url("/img/b.png"); }
    .c { background: url(/img/c.png); }
    .d { background: url(data:image/gif;base64,AAA); }
    @import url("/css/x.css");
    @import "css/y.css";
  `);
  assert.ok(urls.includes('/img/a.png'));
  assert.ok(urls.includes('/img/b.png'));
  assert.ok(urls.includes('/img/c.png'));
  assert.ok(urls.includes('/css/x.css'));
  assert.ok(urls.includes('css/y.css'));
  assert.ok(!urls.some((u) => u.startsWith('data:')));
});

test('rewriteCss maps known targets and leaves unknown ones untouched', () => {
  const out = rewriteCss(
    `.a{background:url('/img/hero.jpg')} .b{background:url('/img/unknown.png')} @import url("/css/extra.css");`,
    'https://www.example.com/css/site.css',
    ASSET_MAP,
  );
  assert.ok(out.includes("/assets/ee/hero"), 'known url() should be mapped');
  assert.ok(out.includes('/img/unknown.png'), 'unknown url() must be preserved');
  assert.ok(out.includes('/assets/bb/extracss'), '@import should be mapped');
});

// ---------------------------------------------------------------- extraction

test('extractPage finds assets, lazy attributes, srcset and internal links', () => {
  const extracted = extractPage(FIXTURE, 'https://www.example.com/');
  const urls = extracted.assets.map((a) => a.url);
  assert.ok(urls.includes('https://www.example.com/css/site.css'));
  assert.ok(urls.includes('https://fonts.dead-cdn.example/x.css'));
  assert.ok(urls.includes('https://www.example.com/img/hero.jpg'), 'url() inside <style>');
  assert.ok(urls.includes('https://www.example.com/img/lazy.jpg'), 'lazy data-src');
  assert.ok(urls.includes('https://www.example.com/img/a-2x.png'), 'srcset candidate');
  assert.ok(urls.includes('https://www.example.com/img/b-1x.webp'), 'picture source srcset');
  assert.ok(urls.includes('https://www.example.com/media/clip.mp4'));
  assert.ok(!urls.some((u) => u.includes('googletagmanager')), 'stub hosts are never fetched');
  assert.ok(!urls.some((u) => u.startsWith('data:')));
  assert.equal(extracted.title, 'Fixture Page');
  assert.equal(extracted.lang, 'en');
  assert.ok(extracted.internalLinks.includes('https://www.example.com/about'));
  assert.ok(!extracted.internalLinks.includes('https://www.iana.org/domains'), 'external link excluded');
});

// ---------------------------------------------------------------- rewriting

test('rewritePage points assets at the cache and preserves unmapped ones safely', () => {
  const out = rewriteFixture();
  assert.ok(out.html.includes('/assets/22/logo'), 'img src rewritten');
  assert.ok(out.html.includes('/assets/33/lazy'), 'lazy image promoted');
  assert.ok(out.html.includes('/assets/44/a1x') && out.html.includes('/assets/55/a2x'), 'srcset rewritten');
  assert.ok(out.html.includes('/assets/aa/sitecss'), 'stylesheet rewritten');
  assert.ok(out.html.includes('/assets/ee/hero'), 'inline style url() rewritten');
  assert.ok(out.html.includes('/assets/11/bodybg'), 'style attribute rewritten');
  assert.ok(out.html.includes('/assets/88/clip'), 'video src rewritten');
  assert.ok(out.html.includes('data-cw-missing="src"'), 'missing image flagged, not dropped');
  assert.ok(out.html.includes('/img/dead.png'), 'the original missing URL is kept for diagnosis');
});

test('rewritePage stubs trackers, drops dead CDN scripts, and keeps real app JS', () => {
  const out = rewriteFixture();
  assert.deepEqual(out.stubbedScripts, ['https://www.googletagmanager.com/gtm.js?id=GTM-123']);
  assert.ok(out.html.includes('data-cw-stub='), 'tracker becomes an inert marker');
  assert.ok(out.html.includes('data-cw-missing="https://cdn.dead.example/gone.js"'), 'dead CDN script stubbed');
  assert.equal(out.keptScripts, 1);
  assert.ok(out.html.includes('/assets/dd/appjs'), 'app JS served locally');
  assert.ok(!out.html.includes('integrity='), 'stale integrity hash removed');
});

test('rewritePage eliminates the Wayback toolbar problem and hostile navigation', () => {
  const out = rewriteFixture();
  assert.ok(!out.html.includes('<base href="https://www.example.com/"'), 'original <base> removed');
  assert.ok(out.html.includes('<base href="/"'), 'our own base injected');
  assert.ok(!out.html.includes('http-equiv="refresh"'), 'meta refresh removed');
  assert.ok(out.html.includes('noindex,nofollow,noarchive'), 'mirror is not indexable');
  assert.ok(out.html.includes('id="cw-runtime-script"'), 'runtime shim injected');
  assert.ok(out.html.includes('id="cw-runtime-style"'), 'runtime CSS injected');
  assert.ok(!out.html.includes('<object'), 'legacy plugin container removed');
  const form = /<form[^>]*>/.exec(out.html)![0];
  assert.ok(!/\saction=/.test(form), 'form action stripped');
  assert.ok(form.includes('data-cw-disabled'), 'form marked disabled');
});

test('rewritePage rewrites internal links, annotates drift and quarantines dead ones', () => {
  const out = rewriteFixture();
  assert.ok(out.html.includes('href="/a/example.com/2024-01-06/about"'), 'resolved internal link');
  assert.ok(out.html.includes('data-cw-dead="https://www.example.com/never-captured"'), 'dead link marked');
  assert.ok(!/href="\/never-captured"/.test(out.html), 'dead link href removed');
  assert.ok(out.html.includes('href="#anchor"'), 'anchor links untouched');
  assert.ok(out.html.includes('href="mailto:hi@example.com"'), 'mailto untouched');
  const external = /<a[^>]*iana\.org[^>]*>/.exec(out.html)![0];
  assert.ok(external.includes('data-cw-external'), 'external link flagged');
  assert.ok(external.includes('rel="noopener noreferrer nofollow"'), 'external link made safe');
  assert.equal(out.externalLinks, 1);
});

test('rewritePage annotates how far a resolved capture is from the day viewed', () => {
  const html = `<a href="/older">Older</a>`;
  const out = rewritePage(html, {
    domain: 'example.com',
    day: '2024-01-06',
    pageUrl: 'https://www.example.com/',
    seedOrigin: 'https://www.example.com',
    assetMap: new Map(),
    linkMap: LINK_MAP,
  });
  assert.ok(out.html.includes('href="/a/example.com/2024-01-03/older"'));
  assert.ok(out.html.includes('data-cw-delta="-3"'), 'drift is exposed to the UI');
});

test('rewritePage is idempotent enough to survive a re-run without duplicating chrome', () => {
  const once = rewriteFixture();
  const twice = rewritePage(once.html, {
    domain: 'example.com',
    day: '2024-01-06',
    pageUrl: 'https://www.example.com/',
    seedOrigin: 'https://www.example.com',
    assetMap: ASSET_MAP,
    linkMap: LINK_MAP,
  });
  assert.equal(
    twice.html.split('id="cw-runtime-script"').length - 1,
    1,
    'runtime script must not be injected twice',
  );
  assert.ok(!twice.html.includes('<base href="https://www.example.com/"'));
});

test('a page with no assets or links round-trips without loss', () => {
  const plain = '<!DOCTYPE html><html><head><title>Plain</title></head><body><p>hello</p></body></html>';
  const out = rewritePage(plain, {
    domain: 'example.com',
    day: '2024-01-06',
    pageUrl: 'https://www.example.com/',
    seedOrigin: 'https://www.example.com',
    assetMap: new Map(),
    linkMap: new Map(),
  });
  assert.ok(out.html.includes('<p>hello</p>'));
  assert.ok(out.html.includes('<title>Plain</title>'));
  assert.equal(out.deadLinks.length, 0);
});

// ------------------------------------------------------------ viewer routing

test('snapshot routes address a site root in both forms', () => {
  // Regression: the trailing path group used to require a leading "/", so
  // "/a/domain/day" -- the form produced by a normalised root URL -- never matched
  // and every site root returned 404 despite the page being on disk.
  assert.deepEqual(matchSnapshotRoute('/a/example.com/2024-01-05'), {
    domain: 'example.com',
    day: '2024-01-05',
    routePath: '/',
  });
  assert.deepEqual(matchSnapshotRoute('/a/example.com/2024-01-05/'), {
    domain: 'example.com',
    day: '2024-01-05',
    routePath: '/',
  });
  assert.deepEqual(matchSnapshotRoute('/a/example.com/2024-01-05/about/'), {
    domain: 'example.com',
    day: '2024-01-05',
    routePath: '/about/',
  });
  assert.deepEqual(matchSnapshotRoute('/a/example.com/2024-01-05/search%3Fq%3Dx'), {
    domain: 'example.com',
    day: '2024-01-05',
    routePath: '/search%3Fq%3Dx',
  });
  assert.equal(matchSnapshotRoute('/a/example.com/not-a-day'), undefined);
  assert.equal(matchSnapshotRoute('/assets/aa/bb'), undefined);
});

test('snapshotPath emits routes the viewer can parse back (round trip)', () => {
  for (const url of [
    'https://example.com/',
    'https://www.example.com/about/',
    'https://www.example.com/deep/path/page',
    'https://www.example.com/search?q=x&p=2',
  ]) {
    const route = snapshotPath('example.com', '2024-01-05', url);
    const parsed = matchSnapshotRoute(route);
    assert.ok(parsed, `route should parse: ${route}`);
    assert.equal(parsed!.domain, 'example.com');
    assert.equal(parsed!.day, '2024-01-05');
    // Decoding the route path once must reproduce the original pathname + query,
    // which is exactly what the ledger keys snapshots on.
    const original = new URL(url);
    assert.equal(
      decodeURIComponent(parsed!.routePath.replace(/^\/?/, '/')),
      `${original.pathname}${original.search}`,
      `round trip failed for ${url} (route=${route})`,
    );
  }
});
