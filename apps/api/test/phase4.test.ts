/**
 * Tests for the Phase 4 decision logic.
 *
 * Two kinds of thing are tested here, and they are tested here for the same
 * reason — both are easy to get subtly wrong and hard to notice:
 *
 *  1. **The politeness policy** (`@custom-wayback/shared` → `policy.ts`). If the
 *     backoff or the circuit breaker regresses, the symptom is not a failing
 *     request; it is archive.org quietly blocking us weeks later. The policy is
 *     pure and takes injected jitter and clock, so it is asserted exactly.
 *
 *  2. **Capture selection** (`@custom-wayback/pipeline` → `selection.ts`). This
 *     decides *what* gets crawled and what the day scrubber shows. A regression
 *     here produces a plausible-looking but wrong archive, which is worse than a
 *     crash.
 *
 * The end-to-end queue → R2 → D1 path lives in the Miniflare smoke test; see
 * `test/phase4.smoke.md`. Nothing here touches the network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKOFF_CEILING_MS,
  BREAKER_THRESHOLD,
  applySuccess,
  applyThrottle,
  breakerWaitSeconds,
  emptyThrottleLedger,
  isThrottleStatus,
  mayRequest,
  nextBackoff,
  throttleMessage,
} from "@custom-wayback/shared";

import {
  canonicalize,
  isNavigablePage,
  parseCdxJson,
  pickAssetCapture,
  resolveLink,
  selectPages,
  type CdxRow,
} from "@custom-wayback/pipeline";

const HEADER = ["timestamp", "original", "mimetype", "statuscode", "digest", "length"];

function cdx(rows: string[][]): CdxRow[] {
  const parsed = parseCdxJson(JSON.stringify([HEADER, ...rows]));
  assert.equal(parsed.error, undefined);
  return parsed.rows;
}

/** Deterministic jitter: always the midpoint of the jitter range. */
const midJitter = () => 0.5;

// ── Backoff shape ────────────────────────────────────────────────────────────

test("nextBackoff doubles the step and never exceeds the ceiling", () => {
  const steps = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => nextBackoff(n, () => 0).waitMs);

  // With jitter pinned to 0 we see the floor of each step: base/2.
  // 1500/2=750, 3000/2=1500, 6000/2=3000, ... capped at 60000/2=30000.
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i]! >= steps[i - 1]!, `step ${i + 1} (${steps[i]}) went backwards from ${steps[i - 1]}`);
  }
  for (const step of steps) {
    assert.ok(step > 0 && step <= BACKOFF_CEILING_MS, `${step}ms is outside (0, ${BACKOFF_CEILING_MS}]`);
  }

  // Monotonic growth until the ceiling is reached, then flat.
  assert.equal(steps[0], 750);
  assert.equal(steps[1], 1500);
  assert.equal(steps.at(-1), BACKOFF_CEILING_MS / 2);
});

test("nextBackoff is jittered, and the jitter is bounded upward", () => {
  // At n = 3 the base step is 1500 * 2^2 = 6000ms, so the policy waits somewhere
  // in [base/2, base) = [3000, 6000).
  const low = nextBackoff(3, () => 0).waitMs;
  const mid = nextBackoff(3, midJitter).waitMs;
  const high = nextBackoff(3, () => 0.999).waitMs;

  assert.ok(low < mid && mid < high, `expected low < mid < high, got ${low} / ${mid} / ${high}`);
  // "Biased upward": even at jitter 0 we wait half the full step, never nothing.
  assert.equal(low, 3_000, "the jitter floor is half the base step");
  assert.ok(high < 6_000, `jitter ceiling ${high}ms must stay under the 6000ms base`);
  assert.ok(high >= 5_900, `jitter ceiling ${high}ms should approach the base step`);
});

test("nextBackoff is stateless: the same inputs give the same answer", () => {
  for (const n of [1, 2, 5, 9]) {
    assert.equal(nextBackoff(n, midJitter).waitMs, nextBackoff(n, midJitter).waitMs);
  }
});

// ── Circuit breaker ──────────────────────────────────────────────────────────

test("applyThrottle opens the breaker exactly at the threshold", () => {
  let state = emptyThrottleLedger();
  const now = 1_700_000_000;
  const cooldown = 5 * 60_000;

  for (let i = 1; i < BREAKER_THRESHOLD; i++) {
    const out = applyThrottle(state, now, cooldown, midJitter);
    assert.equal(out.breakNow, false, `throttle ${i} must not trip the breaker`);
    assert.equal(out.state.breakerOpenUntil, null);
    state = out.state;
  }
  assert.equal(state.consecutive, BREAKER_THRESHOLD - 1);

  const tripped = applyThrottle(state, now, cooldown, midJitter);
  assert.equal(tripped.breakNow, true, `throttle ${BREAKER_THRESHOLD} must trip the breaker`);
  assert.equal(tripped.state.breakerOpenUntil, now + cooldown / 1000);
  assert.equal(tripped.waitMs, cooldown, "a breaker trip waits the full cooldown");
});

test("a tripped breaker resets the streak, so the next single throttle does not re-trip it", () => {
  // This is the regression that matters: carrying the count past the trip makes a
  // crawler permanently parked after the cooldown, one throttle at a time.
  const now = 1_700_000_000;
  let state = emptyThrottleLedger();
  for (let i = 0; i < BREAKER_THRESHOLD; i++) {
    state = applyThrottle(state, now, 300_000, midJitter).state;
  }
  assert.equal(state.consecutive, 0);

  const after = applyThrottle(state, now + 300, 300_000, midJitter);
  assert.equal(after.breakNow, false, "the first throttle after a cooldown must not re-open the breaker");
});

test("mayRequest gates on the breaker, and breakerWaitSeconds counts down", () => {
  const now = 1_700_000_000;
  let state = emptyThrottleLedger();
  for (let i = 0; i < BREAKER_THRESHOLD; i++) {
    state = applyThrottle(state, now, 300_000, midJitter).state;
  }

  assert.equal(mayRequest(state, now), false, "an open breaker must forbid requests");
  assert.equal(breakerWaitSeconds(state, now), 300);
  assert.equal(breakerWaitSeconds(state, now + 299), 1);
  assert.equal(breakerWaitSeconds(state, now + 300), 0);
  assert.equal(mayRequest(state, now + 300), true, "a closed breaker allows requests again");
});

test("applySuccess clears the streak but does not close an open breaker", () => {
  const now = 1_700_000_000;
  let state = applyThrottle(emptyThrottleLedger(), now, 60_000, midJitter).state;
  assert.equal(state.consecutive, 1);

  state = applySuccess(state);
  assert.equal(state.consecutive, 0);

  let open = emptyThrottleLedger();
  for (let i = 0; i < BREAKER_THRESHOLD; i++) open = applyThrottle(open, now, 60_000, midJitter).state;
  const stillOpen = applySuccess(open);
  assert.equal(stillOpen.breakerOpenUntil, open.breakerOpenUntil, "a success must not cancel an open cooldown");
});

test("isThrottleStatus recognises exactly the slow-down codes", () => {
  for (const code of [429, 502, 503]) assert.equal(isThrottleStatus(code), true, `${code} must throttle`);
  for (const code of [200, 301, 404, 410, 500, 504]) {
    assert.equal(isThrottleStatus(code), false, `${code} must not be treated as throttling`);
  }
});

// ── The message a human sees (§12 rule 3: never a silent hang) ───────────────

test("throttleMessage names the resume time while parked, and is null when healthy", () => {
  assert.equal(throttleMessage(emptyThrottleLedger(), 0), null);

  const backingOff = { consecutive: 2, breakerOpenUntil: null };
  assert.match(throttleMessage(backingOff, 0) ?? "", /2 throttle response/);

  const parked = { consecutive: 0, breakerOpenUntil: 1_700_000_120 };
  const message = throttleMessage(parked, 1_700_000_000) ?? "";
  // Not asserted as a literal: the copy is user-facing prose and may be reworded,
  // but it must always name the resume time. That is the §12 rule-3 guarantee.
  assert.match(message, /throttling/i);
  assert.match(message, /120s/);
  assert.equal(throttleMessage({ consecutive: 0, breakerOpenUntil: null }, 0), null);
});

// ── CDX parsing ──────────────────────────────────────────────────────────────

test("parseCdxJson drops the header, keeps rows, and tolerates the resumption trailer", () => {
  const rows = parseCdxJson(
    JSON.stringify([
      HEADER,
      ["20240315091200", "https://example.com/", "text/html", "200", "abc", "1234"],
      ["resume-key-here"],
    ]),
  );
  assert.equal(rows.error, undefined);
  assert.equal(rows.rows.length, 1, "the single-cell trailer is not a capture");
  assert.equal(rows.rows[0]?.day, "2024-03-15");
  assert.equal(rows.rows[0]?.bytes, 1234);
});

test("parseCdxJson reports an archive.org error page instead of pretending it had no captures", () => {
  const empty = parseCdxJson("   ");
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.error, undefined, "an empty body is legitimately zero captures");

  const html = parseCdxJson("<html><body>504 Gateway Timeout</body></html>");
  assert.equal(html.rows.length, 0);
  assert.ok(html.error && html.error.length > 0, "an HTML error page must be reported as an error");

  const malformed = parseCdxJson("[not, valid, json");
  assert.match(malformed.error ?? "", /unparseable/i);
});

// ── "One clean snapshot per day" (§6.2) ──────────────────────────────────────
//
// Note the argument order: `selectPages(rows, mode, seedUrl)`. The pipeline is
// the single implementation shared with the local runner, so the tests use its
// signature rather than a convenient one.

test("selectPages keeps one capture per URL per day, choosing the largest", () => {
  const rows = cdx([
    ["20240315090000", "https://example.com/", "text/html", "200", "a", "1000"],
    ["20240315180000", "https://example.com/", "text/html", "200", "b", "5000"],
    ["20240316090000", "https://example.com/", "text/html", "200", "c", "2000"],
  ]);

  const result = selectPages(rows, "perday", "https://example.com/");
  assert.equal(result.pages.length, 2, "two distinct days → two page rows");

  const day15 = result.pages.find((p) => p.day === "2024-03-15");
  assert.equal(day15?.ts, "20240315180000", "the larger capture of the day wins");
  assert.equal(day15?.bytes, 5000);

  assert.equal(result.coverageByDay["2024-03-15"], 1);
  assert.equal(result.coverageByDay["2024-03-16"], 1);
});

test("selectPages is deterministic, so a retry replans identically", () => {
  const build = () =>
    cdx([
      ["20240315090000", "https://example.com/b", "text/html", "200", "a", "1000"],
      ["20240315090000", "https://example.com/a", "text/html", "200", "a", "1000"],
      ["20240315090000", "https://example.com/c", "text/html", "200", "z", "1000"],
      ["20240315092000", "https://example.com/c", "text/html", "200", "y", "1000"],
    ]);

  const first = selectPages(build(), "perday", "https://example.com/");
  const second = selectPages(build(), "perday", "https://example.com/");
  assert.deepEqual(
    first.pages.map((p) => `${p.url}|${p.day}|${p.ts}`),
    second.pages.map((p) => `${p.url}|${p.day}|${p.ts}`),
    "same CDX rows must produce the same plan every time",
  );
});

test("selectPages drops non-200 captures and non-navigable paths", () => {
  const rows = cdx([
    ["20240315090000", "https://example.com/", "text/html", "200", "a", "1000"],
    ["20240315090000", "https://example.com/gone", "text/html", "404", "a", "1000"],
    ["20240315090000", "https://example.com/robots.txt", "text/plain", "200", "a", "100"],
    ["20240315090000", "https://example.com/sitemap.xml", "text/xml", "200", "a", "100"],
    ["20240315090000", "https://example.com/blog/post", "text/html", "200", "a", "500"],
  ]);

  const urls = selectPages(rows, "perday", "https://example.com/").pages.map((p) => p.url);
  assert.deepEqual(urls, ["https://example.com/", "https://example.com/blog/post"]);
});

test("selectPages puts the seed first, then shallow pages (NAV_SET priority)", () => {
  const rows = cdx([
    ["20240315090000", "https://example.com/a/b/c/d/e/deep", "text/html", "200", "a", "1000"],
    ["20240315090000", "https://example.com/pricing", "text/html", "200", "a", "1000"],
    ["20240315090000", "https://example.com/", "text/html", "200", "a", "1000"],
  ]);

  const urls = selectPages(rows, "perday", "https://example.com/").pages.map((p) => p.url);
  assert.deepEqual(urls, [
    "https://example.com/",
    "https://example.com/pricing",
    "https://example.com/a/b/c/d/e/deep",
  ]);
});

test("selectPages returns the whole plan; the page budget is applied by the caller", () => {
  // The budget is a *crawl* decision, not a selection decision: the survey stage
  // slices the plan to `maxPagesPerMonth` and freezes it, so one budget applies
  // to every retry. Asserting the split here keeps that boundary honest.
  const rows = cdx(
    Array.from({ length: 50 }, (_, i) => [
      "20240315090000",
      `https://example.com/page-${String(i).padStart(3, "0")}`,
      "text/html",
      "200",
      "a",
      "1000",
    ]),
  );

  const plan = selectPages(rows, "perday", "https://example.com/").pages;
  assert.equal(plan.length, 50);
  assert.equal(plan.slice(0, 10).length, 10, "the caller's budget slice is respected");
});

test("selectPages records other same-day captures as extras, measured from the chosen one", () => {
  // The rule (packages/pipeline/src/selection.ts): a same-day capture counts as a
  // genuinely distinct "extra" when it is more than 60 seconds from the *chosen*
  // capture. The chosen capture is the largest, not the earliest, so captures on
  // either side of it can appear — which is exactly why the comparison has to be
  // an absolute time difference and not a subtraction of HHMMSS digits.
  //
  // Here the chosen capture (15:00, largest) is hours from every morning capture,
  // so all three morning captures are distinct and all three are offered to the
  // UI's capture counter. That is the intended behaviour: three captures, genuinely
  // distinct, is useful information rather than noise.
  const rows = cdx([
    ["20240315090000", "https://example.com/", "text/html", "200", "a", "1000"],
    ["20240315090040", "https://example.com/", "text/html", "200", "a2", "1000"],
    ["20240315090230", "https://example.com/", "text/html", "200", "a3", "1000"],
    ["20240315150000", "https://example.com/", "text/html", "200", "b", "2000"],
  ]);

  const page = selectPages(rows, "perday", "https://example.com/").pages[0];
  assert.equal(page?.ts, "20240315150000", "the largest capture is chosen");
  assert.deepEqual(page?.extras, ["20240315090000", "20240315090040", "20240315090230"]);
  assert.ok(!page?.extras.includes("20240315150000"), "the chosen capture is never its own extra");
});

test("selectPages in anchor mode exists and reports its anchor day", () => {
  const rows = cdx([
    // Day 1 has two URLs; day 2 has one. Anchor day is therefore day 1.
    ["20240301090000", "https://example.com/", "text/html", "200", "a", "1000"],
    ["20240301090000", "https://example.com/about", "text/html", "200", "a", "1000"],
    ["20240302090000", "https://example.com/", "text/html", "200", "b", "1000"],
  ]);

  const result = selectPages(rows, "anchor", "https://example.com/");
  assert.equal(result.anchorDay, "2024-03-01", "the best-covered day is the anchor");
  assert.equal(result.anchorCoverage, 2);
  // One page per URL: the URL with no capture on the anchor day resolves to the
  // nearest capture within the tolerance window, which is the whole point of
  // anchor mode ("show me the site as it was on the 1st").
  assert.equal(result.pages.length, 2, "anchor mode emits one row per URL, not per day");
  const about = result.pages.find((p) => p.url === "https://example.com/about");
  assert.equal(about?.day, "2024-03-01", "a URL captured on the anchor day is pinned to it");
});

// ── Link resolution (what makes navigation feel unbroken) ────────────────────

test("resolveLink prefers the same day, then the nearest, then the earlier of a tie", () => {
  const days = new Set(["2024-03-10", "2024-03-20", "2024-03-30"]);

  assert.deepEqual(resolveLink(days, "2024-03-20"), { day: "2024-03-20", deltaDays: 0 });
  assert.deepEqual(resolveLink(days, "2024-03-18"), { day: "2024-03-20", deltaDays: 2 });
  // Equidistant: the earlier day wins, so a page never silently shows a later version.
  assert.deepEqual(resolveLink(days, "2024-03-15"), { day: "2024-03-10", deltaDays: -5 });
});

test("resolveLink gives up outside the tolerance instead of jumping months", () => {
  const days = new Set(["2024-01-01"]);
  assert.equal(resolveLink(days, "2024-06-01", 31), undefined);
  assert.equal(resolveLink(new Set(), "2024-03-01"), undefined);
});

// ── URL canonicalisation: the ledger key ─────────────────────────────────────

test("canonicalize normalises host, port, fragment and tracking params", () => {
  assert.equal(canonicalize("HTTPS://Example.COM:443/Path?b=2&a=1#frag"), "https://example.com/Path?a=1&b=2");
  assert.equal(canonicalize("http://example.com:80/"), "http://example.com/");
  assert.equal(canonicalize("https://example.com/?utm_source=nl&keep=1"), "https://example.com/?keep=1");
  assert.equal(canonicalize("/x", "https://example.com/base/"), "https://example.com/x");
});

test("canonicalize rejects anything that is not a fetchable http(s) URL", () => {
  for (const bad of ["javascript:void(0)", "data:text/plain,hi", "mailto:a@b.com", "http://[not a host"]) {
    assert.equal(canonicalize(bad), undefined, `${bad} must not become a ledger key`);
  }
});

test("isNavigablePage filters machine-readable paths but keeps real pages", () => {
  assert.equal(isNavigablePage("https://example.com/"), true);
  assert.equal(isNavigablePage("https://example.com/blog/post/"), true);
  assert.equal(isNavigablePage("https://example.com/feed/"), false);
  assert.equal(isNavigablePage("https://example.com/wp-json/wp/v2/posts"), false);
  assert.equal(isNavigablePage("not a url"), false);
});

// ── Asset selection: one good copy serves every day ──────────────────────────

test("pickAssetCapture takes the largest 200 and ignores failures", () => {
  const rows = cdx([
    ["20240315090000", "https://example.com/logo.png", "image/png", "200", "a", "900"],
    ["20240320090000", "https://example.com/logo.png", "image/png", "200", "b", "4000"],
    ["20240325090000", "https://example.com/logo.png", "image/png", "404", "c", "10"],
  ]);
  assert.equal(pickAssetCapture(rows)?.bytes, 4000);

  const allFailed = cdx([["20240315090000", "https://example.com/x.png", "image/png", "404", "a", "1"]]);
  assert.equal(pickAssetCapture(allFailed), undefined);
});
