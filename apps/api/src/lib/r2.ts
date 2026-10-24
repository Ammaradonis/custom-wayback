/**
 * R2 helpers: read-through cache, write, delete, and the post-serve purge logic.
 *
 * Storage-cost strategy (your requirement):
 *  1. Content is written to R2 during ingest.
 *  2. When the viewer Worker serves a page, it records served_at in D1.
 *  3. A scheduled purge (Cron Trigger or Durable Object alarm) deletes R2 objects
 *     where served_at IS NOT NULL AND purged_at IS NULL AND
 *     served_at < now - PURGE_GRACE_SECONDS.
 *  4. Assets (content-addressed) have their ref_count decremented; they are
 *     deleted from R2 only when ref_count reaches 0.
 *
 * The exception is a pre-crawled page (`snapshots.source = 'local'`, published by the
 * local crawler — routes/precrawl.ts): it is kept, because archive.org would not serve
 * it to the Worker and it is the copy that exists for exactly that case.
 *
 * The D1 row is never deleted — it is the navigation ledger.
 */

import type { Env } from "../env.js";
import { R2, PURGE_GRACE_SECONDS } from "@custom-wayback/shared";

// ── Key builders ─────────────────────────────────────────────────────────────

export function pageKey(domain: string, day: string, urlHash: string): string {
  return `${R2.PAGES}/${domain}/${day}/${urlHash}.html`;
}

export function assetKey(hash: string): string {
  return `${R2.ASSETS}/${hash.slice(0, 2)}/${hash}`;
}

export function metaKey(domain: string, month: string): string {
  return `${R2.META}/${domain}/${month}/manifest.json.gz`;
}

// ── Read-through (Workers Cache API → R2) ────────────────────────────────────

/**
 * Serve a cached page with read-through from R2.
 *
 * Uses the Workers Cache API so subsequent requests are CDN hits (no R2 Class B).
 * Returns null if not found — caller falls through to on-demand fetch.
 *
 * ## Always returns a response the caller may modify
 *
 * A `Response` handed back by `cache.match()` has **immutable headers**, and so
 * does one that has been through `HTMLRewriter`. Mutating either throws
 * `TypeError: Can't modify immutable headers`, which in a Worker surfaces as a
 * 500 — and only on the *cached* path, so it appears on the second visit to a
 * page, never the first. That is the worst kind of bug to find in production.
 *
 * So this function never returns a cached object directly: it re-wraps the body
 * and headers into a Response it owns. The cost is one header copy per request;
 * the benefit is that the viewer can attach a CSP and toolbar headers without
 * knowing or caring where the bytes came from.
 */
export async function serveCachedPage(
  r2Key: string,
  cacheKey: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return mutableCopy(cached);

  const obj = await env.STORAGE.get(r2Key);
  if (!obj) return null;

  const headers = new Headers({
    "Content-Type": obj.httpMetadata?.contentType ?? "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Custom-Wayback-Source": "r2",
  });

  const response = new Response(obj.body, { headers });
  // Store in CDN cache — fire-and-forget.
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/**
 * A Response whose headers the caller may edit.
 *
 * `new Response(body, { headers: new Headers(existing.headers) })` is the
 * portable way to get there: copying the headers out of the immutable object
 * produces a mutable one, and the body is a stream so this stays cheap.
 */
export function mutableCopy(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

// ── Write ────────────────────────────────────────────────────────────────────

export async function putPage(
  env: Env,
  r2Key: string,
  body: ReadableStream | ArrayBuffer,
  contentType = "text/html; charset=utf-8",
): Promise<void> {
  await env.STORAGE.put(r2Key, body, {
    httpMetadata: { contentType },
  });
}

export async function putAsset(
  env: Env,
  hash: string,
  body: ReadableStream | ArrayBuffer,
  contentType: string,
): Promise<void> {
  await env.STORAGE.put(assetKey(hash), body, {
    httpMetadata: { contentType },
    // Immutable by construction — set far-future Cache-Control.
    customMetadata: { cacheControl: "public, max-age=31536000, immutable" },
  });
}

// ── Purge ────────────────────────────────────────────────────────────────────

interface PurgeBatch {
  id: string; // snapshot.id
  r2Key: string;
  domain: string;
}

/**
 * Delete R2 content for pages that have been served and are past the grace period.
 * Called from a Cron Trigger (or manually). Returns the count of deletions.
 */
export async function purgeStaleCachedPages(env: Env): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - PURGE_GRACE_SECONDS;
  // `r2_key AS r2Key`: D1 returns column names as written, and without the alias
  // `row.r2Key` was undefined, so the delete below removed nothing while the row was
  // marked purged — every purged page's blob stayed in the bucket, unreferenced.
  //
  // A pre-crawled page (`source = 'local'`) is never purged: it is in R2 because
  // archive.org would not serve it to the Worker, so it is the only copy the viewer has.
  const rows = await env.DB.prepare(
    `SELECT id, r2_key AS r2Key, domain FROM snapshots
     WHERE served_at IS NOT NULL
       AND purged_at IS NULL
       AND r2_key IS NOT NULL
       AND served_at < ?
       AND (source IS NULL OR source != 'local')
     LIMIT 200`,
  )
    .bind(cutoff)
    .all<PurgeBatch>();

  if (!rows.results.length) return 0;

  let deleted = 0;
  for (const row of rows.results) {
    try {
      await env.STORAGE.delete(row.r2Key);
      await env.DB.prepare(
        `UPDATE snapshots SET purged_at = ?, r2_key = NULL WHERE id = ?`,
      )
        .bind(Math.floor(Date.now() / 1000), row.id)
        .run();
      // Track deletion in usage ledger.
      await env.DB.prepare(
        `INSERT INTO usage_ledger (domain, kind, value, recorded_at) VALUES (?,?,?,?)`,
      )
        .bind(row.domain, "r2_delete", 1, Math.floor(Date.now() / 1000))
        .run();
      deleted++;
    } catch {
      // Non-fatal: the cron will retry on the next run.
    }
  }
  return deleted;
}

/**
 * Mark a page as served so the purge job can schedule its deletion.
 * Fire-and-forget from the viewer Worker (ctx.waitUntil).
 */
export async function markServed(env: Env, snapshotId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE snapshots SET served_at = ? WHERE id = ? AND served_at IS NULL`,
  )
    .bind(Math.floor(Date.now() / 1000), snapshotId)
    .run();
}
