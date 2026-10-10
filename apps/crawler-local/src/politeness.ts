/**
 * Politeness: a per-host rate gate plus a circuit breaker.
 *
 * This is the single most important file in the crawler. The Internet Archive has
 * been fighting waves of high-volume automated traffic and now returns 429s that
 * also catch legitimate clients. A crawler that ignores that will (a) get this IP
 * blocked, (b) make the product look broken, and (c) degrade a service we depend on.
 *
 * So: serialized per host, never faster than `minDelayMs`, exponential backoff with
 * jitter on 429/503, and a breaker that pauses a host rather than retrying into a wall.
 *
 * The backoff math and breaker constants are delegated to `@custom-wayback/shared/policy`
 * — the same module the cloud queue consumer uses — so the two crawl paths cannot
 * drift into behaving differently toward archive.org (plan.md §12, §16).
 *
 * Note for maintainers: no constructor parameter properties anywhere in this package.
 * Node's strip-only TypeScript mode rejects them at runtime.
 */

import {
  applySuccess,
  applyThrottle,
  breakerWaitSeconds,
  emptyThrottleLedger,
  isThrottleStatus,
  type ThrottleLedger,
} from '@custom-wayback/shared';

export class ThrottleError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'ThrottleError';
    this.status = status;
    this.url = url;
  }
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

interface HostState {
  /** Resolves when the next request to this host may start. */
  tail: Promise<void>;
  lastStart: number;
  /** Durable throttle state per host: consecutive count + breaker deadline. */
  ledger: ThrottleLedger;
}

export interface PolitenessOptions {
  minDelayMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  maxAttempts: number;
  onThrottle?: (info: { url: string; status: number; attempt: number; waitMs: number }) => void;
  onBreaker?: (info: { host: string; waitMs: number; consecutive: number }) => void;
}

export interface RequestStats {
  attempts: number;
  ok: number;
  notFound: number;
  throttled: number;
  failed: number;
  timeouts: number;
  bytes: number;
}

export function emptyRequestStats(): RequestStats {
  return { attempts: 0, ok: 0, notFound: 0, throttled: 0, failed: 0, timeouts: 0, bytes: 0 };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A per-host serialized gate. Requests to different hosts may overlap; requests to
 * the same host are spaced by at least `minDelayMs`.
 */
export class PolitenessGate {
  private readonly hosts = new Map<string, HostState>();
  private readonly opts: PolitenessOptions;

  constructor(opts: PolitenessOptions) {
    this.opts = opts;
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = { tail: Promise.resolve(), lastStart: 0, ledger: emptyThrottleLedger() };
      this.hosts.set(host, s);
    }
    return s;
  }

  /** Reserve the next allowed start slot for `host`, awaiting prior work and the delay. */
  async acquire(host: string): Promise<void> {
    const s = this.state(host);
    const prior = s.tail;
    let release!: () => void;
    s.tail = new Promise<void>((r) => (release = r));
    await prior;

    const now = Math.floor(Date.now() / 1000);
    const waitSecs = breakerWaitSeconds(s.ledger, now);
    if (waitSecs > 0) {
      const waitMs = waitSecs * 1000;
      this.opts.onBreaker?.({ host, waitMs, consecutive: s.ledger.consecutive });
      await sleep(waitMs);
    }

    const sinceLast = Date.now() - s.lastStart;
    const wait = this.opts.minDelayMs - sinceLast;
    if (wait > 0) await sleep(wait);
    s.lastStart = Date.now();
    release();
  }

  /**
   * Note a throttle response; returns how long the caller should wait before retrying.
   *
   * Delegates to the shared policy so backoff math is identical to the cloud consumer
   * (plan.md §12, §16).
   */
  noteThrottle(host: string, url: string, status: number, attempt: number): number {
    const s = this.state(host);
    const now = Math.floor(Date.now() / 1000);
    const outcome = applyThrottle(s.ledger, now, this.opts.breakerCooldownMs);
    s.ledger = outcome.state;
    this.opts.onThrottle?.({ url, status, attempt, waitMs: outcome.waitMs });
    return outcome.waitMs;
  }

  noteSuccess(host: string): void {
    const s = this.state(host);
    s.ledger = applySuccess(s.ledger);
  }

  /** Hosts currently in breaker cooldown. */
  get openBreakers(): string[] {
    const now = Math.floor(Date.now() / 1000);
    return [...this.hosts.entries()]
      .filter(([, s]) => breakerWaitSeconds(s.ledger, now) > 0)
      .map(([h]) => h);
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Abort a single attempt after this long. Default 20 s. */
  timeoutMs?: number;
}

/**
 * Fetch with politeness applied. Never throws on a single failure: returns a
 * discriminated result so callers decide (a 404 is data, not an exception).
 */
export type FetchOutcome =
  | { kind: 'ok'; status: number; body: Uint8Array; contentType: string; finalUrl: string; attempts: number }
  | { kind: 'notfound'; status: number; attempts: number }
  | { kind: 'throttled'; status: number; attempts: number }
  | { kind: 'error'; message: string; status?: number; attempts: number; timedOut: boolean };

export class PoliteFetcher {
  readonly gate: PolitenessGate;
  readonly stats: RequestStats = emptyRequestStats();
  private readonly opts: PolitenessOptions;
  private readonly userAgent: string;

  constructor(userAgent: string, opts: PolitenessOptions) {
    this.userAgent = userAgent;
    this.opts = opts;
    this.gate = new PolitenessGate(opts);
  }

  get options(): PolitenessOptions {
    return this.opts;
  }

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchOutcome> {
    const host = new URL(url).host;
    const attemptsMax = this.opts.maxAttempts;
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= attemptsMax; attempt++) {
      await this.gate.acquire(host);
      this.stats.attempts += 1;

      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? 20_000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': this.userAgent,
            Accept: '*/*',
            'Accept-Encoding': 'gzip, deflate',
            ...options.headers,
          },
        });

        if (isThrottleStatus(res.status)) {
          lastStatus = res.status;
          this.stats.throttled += 1;
          const waitMs = this.gate.noteThrottle(host, url, res.status, attempt);
          if (attempt === attemptsMax) {
            return { kind: 'throttled', status: res.status, attempts: attempt };
          }
          await sleep(waitMs);
          continue;
        }

        if (res.status === 404 || res.status === 410) {
          this.stats.notFound += 1;
          return { kind: 'notfound', status: res.status, attempts: attempt };
        }

        if (!res.ok) {
          // 504 Gateway Timeout from the CDX server lands here; do not retry it hard.
          lastStatus = res.status;
          this.stats.failed += 1;
          if (attempt === attemptsMax || res.status === 504) {
            return {
              kind: 'error',
              message: `HTTP ${res.status}`,
              status: res.status,
              attempts: attempt,
              timedOut: res.status === 504 || res.status === 408,
            };
          }
          await sleep(500 * attempt);
          continue;
        }

        const buf = new Uint8Array(await res.arrayBuffer());
        this.gate.noteSuccess(host);
        this.stats.ok += 1;
        this.stats.bytes += buf.byteLength;
        return {
          kind: 'ok',
          status: res.status,
          body: buf,
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
          finalUrl: res.url || url,
          attempts: attempt,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const aborted = controller.signal.aborted;
        if (aborted) this.stats.timeouts += 1;
        else this.stats.failed += 1;
        if (attempt === attemptsMax) {
          return {
            kind: 'error',
            message: aborted ? `timed out after ${timeoutMs} ms` : message,
            attempts: attempt,
            timedOut: aborted,
          };
        }
        await sleep(700 * attempt);
      } finally {
        clearTimeout(timeout);
      }
    }

    return {
      kind: 'error',
      message: `exhausted ${attemptsMax} attempts`,
      status: lastStatus,
      attempts: attemptsMax,
      timedOut: false,
    };
  }
}
