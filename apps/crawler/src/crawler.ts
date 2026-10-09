/**
 * Main crawl orchestrator.
 *
 * Algorithm:
 *  1. CDX survey → day buckets → best-capture per URL per day (§6.2).
 *  2. Prioritise the NAV_SET (top in-site links) for first-batch fetching.
 *  3. Fetch HTML pages up to MAX_PAGES_PER_MONTH, at ≤ 1 rps/host.
 *  4. Rewrite each page → extract asset references + internal links.
 *  5. Fetch assets, dedup by content-hash before uploading.
 *  6. Write rewritten HTML + assets to R2 (or local storage in dev).
 *  7. Write snapshot + asset + link rows to D1/SQLite.
 *  8. On budget exhaustion: stop gracefully (remaining pages are on-demand).
 *
 * Storage-cost strategy:
 *  - Content is uploaded once. The viewer Worker marks pages served_at after
 *    first delivery. A Cron Trigger then deletes R2 blobs past the grace period.
 *  - Assets are content-addressed and shared; ref_count tracks how many
 *    snapshots still reference each asset. Asset R2 deletion is separate.
 */

import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import { surveyCdx, bucketByDay } from "./lib/cdx.js";
import { Fetcher } from "./lib/fetcher.js";
import { rewritePage } from "./lib/rewriter.js";
import {
  Storage,
  pageKey,
  assetKey,
  sha256Hex,
  urlHash,
} from "./lib/storage.js";
import {
  updateIngestStatus,
  recordUsage,
} from "./lib/ledger.js";
import type { CrawlBudget } from "@custom-wayback/shared";

export interface CrawlOptions {
  ingestId: string;
  domain: string;
  /** "YYYY-MM" */
  month: string;
  budget: CrawlBudget;
  userAgent: string;
  storage: Storage;
  db: Database.Database;
}

export async function crawl(opts: CrawlOptions): Promise<void> {
  const { ingestId, domain, month, budget, userAgent, storage, db } = opts;
  const [year, mon] = month.split("-") as [string, string];
  const from = `${year}${mon}01`;
  // Last day of the month.
  const lastDay = new Date(parseInt(year), parseInt(mon), 0).getDate();
  const to = `${year}${mon}${String(lastDay).padStart(2, "0")}`;

  console.log(`[crawl] ${domain} ${month} — CDX survey…`);
  updateIngestStatus(db, ingestId, "surveying");

  // ── Step 1: CDX survey ────────────────────────────────────────────────────
  let rows;
  try {
    rows = await surveyCdx(domain, { userAgent, from, to, matchType: "domain" });
  } catch (err) {
    updateIngestStatus(db, ingestId, "failed", {
      errorMessage: String(err),
    });
    throw err;
  }

  const dayBuckets = bucketByDay(rows);
  const allUrls = [...new Set(rows.map((r) => r.original))];
  const pagesTotal = Math.min(allUrls.length, budget.maxPagesPerMonth);

  console.log(
    `[crawl] Survey complete: ${rows.length} CDX rows, ` +
    `${dayBuckets.size} days, ${allUrls.length} unique URLs. ` +
    `Budget: ${pagesTotal} pages.`,
  );

  updateIngestStatus(db, ingestId, "fetching", {
    pagesTotal,
    pagesDone: 0,
  });

  // ── Step 2: Build page queue (NAV_SET first) ──────────────────────────────
  // Collect one representative capture per URL (the "best day" entry).
  const urlQueue: Array<{ url: string; ts: string; day: string }> = [];
  for (const bucket of dayBuckets.values()) {
    urlQueue.push({
      url: bucket.chosen.original,
      ts: bucket.chosen.timestamp,
      day: bucket.day,
    });
  }
  // Deduplicate: one entry per URL (keep the latest day's capture).
  const seen = new Map<string, { ts: string; day: string }>();
  for (const entry of urlQueue) {
    const existing = seen.get(entry.url);
    if (!existing || entry.day > existing.day) seen.set(entry.url, entry);
  }
  const pageQueue = [...seen.entries()]
    .map(([url, { ts, day }]) => ({ url, ts, day }))
    .slice(0, pagesTotal);

  // ── Step 3 + 4 + 5 + 6 + 7: Fetch → Rewrite → Store ─────────────────────
  const fetcher = new Fetcher(budget, userAgent);
  await fetcher.init();

  let pagesDone = 0;
  let bytesStored = 0;
  const assetQueue: Array<{ url: string; ts: string }> = [];
  const storedAssets = new Set<string>(); // hashes already uploaded

  for (const { url, ts, day } of pageQueue) {
    if (bytesStored >= budget.maxBytesPerMonth) {
      console.warn("[crawl] Byte cap reached. Stopping page fetch.");
      break;
    }

    let fetchResult;
    try {
      fetchResult = await fetcher.fetchPage(url, ts);
    } catch (err) {
      console.error(`[crawl] Failed to fetch ${url}: ${err}`);
      continue;
    }

    if (fetchResult.statusCode !== 200) continue;

    // Rewrite.
    const { html, assets, links } = rewritePage(
      fetchResult.html,
      domain,
      day,
      ts,
      url,
    );

    // Enqueue assets (bounded per page).
    for (const asset of assets.slice(0, budget.maxAssetsPerPage)) {
      assetQueue.push(asset);
    }

    // Store rewritten HTML.
    const uhash = urlHash(url);
    const r2Key = pageKey(domain, day, uhash);
    const htmlBuf = Buffer.from(html, "utf8");

    try {
      await storage.put(r2Key, htmlBuf, "text/html; charset=utf-8");
      bytesStored += htmlBuf.length;
      recordUsage(db, domain, month, "r2_put", 1);
      recordUsage(db, domain, month, "bytes_stored", htmlBuf.length);
    } catch (err) {
      console.error(`[crawl] Storage write failed for ${url}: ${err}`);
      continue;
    }

    // Write snapshot row.
    const snapshotId = sha256Hex(url + "|" + day).slice(0, 32);
    db.prepare(
      `INSERT OR REPLACE INTO snapshots
       (id, ingest_id, domain, url, day, ts, status_code, mime, r2_key, page_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      snapshotId,
      ingestId,
      domain,
      url,
      day,
      ts,
      fetchResult.statusCode,
      "text/html",
      r2Key,
      `${domain}/${day}/${uhash}`,
    );

    // Write link resolution rows.
    for (const link of links.slice(0, 200)) {
      try {
        db.prepare(
          `INSERT OR IGNORE INTO link_resolutions
           (id, domain, day, from_url, to_url, kind)
           VALUES (?,?,?,?,?,?)`,
        ).run(
          sha256Hex(domain + day + url + link).slice(0, 24),
          domain,
          day,
          url,
          link,
          "internal",
        );
      } catch {
        // Ignore duplicate constraint.
      }
    }

    pagesDone++;
    updateIngestStatus(db, ingestId, "fetching", {
      pagesDone,
      bytesStored,
    });

    if (pagesDone % 10 === 0) {
      console.log(
        `[crawl] ${pagesDone}/${pagesTotal} pages, ` +
        `${(bytesStored / 1024 / 1024).toFixed(1)} MB stored.`,
      );
    }
  }

  // ── Step 5: Fetch + store assets ──────────────────────────────────────────
  console.log(`[crawl] Fetching ${assetQueue.length} asset references…`);
  updateIngestStatus(db, ingestId, "rewriting", {
    assetsTotal: assetQueue.length,
    assetsDone: 0,
  });

  let assetsDone = 0;
  for (const { url, ts } of assetQueue) {
    const result = await fetcher.fetchAsset(url, ts);
    if (!result) { assetsDone++; continue; }

    const hash = sha256Hex(Buffer.from(result.buffer));

    if (!storedAssets.has(hash)) {
      storedAssets.add(hash);
      const key = assetKey(hash);
      if (!(await storage.exists(key))) {
        const buf = Buffer.from(result.buffer);
        await storage.put(key, buf, result.contentType);
        bytesStored += buf.length;
        recordUsage(db, domain, month, "r2_put", 1);
        recordUsage(db, domain, month, "bytes_stored", buf.length);

        db.prepare(
          `INSERT OR REPLACE INTO assets
           (hash, mime, bytes, r2_key, first_seen_at, ref_count)
           VALUES (?,?,?,?,?,?)`,
        ).run(hash, result.contentType, result.buffer.byteLength, key, Math.floor(Date.now() / 1000), 1);
      }
    }

    assetsDone++;
    if (assetsDone % 50 === 0) {
      updateIngestStatus(db, ingestId, "rewriting", {
        assetsDone,
        bytesStored,
      });
    }
  }

  await fetcher.close();

  const finalStatus = pagesDone >= pagesTotal ? "ready" : "partial";
  updateIngestStatus(db, ingestId, finalStatus, {
    pagesDone,
    assetsDone,
    bytesStored,
  });

  console.log(
    `[crawl] Done. Status=${finalStatus}. Pages=${pagesDone}, ` +
    `Assets=${assetsDone}, Stored=${(bytesStored / 1024 / 1024).toFixed(1)} MB`,
  );
}
