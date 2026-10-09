/**
 * The politeness policy â€” one implementation, shared by every crawler.
 *
 * This file exists because the backoff and breaker rules were written twice: once
 * for the local Node runner (`apps/crawler-local/src/politeness.ts`) and once for
 * the cloud queue consumer (`apps/api/src/queue/fetch.ts`). Two copies of a rule
 * this important is one copy too many â€” the failure mode of a divergence is that
 * one path quietly hammers archive.org while the other behaves, and nobody
 * notices until access is lost (plan.md Â§12, Â§16).
 *
 * Everything here is pure: no timers, no I/O, no randomness source you cannot
 * seed. Jitter is injected, so the tests can assert the *bounds* deterministically
 * rather than asserting "it looked random".
 */

/** Consecutive throttle responses before the breaker opens. */
export const BREAKER_THRESHOLD = 5;

/** Backoff ceiling in milliseconds. Beyond this we are not backing off, we are stopped. */
export const BACKOFF_CEILING_MS = 60_000;

/** First backoff step. Doubles each consecutive throttle up to the ceiling. */
export const BACKOFF_BASE_MS = 1_500;

/** HTTP statuses that mean "slow down", as distinct from "this capture is gone". */
export const THROTTLE_STATUSES: readonly number[] = [429, 502, 503];

export function isThrottleStatus(status: number): boolean {
  return THROTTLE_STATUSES.includes(status);
}

export interface BackoffDecision {
  /** Milliseconds to wait before the next attempt. */
  waitMs: number;
  /** Consecutive-throttle count *after* this event. */
  consecutive: number;
  /** True when this event trips the breaker. */
  breakNow: boolean;
}

/**
 * Full-jitter exponential backoff, biased upward.
 *
 * Textbook "full jitter" is `random(0, base)`, which is optimal for *spreading*
 * retries but means a single client can retry almost immediately and still be
 * inside the policy. Since the concern here is one crawler against one archive,
 * the wait is `base/2 + random(0, base/2)` â€” still jittered, still decorrelated
 * across clients, but never below half the intended step.
 *
 * @param consecutive how many throttles we have seen in a row, including this one
 * @param jitter injected in [0,1); defaults to `Math.random`
 */
export function nextBackoff(
  consecutive: number,
  jitter: () => number = Math.random,
): BackoffDecision {
  const n = Math.max(1, Math.floor(consecutive));
  const base = Math.min(BACKOFF_CEILING_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
  const half = base / 2;
  const waitMs = Math.round(half + jitter() * half);
  return {
    waitMs,
    consecutive: n,
    breakNow: n >= BREAKER_THRESHOLD,
  };
}

/**
 * The durable throttle state of one crawl.
 *
 * Nothing here is stored in a closure, because in the cloud the observation and
 * the consequence happen in different invocations â€” possibly in different
 * isolates. The caller persists this, and reads it back before the next request.
 */
export interface ThrottleLedger {
  /** Consecutive throttles observed since the last success. */
  consecutive: number;
  /** Unix seconds until which the breaker keeps this job parked, or null. */
  breakerOpenUntil: number | null;
}

export function emptyThrottleLedger(): ThrottleLedger {
  return { consecutive: 0, breakerOpenUntil: null };
}

export interface ThrottleOutcome {
  /** State to persist. */
  state: ThrottleLedger;
  /** How long the caller should wait before its next archive.org request. */
  waitMs: number;
  /** True when this throttle tripped the breaker. */
  breakNow: boolean;
}

/**
 * Apply one throttle response to the durable state.
 *
 * @param state       current durable state
 * @param nowSeconds  unix seconds; injected so tests do not depend on the clock
 * @param cooldownMs  how long the breaker stays open once tripped
 */
export function applyThrottle(
  state: ThrottleLedger,
  nowSeconds: number,
  cooldownMs: number,
  jitter: () => number = Math.random,
): ThrottleOutcome {
  const decision = nextBackoff(state.consecutive + 1, jitter);

  if (!decision.breakNow) {
    return { state: { ...state, consecutive: decision.consecutive }, waitMs: decision.waitMs, breakNow: false };
  }

  // Tripped: park the job and reset the streak. The streak is reset because the
  // cooldown *is* the backoff now â€” carrying the count forward would make the
  // next single throttle trip the breaker again immediately, which is how a
  // crawler ends up permanently parked.
  return {
    state: {
      consecutive: 0,
      breakerOpenUntil: nowSeconds + Math.ceil(cooldownMs / 1000),
    },
    waitMs: cooldownMs,
    breakNow: true,
  };
}

/** Apply one success: the streak is over. */
export function applySuccess(state: ThrottleLedger): ThrottleLedger {
  return { consecutive: 0, breakerOpenUntil: state.breakerOpenUntil };
}

/** Seconds the caller must still wait for the breaker, or 0 if it is closed. */
export function breakerWaitSeconds(state: ThrottleLedger, nowSeconds: number): number {
  if (state.breakerOpenUntil === null) return 0;
  return Math.max(0, state.breakerOpenUntil - nowSeconds);
}

/**
 * The message shown to a human while we are being throttled.
 *
 * plan.md Â§12 rule 3 is explicit that this must never be a silent hang, so the
 * copy is a deliverable, not a log line. Kept here so the API, the SSE stream and
 * the PWA cannot drift apart in what they say.
 */
export function throttleMessage(state: ThrottleLedger, nowSeconds: number): string | null {
  const wait = breakerWaitSeconds(state, nowSeconds);
  if (wait > 0) return `archive.org is throttling us â€” resuming in ${wait}s`;
  if (state.consecutive > 0) {
    return `${state.consecutive} throttle response(s) so far; backing off between requests`;
  }
  return null;
}

/**
 * Whether a new archive.org request may start right now.
 * A closed breaker always allows; an open one never does.
 */
export function mayRequest(state: ThrottleLedger, nowSeconds: number): boolean {
  return breakerWaitSeconds(state, nowSeconds) === 0;
}
