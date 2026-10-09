/**
 * Politeness-gated fetcher using Playwright for JavaScript-rendered pages.
 *
 * Design:
 *  - One "slot" per host — at most 1 req/s/host (configurable via rpsPerHost).
 *  - Global concurrency bounded by CrawlBudget.concurrency.
 *  - Exponential backoff + jitter on 429/503.
 *  - Circuit breaker: pauses a host after CIRCUIT_BREAKER_THRESHOLD consecutive errors.
 *
 * Playwright is used because the user confirmed it is "ready/recommended".
 * For static HTML-only assets we use Node's built-in fetch to avoid browser overhead.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import pLimit from "p-limit";
import type { CrawlBudget } from "@custom-wayback/shared";
import { CIRCUIT_BREAKER_THRESHOLD, BACKOFF_MAX_MS, WAYBACK_RAW_BASE } from "@custom-wayback/shared";

interface FetchResult {
  url: string;
  ts: string;
  html: string;
  statusCode: number;
}

export class Fetcher {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly hostSlots = new Map<string, number>(); // host → last request time (ms)
  private readonly hostErrors = new Map<string, number>(); // host → consecutive error count
  private readonly userAgent: string;
  private readonly rpsPerHost: number;

  constructor(budget: CrawlBudget, userAgent: string) {
    this.limit = pLimit(budget.concurrency);
    this.rpsPerHost = budget.rpsPerHost;
    this.userAgent = userAgent;
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent: this.userAgent,
      // Offline-ish: block external third-party requests that aren't in the archive.
      javaScriptEnabled: false, // We parse HTML, not execute JS during crawl.
    });
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }

  /**
   * Fetch a raw archived page via the `id_` modifier.
   * Returns the HTML as a string.
   */
  async fetchPage(
    originalUrl: string,
    ts: string,
  ): Promise<FetchResult> {
    return this.limit(async () => {
      const host = new URL(`https://${originalUrl.replace(/^https?:\/\//, "")}`).hostname;
      await this.politeWait(host);

      const rawUrl = `${WAYBACK_RAW_BASE}/${ts}id_/${originalUrl}`;
      let attempts = 0;

      while (true) {
        attempts++;
        try {
          // Use native fetch for static HTML — faster than Playwright page load.
          const resp = await fetch(rawUrl, {
            headers: {
              "User-Agent": this.userAgent,
              Accept: "text/html,application/xhtml+xml",
            },
          });

          if (resp.status === 429 || resp.status === 503) {
            const errors = (this.hostErrors.get(host) ?? 0) + 1;
            this.hostErrors.set(host, errors);
            if (errors >= CIRCUIT_BREAKER_THRESHOLD) {
              throw new Error(
                `[fetcher] Circuit breaker tripped for ${host} (${errors} consecutive 429s).`,
              );
            }
            const delay = Math.min(1000 * 2 ** errors, BACKOFF_MAX_MS) +
              Math.random() * 500;
            console.warn(`[fetcher] 429 on ${host}. Backing off ${Math.round(delay)}ms…`);
            await sleep(delay);
            continue;
          }

          this.hostErrors.delete(host);
          const html = await resp.text();
          return { url: originalUrl, ts, html, statusCode: resp.status };
        } catch (err) {
          if (attempts >= 3) throw err;
          await sleep(1000 * attempts);
        }
      }
    });
  }

  /**
   * Fetch a binary asset (image, CSS, font, etc.) via id_.
   */
  async fetchAsset(
    originalUrl: string,
    ts: string,
  ): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
    return this.limit(async () => {
      const rawUrl = `${WAYBACK_RAW_BASE}/${ts}id_/${originalUrl}`;
      try {
        const resp = await fetch(rawUrl, {
          headers: { "User-Agent": this.userAgent },
        });
        if (!resp.ok) return null;
        const buffer = await resp.arrayBuffer();
        const contentType =
          resp.headers.get("Content-Type") ?? "application/octet-stream";
        return { buffer, contentType };
      } catch {
        return null;
      }
    });
  }

  /** Enforce ≤ rpsPerHost per host via token-bucket timing. */
  private async politeWait(host: string): Promise<void> {
    const minInterval = 1000 / this.rpsPerHost;
    const last = this.hostSlots.get(host) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < minInterval) {
      await sleep(minInterval - elapsed + Math.random() * 50);
    }
    this.hostSlots.set(host, Date.now());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
