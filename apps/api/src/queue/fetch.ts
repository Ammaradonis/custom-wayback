/**
 * Politeness for the cloud ingest path.
 *
 * The local runner (`apps/crawler-local/src/politeness.ts`) can afford an
 * in-process, per-host serialized gate because it is one long-lived process.
 * A Worker is not: invocations are short, independent, and may run in several
 * isolates at once. So politeness is achieved differently here, and it is worth
 * being explicit about how, because "we kept the 1 req/s rule" is exactly the
 * kind of claim that quietly stops being true:
 *
 *  1. **Volume**: one queue message does at most `maxRequests` archive.org
 *     requests. The queue's `max_concurrency` (wrangler.toml) bounds how many
 *     messages are in flight, and therefore bounds global request rate. The
 *     budget lives in configuration, not in a hopeful comment.
 *  2. **Spacing**: a fixed per-request minimum delay (`minDelayMs`) is applied
 *     inside a message, so a burst cannot come from one invocation.
 *  3. **Backoff**: 429/502/503 get exponential backoff with full jitter, biased
 *     upward so we actually slow down.
 *  4. **Circuit breaker**: after `breakerThreshold` consecutive throttles the
 *     job is parked for `breakerCooldownMs` and the message is re-enqueued with
 *     the same stage. Nothing is lost and nothing hammers.
 *  5. **Telemetry**: every backoff and breaker trip is written to
 *     `throttle_events`, so "are we being a good citizen?" has an answer with a
 *     number attached.
 */

import type { Env } from "../env.js";
import {
  applySuccess,
  applyThrottle,
  emptyThrottleLedger,
  isThrottleStatus,
  type ThrottleLedger,
} from "@custom-wayback/shared";

export interface FetchBudget {
  /** Maximum archive.org requests this single invocation may spend. */
  maxRequests: number;
  /** Minimum spacing between requests within this invocation. */
  minDelayMs: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Attempts per URL (including the first). */
  maxAttempts: number;
  breakerCooldownMs: number;
}

export const DEFAULT_FETCH_BUDGET: FetchBudget = {
  maxRequests: 8,
  minDelayMs: 900,
  timeoutMs: 20_000,
  maxAttempts: 3,
  breakerCooldownMs: 5 * 60_000,
};

export type FetchOutcome =
  | { kind: "ok"; status: number; body: Uint8Array; contentType: string; finalUrl: string }
  | { kind: "notfound"; status: number }
  | { kind: "throttled"; status: number; waitMs: number }
  | { kind: "error"; message: string; status?: number };

export class BudgetExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhausted";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** archive.org's error pages sometimes arrive with HTTP 200. */
export function looksLikeWaybackError(body: Uint8Array, contentType: string): boolean {
  if (!contentType.includes("text/html")) return false;
  const head = new TextDecoder().decode(body.subarray(0, 4096)).toLowerCase();
  return (
    head.includes("wayback machine doesn't have that page archived") ||
    head.includes("this page is not available in the wayback machine") ||
    head.includes("cannot find the requested url") ||
    head.includes("the wayback machine has not archived that url")
  );
}

/**
 * A per-invocation polite fetcher. Tracks its own request budget, spacing, and
 * throttle streak; the durable half of that state (consecutive count, breaker
 * deadline) is persisted by the caller into the `ingests` row, because it must
 * survive the invocation that observed it.
 *
 * The backoff and breaker *rules* live in `@custom-wayback/shared/policy` — the
 * same code the local runner uses. This class only owns the transport.
 */
export class CloudFetcher {
  readonly userAgent: string;
  readonly budget: FetchBudget;
  /** archive.org requests spent in this invocation. */
  requests = 0;
  throttled = 0;
  bytes = 0;
  /** Durable throttle state, as of the last response in this invocation. */
  ledger: ThrottleLedger = emptyThrottleLedger();
  private lastWaitMs = 0;
  private lastStart = 0;
  onThrottle?: (info: { url: string; status: number; attempt: number; waitMs: number }) => void;

  constructor(userAgent: string, budget: FetchBudget = DEFAULT_FETCH_BUDGET) {
    this.userAgent = userAgent;
    this.budget = budget;
  }

  get consecutiveThrottles(): number {
    return this.ledger.consecutive;
  }

  get lastBackoffMs(): number {
    return this.lastWaitMs;
  }

  /**
   * Seed the streak from persisted state so a job that was throttled in an
   * earlier invocation does not start over at "one throttle" and retry
   * immediately.
   */
  seed(state: ThrottleLedger): void {
    this.ledger = state;
  }

  private async spend(): Promise<void> {
    if (this.requests >= this.budget.maxRequests) {
      throw new BudgetExhausted(
        `invocation request budget (${this.budget.maxRequests}) exhausted`,
      );
    }
    const sinceLast = Date.now() - this.lastStart;
    const wait = this.budget.minDelayMs - sinceLast;
    if (wait > 0 && this.lastStart > 0) await sleep(wait);
    this.lastStart = Date.now();
    this.requests += 1;
  }

  async fetch(url: string, opts: { timeoutMs?: number; accept?: string } = {}): Promise<FetchOutcome> {
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= this.budget.maxAttempts; attempt++) {
      await this.spend();

      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? this.budget.timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          redirect: "follow",
          signal: controller.signal,
          headers: {
            "User-Agent": this.userAgent,
            Accept: opts.accept ?? "*/*",
            "Accept-Encoding": "gzip, deflate",
          },
        });

        if (isThrottleStatus(res.status)) {
          lastStatus = res.status;
          this.throttled += 1;

          // The shared policy decides the wait and whether the breaker trips.
          const decision = applyThrottle(this.ledger, Math.floor(Date.now() / 1000), this.budget.breakerCooldownMs);
          this.ledger = decision.state;
          this.lastWaitMs = decision.waitMs;
          this.onThrottle?.({ url, status: res.status, attempt, waitMs: decision.waitMs });

          if (attempt === this.budget.maxAttempts || decision.breakNow) {
            return { kind: "throttled", status: res.status, waitMs: decision.waitMs };
          }
          await sleep(decision.waitMs);
          continue;
        }

        if (res.status === 404 || res.status === 410) return { kind: "notfound", status: res.status };

        if (!res.ok) {
          lastStatus = res.status;
          if (attempt === this.budget.maxAttempts || res.status === 504) {
            return { kind: "error", message: `HTTP ${res.status}`, status: res.status };
          }
          await sleep(500 * attempt);
          continue;
        }

        const body = new Uint8Array(await res.arrayBuffer());
        this.ledger = applySuccess(this.ledger);
        this.bytes += body.byteLength;
        return {
          kind: "ok",
          status: res.status,
          body,
          contentType: res.headers.get("content-type") ?? "application/octet-stream",
          finalUrl: res.url || url,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === this.budget.maxAttempts) {
          return {
            kind: "error",
            message: controller.signal.aborted ? `timed out after ${timeoutMs} ms` : message,
          };
        }
        await sleep(700 * attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    return { kind: "error", message: `exhausted ${this.budget.maxAttempts} attempts`, ...(lastStatus !== undefined ? { status: lastStatus } : {}) };
  }

  /** True when the shared policy tripped the breaker during this invocation. */
  get shouldBreak(): boolean {
    return this.ledger.breakerOpenUntil !== null;
  }
}

/** Record a throttle event. Best-effort: telemetry must never fail a crawl. */
export async function recordThrottle(
  env: Env,
  args: {
    domain: string;
    month: string;
    ingestId: string;
    url: string;
    status: number;
    waitMs: number;
    attempt: number;
    kind: "backoff" | "breaker" | "give_up";
    breakerOpen: boolean;
  },
): Promise<void> {
  let host = "";
  try {
    host = new URL(args.url).host;
  } catch {
    host = args.url.slice(0, 100);
  }
  try {
    await env.DB.prepare(
      `INSERT INTO throttle_events
         (domain, month, ingest_id, host, status, wait_ms, attempt, breaker_open, kind, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        args.domain,
        args.month,
        args.ingestId,
        host,
        args.status,
        args.waitMs,
        args.attempt,
        args.breakerOpen ? 1 : 0,
        args.kind,
        Math.floor(Date.now() / 1000),
      )
      .run();
  } catch {
    // Swallowed on purpose — see the function comment.
  }
}
