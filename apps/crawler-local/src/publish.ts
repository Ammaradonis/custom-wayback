/**
 * Publish a crawled month to a deployed Custom Wayback, so its viewer serves those pages
 * from R2 instead of asking archive.org for them.
 *
 *   npm run login   -- --api=https://<your app>.workers.dev
 *   npm run publish -- --domain=apple.com --month=2024-03
 *   npm run crawl   -- --domain=apple.com --month=2024-03 --publish   (both in one go)
 *
 * ## Why this exists
 *
 * archive.org rate-limits the Worker's own requests far harder than a person's
 * connection: at times it answers most of them with HTTP 429, and a page the viewer has
 * to fetch then fails to load. This crawler fetches through *your* connection, politely
 * (see politeness.ts), and stores bytes that never need fetching again. Publishing hands
 * those bytes to the Worker (apps/api/src/routes/precrawl.ts), which keeps them: the
 * post-serve purge never deletes a pre-crawled page.
 *
 * ## What is sent
 *
 * The month's rewritten pages and every asset they reference — including what their
 * stylesheets reference in turn — in that order: assets first, so a page is never
 * visible before what it needs. Assets are content-addressed, so the Worker is asked
 * which hashes it lacks and only those are uploaded; publishing again costs only what
 * changed. No archive.org request is made.
 */

import { snapshotPath } from '@custom-wayback/pipeline';

import type { BlobStore } from './storage.ts';
import type { Ledger } from './db.ts';
import type { Logger } from './logger.ts';

export interface PublishOptions {
  /** The deployed app's origin, e.g. https://custom-wayback-api.example.workers.dev */
  api: string;
  /** A session token for an account on that deployment (see session.ts). */
  token: string;
  domain: string;
  month: string;
  /** Uploads in flight at once. */
  concurrency?: number;
  log?: Logger;
  fetchImpl?: typeof fetch;
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PublishResult {
  ingestId: string;
  pages: number;
  pagesFailed: { url: string; day: string; reason: string }[];
  assetsUploaded: number;
  assetsAlreadyThere: number;
  /** Referenced by a page but never stored locally (outside the crawl's budget, say). */
  assetsNotCrawled: number;
  bytesUploaded: number;
  /** A viewer route to open, the shallowest page of the first day. */
  firstRoute: string | null;
}

export class PublishError extends Error {}

/** One rewritten page as the ledger knows it. */
export interface LocalPage {
  url: string;
  day: string;
  ts: string;
  title: string | null;
  digest: string | null;
  key: string;
}

export interface LocalAsset {
  hash: string;
  mime: string;
  key: string;
}

export interface Publication {
  pages: LocalPage[];
  assets: LocalAsset[];
  /** Hashes some page or stylesheet references that the local store does not have. */
  notCrawled: string[];
}

const ASSET_REF = /\/assets\/([0-9a-f]{2})\/([0-9a-f]{64})/g;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const MISSING_BATCH = 500;

function referencedHashes(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(ASSET_REF)) {
    const [, prefix, hash] = match;
    if (prefix && hash && hash.startsWith(prefix)) found.push(hash);
  }
  return found;
}

/**
 * Everything one month's publication consists of, read from the local ledger and store.
 *
 * The ledger's `asset_ref` table lists what each page used, but a stylesheet's own
 * `url()` targets (fonts, background images) are only in the stylesheet, so those are
 * followed transitively through the stored bytes as well.
 */
export async function collectPublication(
  ledger: Ledger,
  store: BlobStore,
  domain: string,
  month: string,
): Promise<Publication> {
  const pages = (
    ledger.db
      .prepare(
        `SELECT url, day, ts, title, digest, r2_key FROM snapshot
         WHERE domain = ? AND day LIKE ? AND status = 200 AND mime LIKE 'text/html%'
         ORDER BY day, depth, length(url), url`,
      )
      .all(domain, `${month}-%`) as { url: string; day: string; ts: string; title: string | null; digest: string | null; r2_key: string }[]
  ).map((row) => ({ url: row.url, day: row.day, ts: row.ts, title: row.title, digest: row.digest, key: row.r2_key }));

  const wanted = new Set<string>();
  const queue: string[] = [];
  const want = (hash: string) => {
    if (wanted.has(hash)) return;
    wanted.add(hash);
    queue.push(hash);
  };
  for (const row of ledger.db
    .prepare(`SELECT DISTINCT hash FROM asset_ref WHERE domain = ? AND day LIKE ?`)
    .all(domain, `${month}-%`) as { hash: string }[]) {
    want(row.hash);
  }
  for (const page of pages) {
    const html = await store.get(page.key);
    if (html) for (const hash of referencedHashes(new TextDecoder().decode(html))) want(hash);
  }

  const lookup = ledger.db.prepare(`SELECT hash, mime, r2_key FROM asset WHERE hash = ?`);
  const assets: LocalAsset[] = [];
  const notCrawled: string[] = [];
  while (queue.length > 0) {
    const hash = queue.shift()!;
    const row = lookup.get(hash) as { hash: string; mime: string; r2_key: string } | undefined;
    if (!row || !(await store.has(row.r2_key))) {
      notCrawled.push(hash);
      continue;
    }
    assets.push({ hash, mime: row.mime, key: row.r2_key });
    if (/^text\/css\b/i.test(row.mime)) {
      const css = await store.get(row.r2_key);
      if (css) for (const next of referencedHashes(new TextDecoder().decode(css))) want(next);
    }
  }
  return { pages, assets, notCrawled };
}

/** Run `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(lanes);
}

export async function publishMonth(ledger: Ledger, store: BlobStore, options: PublishOptions): Promise<PublishResult> {
  const api = options.api.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log;
  const concurrency = options.concurrency ?? 4;

  /** One API call, retried on a network error, 429 or 5xx — never on a 4xx answer. */
  const call = async (method: string, path: string, body?: string | Uint8Array, headers: Record<string, string> = {}): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetchImpl(`${api}${path}`, {
          method,
          headers: { Authorization: `Bearer ${options.token}`, ...headers },
          ...(body !== undefined ? { body } : {}),
        });
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) return response;
        await response.body?.cancel();
      } catch (err) {
        if (attempt >= RETRY_DELAYS_MS.length) throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  };
  const failure = async (response: Response, what: string): Promise<PublishError> => {
    if (response.status === 401) {
      return new PublishError(`${api} did not accept the saved session. Sign in again: npm run login -- --api=${api}`);
    }
    const detail = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    return new PublishError(`${what}: HTTP ${response.status}${detail ? ` — ${detail.message ?? detail.error}` : ''}`);
  };

  const publication = await collectPublication(ledger, store, options.domain, options.month);
  if (publication.pages.length === 0) {
    throw new PublishError(
      `nothing is crawled for ${options.domain} in ${options.month} yet: run ` +
        `npm run crawl -- --domain=${options.domain} --month=${options.month} first`,
    );
  }

  const opened = await call('POST', '/v1/precrawl/runs', JSON.stringify({ domain: options.domain, month: options.month }), {
    'Content-Type': 'application/json',
  });
  if (!opened.ok) throw await failure(opened, 'could not start publishing');
  const { ingestId } = (await opened.json()) as { ingestId: string };

  // ── Assets: only those the Worker lacks ─────────────────────────────────────
  const missing = new Set<string>();
  const hashes = publication.assets.map((asset) => asset.hash);
  for (let start = 0; start < hashes.length; start += MISSING_BATCH) {
    const response = await call(
      'POST',
      '/v1/precrawl/assets/missing',
      JSON.stringify({ hashes: hashes.slice(start, start + MISSING_BATCH) }),
      { 'Content-Type': 'application/json' },
    );
    if (!response.ok) throw await failure(response, 'could not compare assets');
    for (const hash of ((await response.json()) as { missing: string[] }).missing) missing.add(hash);
  }

  let bytesUploaded = 0;
  let assetsUploaded = 0;
  const toUpload = publication.assets.filter((asset) => missing.has(asset.hash));
  log?.info(`assets: ${toUpload.length} to upload, ${publication.assets.length - toUpload.length} already there`);
  await pool(toUpload, concurrency, async (asset) => {
    const bytes = await store.get(asset.key);
    if (!bytes) return;
    const response = await call('PUT', `/v1/precrawl/assets/${asset.hash}`, bytes, { 'Content-Type': asset.mime });
    if (!response.ok) {
      // A page that references it still loads, without that file; say so and go on.
      log?.warn(`asset ${asset.hash.slice(0, 12)} was refused (HTTP ${response.status})`);
      await response.body?.cancel();
      return;
    }
    await response.body?.cancel();
    assetsUploaded += 1;
    bytesUploaded += bytes.byteLength;
    if (assetsUploaded % 50 === 0) log?.info(`assets: ${assetsUploaded}/${toUpload.length}`);
  });

  // ── Pages ──────────────────────────────────────────────────────────────────
  const pagesFailed: PublishResult['pagesFailed'] = [];
  let pages = 0;
  await pool(publication.pages, concurrency, async (page) => {
    const html = await store.get(page.key);
    if (!html) {
      pagesFailed.push({ url: page.url, day: page.day, reason: 'missing from the local store' });
      return;
    }
    const query = new URLSearchParams({ url: page.url, day: page.day, ts: page.ts });
    const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
    if (page.title) headers['X-CW-Title'] = encodeURIComponent(page.title.slice(0, 300));
    if (page.digest) headers['X-CW-Digest'] = page.digest;
    const response = await call('PUT', `/v1/precrawl/runs/${ingestId}/pages?${query}`, html, headers);
    if (response.status === 401) throw await failure(response, 'publishing a page');
    if (!response.ok) {
      const error = await failure(response, 'refused');
      pagesFailed.push({ url: page.url, day: page.day, reason: error.message });
      return;
    }
    await response.body?.cancel();
    pages += 1;
    bytesUploaded += html.byteLength;
    if (pages % 25 === 0) log?.info(`pages: ${pages}/${publication.pages.length}`);
  });

  const finished = await call('POST', `/v1/precrawl/runs/${ingestId}/finish`);
  if (!finished.ok) throw await failure(finished, 'could not finish publishing');
  await finished.body?.cancel();

  const first = publication.pages.find((page) => !pagesFailed.some((f) => f.url === page.url && f.day === page.day));
  return {
    ingestId,
    pages,
    pagesFailed,
    assetsUploaded,
    assetsAlreadyThere: publication.assets.length - toUpload.length,
    assetsNotCrawled: publication.notCrawled.length,
    bytesUploaded,
    firstRoute: first ? snapshotPath(options.domain, first.day, first.url) : null,
  };
}
