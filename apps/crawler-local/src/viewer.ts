/**
 * Local read-through viewer for the mirror — the Phase 1 stand-in for the Phase 2
 * Workers viewer, using the same routes:
 *
 *   /                              shell
 *   /api/sites                     available domain+month mirrors
 *   /api/manifest?domain=&month=   manifest (pages, days, report)
 *   /a/<domain>/<day>/<path>       snapshot page, from the content-addressed store
 *   /assets/<aa>/<hash>            asset bytes, immutable
 *   /raw/<domain>/<day>/<path>     verbatim original capture (debugging)
 *
 * It reads from the same ledger and blob store the crawler writes, so nothing is
 * duplicated. If a page is not stored it says so, and offers the nearest stored day
 * for that URL — it never silently fetches from archive.org. That is the point of a
 * mirror.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Ledger } from './db.ts';
import type { SnapshotRow } from './db.ts';
import { FsBlobStore } from './storage.ts';
import type { Logger } from './logger.ts';
import { VIEWER_HTML } from './viewer-html.ts';

export interface ViewerOptions {
  outDir: string;
  dbPath: string;
  port: number;
  host: string;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';
const CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
  "font-src 'self' data:; frame-src 'self'; form-action 'none'; object-src 'none'; base-uri 'self'";

interface DomainCache {
  /** `${domain}\0${day}\0${routePath}` -> original URL */
  byRoute: Map<string, string>;
  /** `${routePath}` -> sorted list of days that have it */
  daysByRoute: Map<string, string[]>;
}

export function startViewer(opts: ViewerOptions, log: Logger): Promise<string> {
  const ledger = new Ledger(opts.dbPath);
  const blobs = new FsBlobStore(opts.outDir);
  const caches = new Map<string, DomainCache>();

  const cacheFor = (domain: string): DomainCache => {
    const cached = caches.get(domain);
    if (cached) return cached;
    const cache: DomainCache = { byRoute: new Map(), daysByRoute: new Map() };
    for (const row of ledger.allSnapshots(domain)) {
      const route = routePathFor(row);
      cache.byRoute.set(`${domain}\u0000${row.day}\u0000${route}`, row.url);
      const days = cache.daysByRoute.get(route) ?? [];
      days.push(row.day);
      cache.daysByRoute.set(route, days);
    }
    for (const days of cache.daysByRoute.values()) days.sort();
    caches.set(domain, cache);
    return cache;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error('viewer request failed', { message: err instanceof Error ? err.message : String(err) });
      send(res, 500, 'text/plain', new TextEncoder().encode('internal error'));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      send(res, 400, 'text/plain', new TextEncoder().encode('bad path encoding'));
      return;
    }

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': NO_STORE });
      res.end(VIEWER_HTML);
      return;
    }

    if (path === '/api/sites') {
      const rows = ledger.db
        .prepare(
          `SELECT domain, substr(day, 1, 7) AS month, COUNT(*) AS pages, COUNT(DISTINCT day) AS days
             FROM snapshot GROUP BY domain, month ORDER BY domain, month`,
        )
        .all() as { domain: string; month: string; pages: number; days: number }[];
      sendJson(res, { sites: rows });
      return;
    }

    if (path === '/api/manifest') {
      const domain = url.searchParams.get('domain');
      const month = url.searchParams.get('month');
      if (!domain || !month) {
        sendJson(res, { error: 'domain and month are required' }, 400);
        return;
      }
      const file = `${opts.outDir.replace(/\\/g, '/')}/meta/${domain}/${month}/manifest.json`;
      try {
        const raw = await readFile(file);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE });
        res.end(raw);
        return;
      } catch {
        // Assembled live from the ledger when the manifest file is absent.
        const pages = ledger.allSnapshots(domain).filter((p) => p.day.startsWith(month));
        sendJson(res, {
          version: 1,
          domain,
          month,
          days: [...new Set(pages.map((p) => p.day))].sort(),
          pages: pages.map((p) => ({
            url: p.url,
            day: p.day,
            ts: p.ts,
            title: p.title,
            bytes: p.bytes,
            route: routeForRow(domain, p),
            blob: p.r2Key,
            extras: 0,
          })),
          stats: null,
          note: 'manifest.json not found; this list was assembled from the ledger',
        });
        return;
      }
    }

    const assetMatch = /^\/assets\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(path);
    if (assetMatch) {
      const hash = assetMatch[2]!;
      const body = await blobs.get(`assets/${assetMatch[1]}/${hash}`);
      if (!body) {
        send(res, 404, 'text/plain', new TextEncoder().encode('asset not stored'));
        return;
      }
      const row = ledger.db.prepare(`SELECT mime FROM asset WHERE hash = ?`).get(hash) as
        | { mime: string }
        | undefined;
      res.writeHead(200, {
        'content-type': row?.mime ?? 'application/octet-stream',
        'cache-control': IMMUTABLE,
        'x-content-type-options': 'nosniff',
        'content-length': String(body.byteLength),
      });
      res.end(Buffer.from(body));
      return;
    }

    if (path.startsWith('/raw/')) {
      const body = await blobs.get(path.slice(1));
      if (!body) {
        send(res, 404, 'text/plain', new TextEncoder().encode('original not stored'));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': NO_STORE,
        'content-length': String(body.byteLength),
      });
      res.end(Buffer.from(body));
      return;
    }

    // The trailing path group is optional and normalised to "/" so that a site root
    // ("https://example.com/") is addressable as both /a/<domain>/<day> and
    // /a/<domain>/<day>/ -- the former is what a normalised URL produces, the latter
    // is what a link with href="/" produces. Both must resolve to the same page.
    const route = matchSnapshotRoute(path);
    if (route) {
      const { domain, day, routePath } = route;
      const cache = cacheFor(domain);
      const target = cache.byRoute.get(`${domain}\u0000${day}\u0000${routePath}`);

      if (!target) {
        // Same page on another day? Redirect to the nearest stored day rather than
        // 404, mirroring the "nearest capture" behaviour the link ledger records.
        const otherDays = cache.daysByRoute.get(routePath);
        const nearest = otherDays?.find((d) => d >= day) ?? otherDays?.[otherDays.length - 1];
        if (nearest) {
          res.writeHead(302, { location: `/a/${domain}/${nearest}${routePath}`, 'cache-control': NO_STORE });
          res.end();
          return;
        }
        const stored = cache.byRoute.size;
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': NO_STORE });
        res.end(
          `<!DOCTYPE html><meta charset="utf-8"><title>Not in this mirror</title>` +
            `<div style="font:15px/1.5 system-ui;padding:28px;max-width:60ch;color:#ddd;background:#0b0d10;min-height:100vh">` +
            `<h1 style="font-size:19px;margin:0 0 10px">Not in this mirror</h1>` +
            `<p><code>${escapeHtml(day + routePath)}</code> was not ingested.</p>` +
            `<p style="color:#939cab">This mirror holds ${stored} page-load(s) for ${escapeHtml(domain)}. ` +
            `Re-run the ingest with a larger <code>--max-pages</code> (or a complete CDX survey) to add more, ` +
            `or open <a style="color:#4c9aff" href="/?domain=${encodeURIComponent(domain)}">the picker</a>.</p>` +
            `</div>`,
        );
        return;
      }

      const row = ledger.snapshotFor(domain, target, day);
      if (!row) {
        send(res, 404, 'text/plain', new TextEncoder().encode('ledger row missing'));
        return;
      }
      const body = await blobs.get(row.r2Key);
      if (!body) {
        send(res, 404, 'text/plain', new TextEncoder().encode('page blob missing'));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': NO_STORE,
        'content-security-policy': CSP,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-length': String(body.byteLength),
      });
      res.end(Buffer.from(body));
      return;
    }

    send(res, 404, 'text/plain', new TextEncoder().encode('not found'));
  }

  return new Promise<string>((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port, opts.host, () => {
      const url = `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}/`;
      log.info('viewer listening', { url, outDir: opts.outDir });
      resolve(url);
    });
  });
}

/**
 * Parse a snapshot route path.
 *
 * The trailing path group is optional and normalised to "/" so a site root is
 * addressable as both `/a/<domain>/<day>` and `/a/<domain>/<day>/`: the first is what
 * a normalised URL produces, the second is what a link with href="/" produces, and
 * both must resolve to the same stored page.
 *
 * Exported for tests: getting this wrong made every site root return 404 even though
 * the page was on disk and correctly recorded in the ledger.
 */
export function matchSnapshotRoute(
  path: string,
): { domain: string; day: string; routePath: string } | undefined {
  const match = /^\/a\/([^/]+)\/(\d{4}-\d{2}-\d{2})(\/.*)?$/.exec(path);
  if (!match) return undefined;
  return {
    domain: match[1]!,
    day: match[2]!,
    routePath: match[3] && match[3] !== '' ? match[3] : '/',
  };
}

/**
 * Route path as the crawler writes it: pathname with the query percent-encoded.
 * The root path is normalised to "/" (never ""), so it round-trips through
 * matchSnapshotRoute() and stays consistent with snapshotPath() in urlutil.ts.
 */
function routePathFor(row: SnapshotRow): string {
  try {
    const url = new URL(row.url);
    const pathname = url.pathname === '' ? '/' : url.pathname;
    const query = url.search ? `%3F${encodeURIComponent(url.search.slice(1))}` : '';
    return `${pathname}${query}`;
  } catch {
    return row.url;
  }
}

function routeForRow(domain: string, row: SnapshotRow): string {
  return `/a/${domain}/${row.day}${routePathFor(row)}`;
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': NO_STORE,
    'content-length': String(body.byteLength),
  });
  res.end(Buffer.from(body));
}

function send(res: ServerResponse, status: number, type: string, body: Uint8Array): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': String(body.byteLength),
  });
  res.end(Buffer.from(body));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
