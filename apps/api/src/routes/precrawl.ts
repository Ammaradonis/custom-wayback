/**
 * Pre-crawled pages: how the local crawler hands its pages to the Worker.
 *
 * archive.org rate-limits the Worker's own requests far harder than a reader's
 * connection — at times it refuses most of them — so a page the Worker has to fetch
 * may simply not load. The local crawler (`apps/crawler-local`) fetches through the
 * reader's own connection instead, and `crawl-local publish` uploads the result here.
 * The viewer then serves those pages from R2, asking archive.org for nothing.
 *
 *   GET  /v1/precrawl?domain=&month=          what is pre-crawled (the viewer's panel)
 *   POST /v1/precrawl/runs                    { domain, month } → { ingestId }
 *   POST /v1/precrawl/assets/missing          { hashes } → { missing }
 *   PUT  /v1/precrawl/assets/:hash            body: the asset's bytes
 *   PUT  /v1/precrawl/runs/:ingestId/pages    ?url=&day=&ts=  body: the rewritten HTML
 *   POST /v1/precrawl/runs/:ingestId/finish   → { pages }
 *
 * Assets go first and pages last, so a page is never visible before what it needs.
 *
 * ## Trust
 *
 * Every call needs a signed-in account, and accounts exist only for addresses the owner
 * listed in `ALLOWED_EMAILS` (routes/auth.ts). Assets are content-addressed, and R2
 * checks each upload's SHA-256 against its key, so bytes can never be stored under
 * another file's hash. A page is stored only for a domain the account tracks, and it is
 * served like every other archived page: the current runtime, the snapshot policy and
 * the sandbox are applied when it is read (`prepareCachedSnapshot`), not trusted from
 * the upload.
 *
 * ## Kept, not purged
 *
 * The post-serve purge (lib/r2.ts) deletes what the cloud crawl stored once it has been
 * read, because archive.org can serve it again. A pre-crawled page is in R2 because it
 * could not, so its row carries `source = 'local'` and the purge leaves it alone.
 */

import { Hono } from "hono";
import { DEFAULT_BUDGET } from "@custom-wayback/shared";
import { extractTitle, hashString, sameSite, snapshotPath } from "@custom-wayback/pipeline";
import { authenticateRequest } from "../lib/auth.js";
import { indexStatements } from "../lib/index-page.js";
import { assetKey } from "../lib/r2.js";
import { ulid } from "../lib/ulid.js";
import { pageIdFor, sha256Hex } from "../queue/ingest.js";
import type { Env } from "../env.js";

export const precrawlRouter = new Hono<{ Bindings: Env }>();

/** A rewritten page larger than this is not a page anyone can read in a frame. */
export const MAX_PAGE_BYTES = 10 * 1024 * 1024;
/** Per asset; the Workers request-body ceiling is far above it. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
/** Hashes per `assets/missing` call. */
const MAX_HASHES = 1000;
/** D1 binds at most 100 parameters per statement. */
const HASH_CHUNK = 90;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HASH = /^[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;[^\r\n]*)?$/i;
/** Cloud-crawl states: a month in one of these is being written by the queue right now. */
const CRAWLING = new Set(["queued", "surveying", "fetching", "rewriting"]);

precrawlRouter.use("/*", async (c, next) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
});

/** `www.Example.com` → `example.com`, as `POST /v1/domains` stores it; null if not a host. */
function normaliseHost(raw: string): string | null {
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

interface Run {
  id: string;
  month: string;
  domain: string;
  domainId: string;
}

async function ownedRun(env: Env, userId: string, ingestId: string): Promise<Run | null> {
  return env.DB.prepare(
    `SELECT i.id AS id, i.month AS month, d.domain AS domain, d.id AS domainId
     FROM ingests i JOIN domains d ON d.id = i.domain_id
     WHERE i.id = ? AND d.user_id = ? AND d.tracking_status != 'deleted'`,
  )
    .bind(ingestId, userId)
    .first<Run>();
}

// ── Status, for the viewer's fallback panel ──────────────────────────────────

precrawlRouter.get("/", async (c) => {
  const domain = normaliseHost(c.req.query("domain") ?? "");
  const month = c.req.query("month") ?? "";
  if (!domain || !MONTH.test(month)) return c.json({ error: "domain and month (YYYY-MM) are required" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS pages, COUNT(DISTINCT day) AS days, COALESCE(SUM(bytes), 0) AS bytes
     FROM snapshots
     WHERE domain = ? AND day LIKE ? AND source = 'local'
       AND r2_key IS NOT NULL AND purged_at IS NULL`,
  )
    .bind(domain, `${month}-%`)
    .first<{ pages: number; days: number; bytes: number }>();
  return c.json({
    domain,
    month,
    pages: Number(row?.pages ?? 0),
    days: Number(row?.days ?? 0),
    bytes: Number(row?.bytes ?? 0),
  });
});

// ── 1. Open a run ────────────────────────────────────────────────────────────

precrawlRouter.post("/runs", async (c) => {
  const userId = c.get("userId" as never) as string;
  const body = (await c.req.json().catch(() => null)) as { domain?: unknown; month?: unknown } | null;
  const domain = typeof body?.domain === "string" ? normaliseHost(body.domain) : null;
  const month = typeof body?.month === "string" && MONTH.test(body.month) ? body.month : null;
  if (!domain || !month) return c.json({ error: "domain and month (YYYY-MM) are required" }, 400);
  const now = Math.floor(Date.now() / 1000);

  // The month is listed in this account's manifest only for a domain it tracks.
  let domainId = (
    await c.env.DB.prepare(
      "SELECT id FROM domains WHERE user_id = ? AND domain = ? AND tracking_status != 'deleted'",
    )
      .bind(userId, domain)
      .first<{ id: string }>()
  )?.id;
  if (!domainId) {
    domainId = ulid();
    await c.env.DB.prepare(
      `INSERT INTO domains (id, user_id, domain, host_filter, budget_json, tracking_status, added_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(domainId, userId, domain, null, JSON.stringify(DEFAULT_BUDGET), "active", now)
      .run();
  }

  // One ingest per (domain, month) — `ingests_domain_month` is unique — so a month the
  // cloud crawl already has is published into, not beside.
  const existing = await c.env.DB.prepare("SELECT id, status FROM ingests WHERE domain_id = ? AND month = ?")
    .bind(domainId, month)
    .first<{ id: string; status: string }>();
  if (existing) {
    if (CRAWLING.has(existing.status)) {
      // Its queue consumer rewrites the same rows: the two would overwrite each other.
      return c.json(
        {
          error: "crawl_in_progress",
          message: `A cloud crawl of ${domain} for ${month} is still running. Wait for it to finish, or cancel it, then publish.`,
        },
        409,
      );
    }
    return c.json({ ingestId: existing.id, domain, month, created: false });
  }

  // `stage = 'done'` keeps the stalled-job re-drive (index.ts) from ever handing this
  // run to the cloud crawl; `partial` until `finish` says every page is in.
  const ingestId = ulid();
  await c.env.DB.prepare(
    `INSERT INTO ingests (id, domain_id, month, status, stage, started_at)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(ingestId, domainId, month, "partial", "done", now)
    .run();
  return c.json({ ingestId, domain, month, created: true }, 201);
});

// ── 2. Assets ────────────────────────────────────────────────────────────────

precrawlRouter.post("/assets/missing", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { hashes?: unknown } | null;
  const hashes = Array.isArray(body?.hashes) ? body.hashes : null;
  if (!hashes || hashes.length > MAX_HASHES || !hashes.every((h) => typeof h === "string" && HASH.test(h))) {
    return c.json({ error: `hashes must be at most ${MAX_HASHES} lowercase sha256 hex strings` }, 400);
  }
  const wanted = [...new Set(hashes as string[])];
  const present = new Set<string>();
  for (let start = 0; start < wanted.length; start += HASH_CHUNK) {
    const chunk = wanted.slice(start, start + HASH_CHUNK);
    const rows = await c.env.DB.prepare(
      `SELECT hash FROM assets WHERE r2_deleted_at IS NULL AND hash IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<{ hash: string }>();
    for (const row of rows.results ?? []) present.add(row.hash);
  }
  return c.json({ missing: wanted.filter((hash) => !present.has(hash)) });
});

precrawlRouter.put("/assets/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!HASH.test(hash)) return c.json({ error: "the key is a lowercase sha256 hex digest" }, 400);
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > MAX_ASSET_BYTES) return c.json({ error: `assets are limited to ${MAX_ASSET_BYTES} bytes` }, 413);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_ASSET_BYTES) return c.json({ error: `assets are limited to ${MAX_ASSET_BYTES} bytes` }, 413);

  const declaredType = (c.req.header("Content-Type") ?? "").trim();
  const contentType = MEDIA_TYPE.test(declaredType) ? declaredType : "application/octet-stream";
  const key = assetKey(hash);
  try {
    // R2 refuses the write when the bytes' SHA-256 is not `hash`.
    await c.env.STORAGE.put(key, body, {
      sha256: hash,
      httpMetadata: { contentType },
      customMetadata: { cacheControl: "public, max-age=31536000, immutable" },
    });
  } catch {
    return c.json({ error: "the bytes do not hash to the key" }, 422);
  }
  await c.env.DB.prepare(
    `INSERT INTO assets (hash, mime, bytes, r2_key, first_seen_at, ref_count)
     VALUES (?,?,?,?,?,1)
     ON CONFLICT(hash) DO UPDATE SET r2_deleted_at = NULL, ref_count = ref_count + 1`,
  )
    .bind(hash, contentType, body.byteLength, key, Math.floor(Date.now() / 1000))
    .run();
  return c.json({ hash, bytes: body.byteLength }, 201);
});

// ── 3. Pages ─────────────────────────────────────────────────────────────────

precrawlRouter.put("/runs/:ingestId/pages", async (c) => {
  const userId = c.get("userId" as never) as string;
  const run = await ownedRun(c.env, userId, c.req.param("ingestId"));
  if (!run) return c.json({ error: "Not found" }, 404);

  const rawUrl = c.req.query("url") ?? "";
  const day = c.req.query("day") ?? "";
  const ts = c.req.query("ts") ?? "";
  let url: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    parsed.hash = "";
    url = parsed.href;
  } catch {
    return c.json({ error: "url must be an absolute http(s) URL" }, 400);
  }
  if (!sameSite(url, `https://${run.domain}/`)) return c.json({ error: `url is not a page of ${run.domain}` }, 400);
  if (!DAY.test(day) || !day.startsWith(`${run.month}-`)) {
    return c.json({ error: `day must be a YYYY-MM-DD in ${run.month}` }, 400);
  }
  if (!/^\d{14}$/.test(ts) || !ts.startsWith(day.replace(/-/g, ""))) {
    return c.json({ error: "ts must be the 14-digit capture timestamp, on that day" }, 400);
  }
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > MAX_PAGE_BYTES) return c.json({ error: `pages are limited to ${MAX_PAGE_BYTES} bytes` }, 413);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PAGE_BYTES) {
    return c.json({ error: `a page is 1 to ${MAX_PAGE_BYTES} bytes of HTML` }, 413);
  }
  const html = new TextDecoder().decode(bytes);

  // The cloud crawl's key and id for the same page and day, so a pre-crawled copy
  // replaces whatever the cloud stored rather than standing next to it.
  const r2Key = `pages/${run.domain}/${day}/${hashString(url)}.html`;
  await c.env.STORAGE.put(r2Key, bytes, { httpMetadata: { contentType: "text/html; charset=utf-8" } });

  const snapshotId = (await sha256Hex(new TextEncoder().encode(`${run.domain}|${url}|${day}`))).slice(0, 32);
  const contentDigest = (await sha256Hex(bytes)).slice(0, 32);
  let title: string | null = null;
  try {
    title = decodeURIComponent(c.req.header("X-CW-Title") ?? "").slice(0, 500) || null;
  } catch {
    title = null;
  }
  title ??= extractTitle(html);
  const digest = (c.req.header("X-CW-Digest") ?? "").trim().slice(0, 64) || null;

  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO snapshots
       (id, ingest_id, domain, url, day, ts, status_code, mime, digest, bytes, r2_key, page_id,
        served_at, purged_at, resolved_day, resolved_ts, delta_days, content_digest, title, source)
     VALUES (?,?,?,?,?,?,200,'text/html',?,?,?,?, NULL, NULL, ?, ?, 0, ?, ?, 'local')`,
  )
    .bind(snapshotId, run.id, run.domain, url, day, ts, digest, bytes.byteLength, r2Key, pageIdFor(url), day, ts, contentDigest, title)
    .run();

  // Search is a feature, not the product: a page that fails to index is still served.
  c.executionCtx.waitUntil(
    (async () => {
      const statements = indexStatements(c.env, {
        snapshotId,
        domain: run.domain,
        url,
        day,
        ts,
        html,
        bytes: bytes.byteLength,
      });
      if (statements.length > 0) await c.env.DB.batch(statements);
    })().catch((err) => {
      console.error(`[precrawl] search index failed for ${url}: ${err instanceof Error ? err.message : err}`);
    }),
  );

  return c.json({ snapshotId, route: snapshotPath(run.domain, day, url) }, 201);
});

// ── 4. Close the run ─────────────────────────────────────────────────────────

precrawlRouter.post("/runs/:ingestId/finish", async (c) => {
  const userId = c.get("userId" as never) as string;
  const run = await ownedRun(c.env, userId, c.req.param("ingestId"));
  if (!run) return c.json({ error: "Not found" }, 404);
  const now = Math.floor(Date.now() / 1000);

  // A run this route opened (`partial`, never finished) is now complete. A cloud crawl
  // that failed has pages after all, so it becomes `partial`, which lists it. A finished
  // cloud crawl keeps its own status.
  await c.env.DB.prepare(
    `UPDATE ingests SET
       status = CASE
         WHEN status = 'partial' AND finished_at IS NULL THEN 'ready'
         WHEN status = 'failed' THEN 'partial'
         ELSE status END,
       finished_at = COALESCE(finished_at, ?),
       pages_done = (SELECT COUNT(*) FROM snapshots WHERE ingest_id = ?),
       pages_total = MAX(pages_total, (SELECT COUNT(*) FROM snapshots WHERE ingest_id = ?))
     WHERE id = ?`,
  )
    .bind(now, run.id, run.id, run.id)
    .run();
  await c.env.DB.prepare("UPDATE domains SET last_crawled_at = ? WHERE id = ?").bind(now, run.domainId).run();
  await c.env.COVERAGE_KV.delete(`coverage:${run.domain}:${run.month}`).catch(() => undefined);

  const counts = await c.env.DB.prepare(
    `SELECT COUNT(*) AS pages FROM snapshots WHERE ingest_id = ? AND source = 'local'`,
  )
    .bind(run.id)
    .first<{ pages: number }>();
  return c.json({ ingestId: run.id, pages: Number(counts?.pages ?? 0) });
});
