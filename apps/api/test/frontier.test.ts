/**
 * The link-following frontier.
 *
 * ## Why this file exists
 *
 * The crawl used to depend entirely on one domain-wide CDX survey. On 2026-10-24 that
 * query was answering **503 "Internet Archive: Temporarily Offline"** for samsung.com
 * and apple.com in ~5 s, while cheap queries kept working — so every crawl of a large
 * domain failed before fetching a single page and the app had nothing to show.
 *
 * `growFrontier` is the fix: a fetched page's links are probed one at a time through the
 * availability API and added to the plan, so the crawl can grow from the homepage with
 * no survey at all. These tests pin the three properties that make it safe:
 *
 *   1. **Bounded.** A page with hundreds of links spends at most
 *      `NEW_LINKS_PER_MESSAGE` probes and can never exceed the month's page budget.
 *   2. **Depth-limited.** Links deeper than the budget's `maxDepth` are ignored.
 *   3. **Not repeated.** A link is probed once per crawl; a dead link is not retried by
 *      every page that happens to point at it.
 *
 * The probe itself is tested for the shapes that matter: a usable capture, a capture of
 * an error page, a missing capture, a non-JSON body, and a network failure — because
 * the last four must all mean "skip this link", never "kill the crawl".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { growFrontier, resolveCaptureNear } from "../src/queue/ingest.ts";

interface SelectedPage {
  url: string;
  ts: string;
  day: string;
  mime: string;
  bytes: number;
  digest: string | null;
}

/** A usage recorder matching the `usage.add` contract the helpers call. */
function usage() {
  const counts: Record<string, number> = {};
  return {
    counts,
    add(kind: string, n = 1) {
      counts[kind] = (counts[kind] ?? 0) + n;
    },
  };
}

/**
 * A fake `CloudFetcher` that answers the availability API from a map.
 *
 * Only `fetch` is implemented because that is the entire surface these helpers use —
 * deliberately narrow, so the test cannot accidentally depend on politeness internals.
 */
function fetcherReturning(map: Record<string, string | null | "error" | "notjson">) {
  const asked: string[] = [];
  return {
    asked,
    async fetch(url: string) {
      asked.push(url);
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/wayback/available", "only the availability API is probed");
      const target = parsed.searchParams.get("url") ?? "";
      const answer = map[target];
      if (answer === "error") throw new Error("network down");
      if (answer === "notjson") {
        return { kind: "ok" as const, status: 200, contentType: "text/html", body: new TextEncoder().encode("<html>nope</html>"), finalUrl: url };
      }
      if (answer === undefined || answer === null) {
        return {
          kind: "ok" as const,
          status: 200,
          contentType: "application/json",
          body: new TextEncoder().encode(JSON.stringify({ archived_snapshots: {} })),
          finalUrl: url,
        };
      }
      return {
        kind: "ok" as const,
        status: 200,
        contentType: "application/json",
        body: new TextEncoder().encode(
          JSON.stringify({
            archived_snapshots: { closest: { available: true, status: "200", timestamp: answer } },
          }),
        ),
        finalUrl: url,
      };
    },
  } as unknown as Parameters<typeof growFrontier>[0] & { asked: string[] };
}

const BUDGET = { maxPagesPerMonth: 50, maxDepth: 3 };

test("a discovered link with a capture joins the plan, and is resolvable immediately", async () => {
  const fetcher = fetcherReturning({ "https://e.com/about": "20240315091200" });
  const pages: SelectedPage[] = [];
  const dayIndex: Record<string, Record<string, string>> = {};
  const u = usage();

  const added = await growFrontier(
    fetcher,
    ["https://e.com/about"],
    "2024-03-14",
    pages,
    dayIndex,
    BUDGET,
    u as never,
  );

  assert.equal(added, 1);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.url, "https://e.com/about");
  assert.equal(pages[0]?.day, "2024-03-15", "the day comes from the capture, not the request");
  // The page's own link map needs this entry; without it the link the visitor clicks is
  // rewritten to a dead route even though the target was just stored.
  assert.deepEqual(dayIndex["https://e.com/about"], { "2024-03-15": "20240315091200" });
  assert.equal(u.counts["ia_fetch"], 1, "exactly one probe for one link");
});

test("a link with no capture is skipped and not probed again", async () => {
  const fetcher = fetcherReturning({});
  const pages: SelectedPage[] = [];
  const dayIndex: Record<string, Record<string, string>> = {};
  const u = usage();

  const links = ["https://e.com/gone", "https://e.com/gone", "https://e.com/gone"];

  const first = await growFrontier(fetcher, links, "2024-03-14", pages, dayIndex, BUDGET, u as never);
  assert.equal(first, 0);
  assert.equal(fetcher.asked.length, 1, "a dead link is probed once, not once per reference");

  const second = await growFrontier(fetcher, links, "2024-03-14", pages, dayIndex, BUDGET, u as never);
  assert.equal(second, 0);
  assert.equal(fetcher.asked.length, 1, "a second page linking to it must not re-probe");
});

test("the frontier is bounded per message and by the month budget", async () => {
  const links = Array.from({ length: 40 }, (_, n) => `https://e.com/p${n}`);
  const map: Record<string, string> = {};
  for (const link of links) map[link] = "20240315091200";

  // Per-message ceiling.
  {
    const fetcher = fetcherReturning(map);
    const pages: SelectedPage[] = [];
    const added = await growFrontier(
      fetcher,
      links,
      "2024-03-14",
      pages,
      {},
      { maxPagesPerMonth: 1000, maxDepth: 3 },
      usage() as never,
    );
    assert.equal(added, 6, "at most NEW_LINKS_PER_MESSAGE probes per queue message");
    assert.equal(fetcher.asked.length, 6);
  }

  // Month budget ceiling.
  {
    const fetcher = fetcherReturning(map);
    const pages: SelectedPage[] = Array.from({ length: 49 }, (_, n) => ({
      url: `https://e.com/existing${n}`,
      ts: "20240315091200",
      day: "2024-03-15",
      mime: "text/html",
      bytes: 0,
      digest: null,
    }));
    await growFrontier(fetcher, links, "2024-03-14", pages, {}, BUDGET, usage() as never);
    assert.equal(pages.length, 50, "the plan must stop at maxPagesPerMonth");
  }
});

test("links deeper than the budget's maxDepth are ignored without a probe", async () => {
  const fetcher = fetcherReturning({
    "https://e.com/a/b/c/d": "20240315091200",
    "https://e.com/a": "20240315091200",
  });
  const pages: SelectedPage[] = [];
  await growFrontier(
    fetcher,
    ["https://e.com/a/b/c/d", "https://e.com/a"],
    "2024-03-14",
    pages,
    {},
    BUDGET,
    usage() as never,
  );

  assert.deepEqual(pages.map((p) => p.url), ["https://e.com/a"]);
  assert.equal(fetcher.asked.length, 1, "the too-deep link costs no request at all");
});

test("the probe reads a capture, and rejects everything that is not a usable page", async () => {
  const u = usage();
  const cases: [string, string | null | "error" | "notjson", string | null][] = [
    ["https://e.com/ok", "20240315091200", "20240315091200"],
    ["https://e.com/missing", null, null],
    ["https://e.com/throws", "error", null],
    ["https://e.com/notjson", "notjson", null],
  ];

  for (const [url, answer, expected] of cases) {
    const fetcher = fetcherReturning({ [url]: answer });
    const got = await resolveCaptureNear(fetcher, url, "2024-03-14", u as never);
    assert.equal(got, expected, `${url} -> ${String(expected)}`);
  }

  // A capture of an error page is not a page: the availability API reports the status of
  // the closest capture, and a 404/500 capture must not become a stored page.
  const errorCapture = {
    async fetch() {
      return {
        kind: "ok" as const,
        status: 200,
        contentType: "application/json",
        body: new TextEncoder().encode(
          JSON.stringify({
            archived_snapshots: { closest: { available: true, status: "404", timestamp: "20240315091200" } },
          }),
        ),
        finalUrl: "",
      };
    },
  } as unknown as Parameters<typeof resolveCaptureNear>[0];
  assert.equal(await resolveCaptureNear(errorCapture, "https://e.com/gone", "2024-03-14", u as never), null);

  // A malformed timestamp is not a capture either.
  const malformed = {
    async fetch() {
      return {
        kind: "ok" as const,
        status: 200,
        contentType: "application/json",
        body: new TextEncoder().encode(
          JSON.stringify({
            archived_snapshots: { closest: { available: true, status: "200", timestamp: "yesterday" } },
          }),
        ),
        finalUrl: "",
      };
    },
  } as unknown as Parameters<typeof resolveCaptureNear>[0];
  assert.equal(await resolveCaptureNear(malformed, "https://e.com/x", "2024-03-14", u as never), null);
});
