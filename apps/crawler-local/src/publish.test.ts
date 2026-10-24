/**
 * `publish`: what a crawled month sends to a deployed Custom Wayback, in what order, and
 * how it behaves when the network or the session does not cooperate. Offline: the
 * deployment is a stub `fetch`, and the crawl is rows and blobs written by hand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { Ledger } from './db.ts';
import { MemoryBlobStore } from './storage.ts';
import { PublishError, collectPublication, publishMonth } from './publish.ts';
import { SessionError, normaliseApi, resolveSession } from './session.ts';

const API = 'https://cw.example.workers.dev';
const encoder = new TextEncoder();

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function assetPath(hash: string): string {
  return `/assets/${hash.slice(0, 2)}/${hash}`;
}

interface Fixture {
  ledger: Ledger;
  store: MemoryBlobStore;
  hashes: { css: string; font: string; logo: string; shared: string; uncrawled: string };
}

/**
 * Two pages on two days. The first day's page uses a stylesheet, which uses a font, and
 * a logo; both pages use a shared image the deployment already has; the second page
 * also references a file the crawl never stored.
 */
async function fixture(): Promise<Fixture> {
  const ledger = new Ledger(':memory:');
  const store = new MemoryBlobStore();
  const fontBody = 'wOF2-font-bytes';
  const font = hashOf(fontBody);
  const cssBody = `@font-face { font-family: X; src: url("${assetPath(font)}") }`;
  const css = hashOf(cssBody);
  const logoBody = 'PNG-logo';
  const logo = hashOf(logoBody);
  const sharedBody = 'PNG-shared';
  const shared = hashOf(sharedBody);
  const uncrawled = hashOf('never stored');

  const asset = (hash: string, mime: string, body: string) => {
    const key = `assets/${hash.slice(0, 2)}/${hash}`;
    ledger.db.prepare(`INSERT INTO asset (hash, mime, bytes, r2_key, first_seen) VALUES (?, ?, ?, ?, 0)`).run(hash, mime, body.length, key);
    return store.put(key, encoder.encode(body));
  };
  await asset(font, 'font/woff2', fontBody);
  await asset(css, 'text/css', cssBody);
  await asset(logo, 'image/png', logoBody);
  await asset(shared, 'image/png', sharedBody);

  const page = async (url: string, day: string, depth: number, html: string, refs: string[]) => {
    const key = `pages/example.com/${day}/${depth}.html`;
    ledger.db
      .prepare(
        `INSERT INTO snapshot (domain, url, day, ts, status, mime, digest, bytes, title, depth, nav_score, r2_key, url_hash)
         VALUES ('example.com', ?, ?, ?, 200, 'text/html', 'SHA1DIGEST', ?, ?, ?, 0, ?, 'h')`,
      )
      .run(url, day, `${day.replace(/-/g, '')}093000`, html.length, `Title ${depth}`, depth, key);
    for (const hash of refs) {
      ledger.db.prepare(`INSERT INTO asset_ref (domain, day, url, hash, role) VALUES ('example.com', ?, ?, ?, 'img')`).run(day, url, hash);
    }
    await store.put(key, encoder.encode(html));
  };
  // The logo is only in asset_ref (a srcset the regex would also find, but need not).
  await page(
    'https://example.com/',
    '2024-03-02',
    0,
    `<link rel="stylesheet" href="${assetPath(css)}"><img src="${assetPath(shared)}">`,
    [logo],
  );
  await page(
    'https://example.com/news?id=7',
    '2024-03-09',
    1,
    `<img src="${assetPath(shared)}"><img src="${assetPath(uncrawled)}">`,
    [],
  );
  // Another month, which must not be sent.
  await page('https://example.com/old', '2024-02-27', 1, '<p>February</p>', []);
  return { ledger, store, hashes: { css, font, logo, shared, uncrawled } };
}

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** A deployment that already has `has`, and answers each call with `answer` when given. */
function deployment(has: string[], answer?: (call: Call, attempt: number) => Response | undefined) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? '' : typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    const call: Call = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    };
    calls.push(call);
    const key = `${call.method} ${url.pathname}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const scripted = answer?.(call, attempt);
    if (scripted) return scripted;
    if (url.pathname === '/v1/precrawl/runs') return Response.json({ ingestId: 'run1', created: true }, { status: 201 });
    if (url.pathname === '/v1/precrawl/assets/missing') {
      const { hashes } = JSON.parse(body) as { hashes: string[] };
      return Response.json({ missing: hashes.filter((h) => !has.includes(h)) });
    }
    if (url.pathname.startsWith('/v1/precrawl/assets/')) return Response.json({}, { status: 201 });
    if (url.pathname === '/v1/precrawl/runs/run1/pages') return Response.json({}, { status: 201 });
    if (url.pathname === '/v1/precrawl/runs/run1/finish') return Response.json({ ingestId: 'run1', pages: 2 });
    return new Response('unexpected', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const noSleep = async () => {};

test('a month is published as its pages, every file they use, and what their stylesheets use', async () => {
  const { ledger, store, hashes } = await fixture();
  const { calls, fetchImpl } = deployment([hashes.shared]);
  try {
    const result = await publishMonth(ledger, store, {
      api: `${API}/`,
      token: 'tok',
      domain: 'example.com',
      month: '2024-03',
      fetchImpl,
      sleep: noSleep,
    });

    const uploads = calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/v1/precrawl/assets/'));
    assert.deepEqual(
      uploads.map((c) => [c.path.split('/').pop(), c.headers['content-type']]).sort(),
      [
        [hashes.css, 'text/css'],
        [hashes.font, 'font/woff2'],
        [hashes.logo, 'image/png'],
      ].sort(),
      'the font is found through the stylesheet; the shared image is not sent again',
    );

    const pages = calls.filter((c) => c.path.startsWith('/v1/precrawl/runs/run1/pages'));
    assert.equal(pages.length, 2, 'February is not part of March');
    const first = new URL(`${API}${pages.find((c) => c.path.includes('2024-03-02'))!.path}`);
    assert.equal(first.searchParams.get('url'), 'https://example.com/');
    assert.equal(first.searchParams.get('ts'), '20240302093000');
    assert.equal(pages[0]!.headers['x-cw-title']?.startsWith('Title'), true);
    assert.equal(pages[0]!.headers['x-cw-digest'], 'SHA1DIGEST');
    assert.equal(pages[0]!.headers.authorization, 'Bearer tok');

    const lastAsset = calls.lastIndexOf(uploads[uploads.length - 1]!);
    const firstPage = calls.indexOf(pages[0]!);
    assert.ok(lastAsset < firstPage, 'assets first, so no page is visible before what it needs');
    assert.equal(calls[calls.length - 1]!.path, '/v1/precrawl/runs/run1/finish');

    assert.equal(result.pages, 2);
    assert.equal(result.assetsUploaded, 3);
    assert.equal(result.assetsAlreadyThere, 1);
    assert.equal(result.assetsNotCrawled, 1);
    assert.deepEqual(result.pagesFailed, []);
    assert.equal(result.firstRoute, '/a/example.com/2024-03-02/');
  } finally {
    ledger.close();
  }
});

test('the publication follows stylesheets only through what was crawled', async () => {
  const { ledger, store, hashes } = await fixture();
  try {
    const publication = await collectPublication(ledger, store, 'example.com', '2024-03');
    assert.deepEqual(publication.pages.map((p) => p.url), ['https://example.com/', 'https://example.com/news?id=7']);
    assert.deepEqual(publication.notCrawled, [hashes.uncrawled]);
    assert.equal(publication.assets.length, 4);
  } finally {
    ledger.close();
  }
});

test('a dropped connection or a 5xx is retried; a refused page is reported, not fatal', async () => {
  const { ledger, store, hashes } = await fixture();
  const waits: number[] = [];
  const { calls, fetchImpl } = deployment([], (call, attempt) => {
    if (call.path === `/v1/precrawl/assets/${hashes.font}` && attempt === 1) return new Response('busy', { status: 503 });
    if (call.path.includes('news')) return Response.json({ error: 'url is not a page of example.com' }, { status: 400 });
    return undefined;
  });
  try {
    const result = await publishMonth(ledger, store, {
      api: API,
      token: 'tok',
      domain: 'example.com',
      month: '2024-03',
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    assert.equal(calls.filter((c) => c.path === `/v1/precrawl/assets/${hashes.font}`).length, 2);
    assert.deepEqual(waits, [500]);
    assert.equal(result.pages, 1);
    assert.equal(result.pagesFailed.length, 1);
    assert.match(result.pagesFailed[0]!.reason, /HTTP 400 — url is not a page of example.com/);
    assert.equal(calls.filter((c) => c.path.includes('news')).length, 1, 'a 4xx answer is not retried');
  } finally {
    ledger.close();
  }
});

test('an expired session stops publishing at once, with the command that fixes it', async () => {
  const { ledger, store } = await fixture();
  const { calls, fetchImpl } = deployment([], () => Response.json({ error: 'Unauthorized' }, { status: 401 }));
  try {
    await assert.rejects(
      publishMonth(ledger, store, { api: API, token: 'old', domain: 'example.com', month: '2024-03', fetchImpl, sleep: noSleep }),
      (err: unknown) => err instanceof PublishError && err.message.includes(`npm run login -- --api=${API}`),
    );
    assert.equal(calls.length, 1);
  } finally {
    ledger.close();
  }
});

test('a month with nothing crawled is refused before anything is sent', async () => {
  const { ledger, store } = await fixture();
  const { calls, fetchImpl } = deployment([]);
  try {
    await assert.rejects(
      publishMonth(ledger, store, { api: API, token: 'tok', domain: 'example.com', month: '2023-01', fetchImpl, sleep: noSleep }),
      /nothing is crawled for example.com in 2023-01/,
    );
    assert.equal(calls.length, 0);
  } finally {
    ledger.close();
  }
});

test('the API address must be https, except on this machine', () => {
  assert.equal(normaliseApi('https://cw.example.workers.dev/some/path'), 'https://cw.example.workers.dev');
  assert.equal(normaliseApi('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
  assert.throws(() => normaliseApi('http://cw.example.workers.dev'), SessionError);
  assert.throws(() => normaliseApi('cw.example'), SessionError);
});

test('publishing without a session says how to sign in', async () => {
  const previous = process.env.CW_TOKEN;
  delete process.env.CW_TOKEN;
  try {
    await assert.rejects(resolveSession('/nonexistent-cw-dir', '', ''), /npm run login -- --api=/);
    const fromFlag = await resolveSession('/nonexistent-cw-dir', API, 'tok');
    assert.deepEqual([fromFlag.api, fromFlag.token], [API, 'tok']);
  } finally {
    if (previous !== undefined) process.env.CW_TOKEN = previous;
  }
});
