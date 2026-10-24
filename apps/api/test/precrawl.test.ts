/**
 * Pre-crawled pages, end to end on the server: the local crawler's upload API
 * (routes/precrawl.ts), the purge that must leave those pages alone (lib/r2.ts), and
 * what the viewer is told when archive.org throttles a page (routes/viewer.ts).
 *
 * These run against **real SQLite** with every D1 migration applied, rather than a
 * query-matching fake: the routes are mostly SQL — an upsert keyed like the cloud
 * crawl's, a purge predicate, a nearest-day search — and the point is to run that SQL.
 * R2 is a map that checks SHA-256 checksums the way R2 does, because "an asset can only
 * be stored under its own hash" rests on that check.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { Hono } from "hono";

import { issueJwt } from "../src/lib/auth.ts";
import { purgeStaleCachedPages } from "../src/lib/r2.ts";
import { manifestRouter } from "../src/routes/manifest.ts";
import { precrawlRouter } from "../src/routes/precrawl.ts";
import { fetchOnDemandResource, viewerRouter } from "../src/routes/viewer.ts";
import type { Env } from "../src/env.ts";
import "./support/html-rewriter.ts";

// ── Real SQLite behind the D1 interface ──────────────────────────────────────

type Row = Record<string, unknown>;

/** The `node:sqlite` surface used here, declared structurally (it is still flagged). */
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Row[];
    run(...params: unknown[]): { changes: number | bigint };
  };
}

async function openDatabase(t: { skip(reason: string): void }): Promise<SqliteDb | null> {
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => SqliteDb;
    };
    const db = new DatabaseSync(":memory:");
    // `run-api-tests.mjs` runs with cwd = apps/api; the migrations are the deployed ones.
    const dir = resolve(process.cwd(), "..", "..", "packages", "shared", "migrations");
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      db.exec(await readFile(join(dir, file), "utf8"));
    }
    return db;
  } catch (err) {
    t.skip(`node:sqlite is not available in this Node build (${(err as Error).message})`);
    return null;
  }
}

function d1(db: SqliteDb): D1Database {
  const param = (value: unknown) => (value === undefined ? null : typeof value === "boolean" ? Number(value) : value);
  const statement = (sql: string, params: unknown[] = []) => {
    const stmt = {
      bind: (...values: unknown[]) => statement(sql, values.map(param)),
      async first<T>(column?: string): Promise<T | null> {
        const row = db.prepare(sql).all(...params)[0];
        if (!row) return null;
        return (column ? row[column] : row) as T;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[], success: true, meta: {} };
      },
      async run() {
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return stmt;
  };
  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: { run(): Promise<unknown> }[]) {
      const results = [];
      for (const s of statements) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;
}

/** R2, with the one behaviour these routes depend on: a checksum that does not match fails. */
class FakeR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  readonly deleted: string[] = [];

  binding(): R2Bucket {
    const objects = this.objects;
    const deleted = this.deleted;
    const bytesOf = (value: unknown): Uint8Array => {
      if (typeof value === "string") return new TextEncoder().encode(value);
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      throw new TypeError("FakeR2 takes strings and byte buffers");
    };
    return {
      async put(key: string, value: unknown, options?: { sha256?: string; httpMetadata?: { contentType?: string } }) {
        const bytes = bytesOf(value).slice();
        if (options?.sha256 && createHash("sha256").update(bytes).digest("hex") !== options.sha256) {
          throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
        }
        objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
        return { key };
      },
      async get(key: string) {
        const object = objects.get(key);
        if (!object) return null;
        return {
          key,
          body: new Response(object.bytes).body,
          httpMetadata: { contentType: object.contentType },
          httpEtag: '"fake"',
          writeHttpMetadata(headers: Headers) {
            if (object.contentType) headers.set("Content-Type", object.contentType);
          },
          async text() {
            return new TextDecoder().decode(object.bytes);
          },
        };
      },
      async delete(key: string) {
        deleted.push(key);
        objects.delete(key);
      },
    } as unknown as R2Bucket;
  }
}

// ── The harness ──────────────────────────────────────────────────────────────

const DOMAIN = "example.com";
const MONTH = "2024-03";

interface Harness {
  raw: SqliteDb;
  env: Env;
  r2: FakeR2;
  kv: Map<string, string>;
  /** Every URL the Worker fetched (archive.org, in these tests). */
  fetches: string[];
  call(path: string, init?: RequestInit, auth?: boolean): Promise<Response>;
  settle(): Promise<void>;
  restore(): void;
}

async function harness(
  t: { skip(reason: string): void },
  respond: (url: string) => Response = () => new Response("unexpected fetch", { status: 500 }),
): Promise<Harness | null> {
  const raw = await openDatabase(t);
  if (!raw) return null;
  const r2 = new FakeR2();
  const kv = new Map<string, string>();
  const env = {
    DB: d1(raw),
    STORAGE: r2.binding(),
    COVERAGE_KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
      async delete(key: string) {
        kv.delete(key);
      },
    },
    JWT_SECRET: "a-test-secret-that-is-at-least-32-bytes-long",
    CRAWLER_USER_AGENT: "CustomWaybackTestBot/1.0",
    SNAPSHOT_BEHAVIOR: "nearest",
    PURGE_GRACE_SECONDS: "1800",
  } as unknown as Env;

  raw.exec(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'reader@example.org', 'x', 0)`);
  raw.exec(`INSERT INTO sessions (id, user_id, issued_at, expires_at) VALUES ('s1', 'u1', 0, 9999999999)`);
  const token = await issueJwt("u1", "s1", env.JWT_SECRET);

  const app = new Hono<{ Bindings: Env }>();
  app.route("/v1/precrawl", precrawlRouter);
  app.route("/v1", manifestRouter);
  app.route("/a", viewerRouter);

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  const fetches: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as { caches?: unknown }).caches;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetches.push(url);
    return respond(url);
  }) as typeof globalThis.fetch;
  const edge = new Map<string, Response>();
  (globalThis as { caches?: unknown }).caches = {
    default: {
      async match(key: string) {
        return edge.get(key)?.clone();
      },
      async put(key: string, response: Response) {
        edge.set(key, new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
      },
      async delete(key: string) {
        return edge.delete(key);
      },
    },
  };

  return {
    raw,
    env,
    r2,
    kv,
    fetches,
    call(path, init = {}, auth = true) {
      const headers = new Headers(init.headers);
      if (auth) headers.set("Authorization", `Bearer ${token}`);
      return Promise.resolve(app.request(path, { ...init, headers }, env, ctx));
    },
    async settle() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
    restore() {
      globalThis.fetch = originalFetch;
      (globalThis as { caches?: unknown }).caches = originalCaches;
    },
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Rows as plain objects: `node:sqlite` returns null-prototype ones, which deepEqual rejects. */
function rows(h: Harness, sql: string, ...params: unknown[]): Row[] {
  return h.raw.prepare(sql).all(...params).map((row) => ({ ...row }));
}

async function openRun(h: Harness, domain = DOMAIN, month = MONTH): Promise<string> {
  const response = await h.call("/v1/precrawl/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain, month }),
  });
  assert.ok(response.status === 200 || response.status === 201, `runs answered ${response.status}`);
  return ((await response.json()) as { ingestId: string }).ingestId;
}

function pageHtml(title: string, asset: string): string {
  return `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="/assets/${asset.slice(0, 2)}/${asset}"></head><body><h1>${title}</h1><p>Archived words worth finding.</p></body></html>`;
}

async function publishPage(h: Harness, ingestId: string, url: string, day: string, html: string): Promise<Response> {
  const ts = `${day.replace(/-/g, "")}101500`;
  return h.call(
    `/v1/precrawl/runs/${ingestId}/pages?url=${encodeURIComponent(url)}&day=${day}&ts=${ts}`,
    { method: "PUT", headers: { "Content-Type": "text/html; charset=utf-8" }, body: html },
  );
}

// ── The upload API ───────────────────────────────────────────────────────────

test("publishing needs a signed-in account", async (t) => {
  const h = await harness(t);
  if (!h) return;
  try {
    for (const [method, path] of [
      ["GET", `/v1/precrawl?domain=${DOMAIN}&month=${MONTH}`],
      ["POST", "/v1/precrawl/runs"],
      ["POST", "/v1/precrawl/assets/missing"],
      ["PUT", `/v1/precrawl/assets/${"a".repeat(64)}`],
      ["PUT", "/v1/precrawl/runs/x/pages"],
      ["POST", "/v1/precrawl/runs/x/finish"],
    ] as const) {
      const response = await h.call(path, { method }, false);
      assert.equal(response.status, 401, `${method} ${path}`);
    }
    assert.equal(rows(h, "SELECT * FROM domains").length, 0);
  } finally {
    h.restore();
  }
});

test("a run tracks the domain for the account, is reused, and waits for a cloud crawl of the month", async (t) => {
  const h = await harness(t);
  if (!h) return;
  try {
    const first = await h.call("/v1/precrawl/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "https://www.Example.com/", month: MONTH }),
    });
    assert.equal(first.status, 201);
    const { ingestId, domain } = (await first.json()) as { ingestId: string; domain: string };
    assert.equal(domain, DOMAIN, "normalised the way POST /v1/domains stores it");
    assert.deepEqual(rows(h, "SELECT user_id, domain, tracking_status FROM domains"), [
      { user_id: "u1", domain: DOMAIN, tracking_status: "active" },
    ]);
    // Never handed to the cloud crawl's stalled-job re-drive.
    assert.deepEqual(rows(h, "SELECT status, stage FROM ingests WHERE id = ?", ingestId), [{ status: "partial", stage: "done" }]);

    assert.equal(await openRun(h), ingestId, "the same month publishes into the same run");

    h.raw.exec(`UPDATE ingests SET status = 'fetching' WHERE id = '${ingestId}'`);
    const busy = await h.call("/v1/precrawl/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: DOMAIN, month: MONTH }),
    });
    assert.equal(busy.status, 409);
    assert.equal(((await busy.json()) as { error: string }).error, "crawl_in_progress");

    for (const body of [{ domain: DOMAIN, month: "2024-13" }, { domain: "not a host", month: MONTH }, {}]) {
      const bad = await h.call("/v1/precrawl/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
  } finally {
    h.restore();
  }
});

test("an asset is stored only under its own hash, and only what the Worker lacks is asked for", async (t) => {
  const h = await harness(t);
  if (!h) return;
  try {
    const css = new TextEncoder().encode("body { color: rebeccapurple }");
    const hash = sha256(css);
    const other = sha256("not uploaded");

    const forged = await h.call(`/v1/precrawl/assets/${other}`, {
      method: "PUT",
      headers: { "Content-Type": "text/css" },
      body: css,
    });
    assert.equal(forged.status, 422, "bytes under someone else's hash are refused");
    assert.equal(h.r2.objects.size, 0);
    assert.equal(rows(h, "SELECT * FROM assets").length, 0);

    const stored = await h.call(`/v1/precrawl/assets/${hash}`, {
      method: "PUT",
      headers: { "Content-Type": "text/css" },
      body: css,
    });
    assert.equal(stored.status, 201);
    assert.equal(h.r2.objects.get(`assets/${hash.slice(0, 2)}/${hash}`)?.contentType, "text/css");
    assert.deepEqual(rows(h, "SELECT mime, bytes, r2_key FROM assets WHERE hash = ?", hash), [
      { mime: "text/css", bytes: css.byteLength, r2_key: `assets/${hash.slice(0, 2)}/${hash}` },
    ]);

    const missing = await h.call("/v1/precrawl/assets/missing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: [hash, other, other] }),
    });
    assert.deepEqual(await missing.json(), { missing: [other] });

    const junk = await h.call("/v1/precrawl/assets/missing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: ["../../etc/passwd"] }),
    });
    assert.equal(junk.status, 400);
  } finally {
    h.restore();
  }
});

test("a published page is kept, listed in the month, and served from R2 without archive.org", async (t) => {
  const h = await harness(t);
  if (!h) return;
  try {
    const ingestId = await openRun(h);
    const css = "h1 { font-weight: 900 }";
    const cssHash = sha256(css);
    await h.call(`/v1/precrawl/assets/${cssHash}`, { method: "PUT", headers: { "Content-Type": "text/css" }, body: css });

    // What the route refuses: another site, a day outside the run's month, a timestamp
    // that is not on that day.
    const html = pageHtml("Products", cssHash);
    assert.equal((await publishPage(h, ingestId, "https://elsewhere.test/products", "2024-03-10", html)).status, 400);
    assert.equal((await publishPage(h, ingestId, "https://www.example.com/products", "2024-04-01", html)).status, 400);
    const wrongTs = await h.call(
      `/v1/precrawl/runs/${ingestId}/pages?url=${encodeURIComponent("https://www.example.com/products")}&day=2024-03-10&ts=20240311000000`,
      { method: "PUT", body: html },
    );
    assert.equal(wrongTs.status, 400);

    const published = await publishPage(h, ingestId, "https://www.example.com/products?page=2", "2024-03-10", html);
    assert.equal(published.status, 201);
    const { route } = (await published.json()) as { route: string };
    assert.equal(route, `/a/${DOMAIN}/2024-03-10/products%3Fpage%3D2`);
    await h.settle();

    const [row] = rows(h, "SELECT * FROM snapshots");
    assert.equal(row?.source, "local");
    assert.equal(row?.page_id, "/products%3Fpage%3D2");
    assert.equal(row?.ingest_id, ingestId);
    assert.equal(row?.title, "Products");
    assert.equal(row?.delta_days, 0);
    assert.equal(h.r2.objects.has(String(row?.r2_key)), true);
    assert.equal(rows(h, "SELECT snapshot_id FROM search_docs").length, 1, "indexed for search");

    const finished = await h.call(`/v1/precrawl/runs/${ingestId}/finish`, { method: "POST" });
    assert.deepEqual(await finished.json(), { ingestId, pages: 1 });
    assert.deepEqual(rows(h, "SELECT status, pages_done FROM ingests WHERE id = ?", ingestId), [{ status: "ready", pages_done: 1 }]);

    const manifest = (await (await h.call(`/v1/manifest?domain=${DOMAIN}&month=${MONTH}`)).json()) as {
      pages: { route: string; stored: boolean }[];
    };
    assert.deepEqual(manifest.pages.map((p) => [p.route, p.stored]), [[route, true]]);

    const status = await (await h.call(`/v1/precrawl?domain=${DOMAIN}&month=${MONTH}`)).json();
    assert.deepEqual(status, { domain: DOMAIN, month: MONTH, pages: 1, days: 1, bytes: html.length });

    // The viewer serves it from R2 and asks archive.org nothing.
    const page = await h.call(route, {}, false);
    const served = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("X-Custom-Wayback-Source"), "r2");
    assert.match(served, /<h1>Products<\/h1>/);
    assert.match(served, /id="cw-runtime-script"/, "with the current runtime, not the upload's");
    assert.deepEqual(h.fetches, []);
  } finally {
    h.restore();
  }
});

// ── The purge ────────────────────────────────────────────────────────────────

test("the purge deletes the cloud crawl's blob by its real key, and never a pre-crawled page", async (t) => {
  const h = await harness(t);
  if (!h) return;
  try {
    const ingestId = await openRun(h);
    const local = await publishPage(h, ingestId, "https://example.com/kept", "2024-03-10", pageHtml("Kept", sha256("x")));
    assert.equal(local.status, 201);
    await h.settle();
    const cloudKey = `pages/${DOMAIN}/2024-03-11/cloud.html`;
    await h.env.STORAGE.put(cloudKey, "<html>cloud</html>");
    h.raw.exec(
      `INSERT INTO snapshots (id, ingest_id, domain, url, day, ts, status_code, mime, r2_key, page_id)
       VALUES ('cloud', '${ingestId}', '${DOMAIN}', 'https://example.com/gone', '2024-03-11', '20240311000000', 200, 'text/html', '${cloudKey}', '/gone')`,
    );
    // Both were served long ago.
    h.raw.exec(`UPDATE snapshots SET served_at = 1000`);

    const purged = await purgeStaleCachedPages(h.env);
    assert.equal(purged, 1);
    assert.deepEqual(h.r2.deleted, [cloudKey], "the blob itself, not `undefined`");
    assert.equal(h.r2.objects.has(cloudKey), false);
    const state = "SELECT purged_at IS NOT NULL AS purged, r2_key IS NOT NULL AS stored FROM snapshots WHERE ";
    assert.deepEqual(rows(h, `${state} id = 'cloud'`), [{ purged: 1, stored: 0 }]);
    assert.deepEqual(rows(h, `${state} source = 'local'`), [{ purged: 0, stored: 1 }]);
  } finally {
    h.restore();
  }
});

// ── What a throttled page tells the viewer ───────────────────────────────────

function failureDetail(html: string): Record<string, unknown> {
  const match = /var detail=(\{.*?\});function reportFailure/.exec(html);
  assert.ok(match?.[1], "the failure page carries its detail");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

test("a throttled page tells the viewer which capture to replay and the nearest stored copy", async (t) => {
  const throttled = (url: string) =>
    url.includes("web.archive.org") ? new Response("Too Many Requests", { status: 429 }) : new Response("", { status: 500 });
  const h = await harness(t, throttled);
  if (!h) return;
  try {
    const ingestId = await openRun(h);
    assert.equal((await publishPage(h, ingestId, "https://example.com/about", "2024-03-10", pageHtml("About", sha256("y")))).status, 201);
    await h.settle();

    const response = await h.call(`/a/${DOMAIN}/2024-03-15/about`, {}, false);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("X-Custom-Wayback-Archive"), "throttled");
    const { id, ...detail } = failureDetail(await response.text());
    assert.match(String(id), /^[0-9a-f-]{36}$/, "each failure page has its own id");
    assert.deepEqual(detail, {
      reason: "archive-throttled",
      url: "https://example.com/about",
      ts: "20240315120000",
      nearestStoredDay: "2024-03-10",
      nearestStoredPrecrawled: true,
      status: 502,
      message: "archive.org is rate-limiting requests right now. Wait a minute, then reload.",
    });
    assert.equal(h.fetches.filter((url) => url.includes("web.archive.org")).length, 1, "one request, no retries into the throttle");

    // A page with no stored copy anywhere still gets the replay offer.
    const alone = await h.call(`/a/${DOMAIN}/2024-03-15/contact`, {}, false);
    assert.equal(failureDetail(await alone.text()).nearestStoredDay, null);
  } finally {
    h.restore();
  }
});

test("a throttled file is marked in Server-Timing, the one part a page can read", async (t) => {
  const h = await harness(t, () => new Response("Too Many Requests", { status: 429 }));
  if (!h) return;
  try {
    const response = await fetchOnDemandResource("20240315120000", "https://example.com/site.css", h.env, undefined, "style");
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Server-Timing"), "cw-throttled");
    assert.equal(response.headers.get("Timing-Allow-Origin"), "*");
    assert.equal(response.headers.get("Cache-Control"), "no-store", "a throttle is never cached");
  } finally {
    h.restore();
  }
});
