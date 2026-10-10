# Phase 5 smoke test — expected transcript

This file is the reference transcript for `scripts/phase5-smoke.ps1`.

The script tests all four Phase 5 features over live HTTP against a local
`wrangler dev` instance — the only place they can be proven, because D1's FTS5
virtual table, R2, and the Worker runtime are unavailable in Node. The unit suites
(`apps/api/test/{search,compare,bundle}.test.ts`) cover the pure logic; the smoke
test covers the wiring.

## How to run

```powershell
# 1. Apply the local D1 migrations and start the Worker (separate terminal):
cd apps/api
npx wrangler d1 migrations apply custom-wayback-ledger --local
npx wrangler dev --port 8787

# 2. First run: crawl real data (requires archive.org reachability, ~1 req/s):
powershell -ExecutionPolicy Bypass scripts/phase5-smoke.ps1 -Crawl

# 3. Repeat runs (uses the recorded account from phase5-smoke.state.json):
powershell -ExecutionPolicy Bypass scripts/phase5-smoke.ps1
```

`-Crawl` records the account, domain and month it used to
`scripts/phase5-smoke.state.json`. Without a recorded account, only the
data-independent guard (same-month compare → 400) runs.

---

## Expected output (annotated)

### Step 1 — Service reachable

```
=== 1. Service reachable ===
  PASS  health ok: {"d1":true,"r2":true,"queue":true,"secrets":true}
```

All four bindings must be true. If `secrets` is false, `JWT_SECRET`,
`STORAGE_ACCESS_KEY_ID`, or `STORAGE_SECRET_ACCESS_KEY` is missing from
`.dev.vars`.

### Step 2 — Account and data

**With `-Crawl`:**
```
=== 2. Crawl example.com for 2024-01 and 2024-02 through the API ===
  PASS  account ready, tracking example.com
  crawling 2024-01 (budget 5 pages, ~1 req/s)...
  PASS  2024-01: status=ready pages=<N>
  crawling 2024-02...
  PASS  2024-02: status=ready pages=<N>
  PASS  state saved to scripts/phase5-smoke.state.json
```

**Without `-Crawl` (normal re-run):**
```
=== 2. Load recorded account ===
  PASS  signed in as p5-<timestamp>@example.test, domain example.com
```

`pages` will be in the range 1–5 (the default `MaxPages=5` budget). A `partial`
status is acceptable: it means the budget was hit, not that the crawl failed.
The important invariant is `pages >= 1`; zero pages with no `degraded_reason`
means the queue consumer is not running.

### Step 3 — Search

```
=== 3. Search: real query, escaped query, hostile query, reindex ===
  PASS  query built safely: "example"*
  PASS  found <N> result(s) - ingest populated the FTS5 index
  PASS  hit carries a viewer route: /a/example.com/<day>/<path>
  PASS  hit carries a snippet
  PASS  a parenthesis did not break the query: "iphone"* AND "15"*
  PASS  punctuation-only query refused with 400 invalid_query
  PASS  column filter neutralised: "textsecret"*
  PASS  reindex ran: indexed=0 skipped=0 empty=0 remaining=0
  PASS  nothing left to index, as expected right after a crawl
```

Key invariants:

- **`"example"*`** — every term is a double-quoted FTS5 string literal with a
  trailing `*` for prefix matching. The quoting is what prevents user input from
  becoming FTS5 syntax.
- **`found <N> results`** — if this fails with `found 0 results`, the FTS5 index
  is not being written at ingest time. Check that `indexStatements()` is called
  from `queue/ingest.ts` and that the D1 batch containing those statements is
  flushed before the message is acknowledged.
- **`"iphone"* AND "15"*`** — a parenthesis in user input is stripped
  (it is not in `[\p{L}\p{N}+&.'_-]`), not interpreted as FTS5 grouping.
- **`"textsecret"*`** — the colon in `text:secret` is stripped, collapsing the
  column filter to a plain term. The expression must NOT contain `text:`.
- **reindex `remaining=0`** after a fresh crawl — pages were indexed at ingest
  time, so there is nothing to backfill. If `remaining > 0` here, ingest-time
  indexing is broken; the reindex backfill path is a recovery tool, not the
  normal path.

The `title` PASS/SKIP depends on whether the crawled page had a `<title>` tag.
Either is correct.

### Step 4 — Compare

```
=== 4. Compare: change detection and the per-page text diff ===
  PASS  classified both months: added=<N> removed=<N> changed=<N> unchanged=<N> unknown=<N>
  PASS  totals: <N> pages in 2024-01, <N> in 2024-02
  PASS  content digests are present, so classification is exact
  PASS  every page landed in a bucket (<N> rows)
  PASS  per-page diff for <kind>: <N> word(s) replaced by <N> / no textual change / …
  PASS  diff returned <N> segment(s)
  PASS  same-month comparison refused with 400
  PASS  malformed month refused with 400
```

Key invariants:

- **`content digests are present`** — if this fails after a fresh crawl,
  `content_digest` is not being written to the `snapshots` table during ingest.
  Check the `INSERT OR REPLACE INTO snapshots` statement in `queue/ingest.ts`;
  the column must be in both the column list and the VALUES list.
- **`every page landed in a bucket`** — counts across all five kinds must be
  non-zero in sum. Zero means `loadMonth` returned empty maps; check that the
  `snapshots` table has rows with `day LIKE '2024-01-%'`.
- **`per-page diff`** — the summary varies with content: `"no textual change"`,
  `"N words added"`, `"N words replaced by M"`. All are valid. If the diff
  shows `unavailableMonths`, the blob was purged; SKIP is the right response.
- **`same-month 400`** — `from === to` is explicitly refused; the comparison
  is meaningless and the UI should not allow it.
- **`malformed month 400`** — `to=2024-99` (month 99) is invalid and refused.

### Step 5 — Share links

```
=== 5. Share links: mint, resolve, revoke ===
  PASS  token has 128 bits of entropy (32 hex chars)
  PASS  response states the access model rather than implying a public URL
  PASS  share url: /s/<32 hex chars>
  PASS  resolve returned a route: /viewer?domain=example.com&month=2024-01
  PASS  /s/<token> redirects into the viewer (/viewer?domain=example.com&month=2024-01)
  PASS  revoke accepted
  PASS  a revoked token is refused with 410
  PASS  minting a share requires authentication
```

Key invariants:

- **32 hex chars** — `crypto.getRandomValues(16 bytes)` = 128 bits. A shorter
  token weakens the capability.
- **`accessNote` present** — the response must explicitly say the link is behind
  the app's access control, not publicly reachable. A UI that prints a link
  without this note could mislead the owner into thinking it is shareable outside
  the app.
- **`/s/<token>` → 302** — the redirect is checked with `AllowAutoRedirect=false`
  so the script reads the 302 directly. The `Location` header value is logged.
- **410 after revoke** — `revoked_at IS NOT NULL` causes the resolve endpoint to
  return 410, not 404. 410 means "this existed and was deliberately killed"; 404
  means "never existed". Using 410 prevents clients from re-minting a link the
  owner just revoked.
- **401 without token** — `POST /v1/shares` is behind auth middleware; an
  unauthenticated request must not mint a capability.

### Step 6 — Export

```
=== 6. Export a month as a static bundle ===
  PASS  export started: {"id":"<ulid>","status":"building","domain":"example.com","month":"2024-01",...}
  PASS  export ready: <N> pages, <N> assets, <N> bytes
  PASS  missing-page count reported: 0
  PASS  download is a real ZIP (<N> bytes, PK signature)
```

Key invariants:

- **202 from `POST /v1/export`** — the export builds synchronously inside the
  request, but the initial response is always 202 even if the build finished
  immediately.
- **PK signature** — bytes `[0x50, 0x4B, 0x03, 0x04]` at offset 0 of every PKZIP
  archive. The smoke script reads the first 4 bytes and checks for `"PK\x03\x04"`.
  A Worker that returns HTML instead of a ZIP, or a response that truncates before
  the signature, fails this check.
- **`missing` reported** — `missing` counts pages that could not be included
  because their R2 blob had been purged by the post-serve job. It is `0` after a
  fresh crawl; it is non-zero in normal long-term use and must be shown, not
  hidden. The check asserts the field is present (not `null`); `0` and any positive
  number are both valid.
- **`pages >= 1`** — a bundle with zero pages is a README and an index over
  nothing. If this fails, the page rows exist in D1 but their `r2_key` is null or
  their blobs were already purged; in a fresh test run the blobs should be present.

---

## Failure guide

| Step | Failure | Likely cause |
|---|---|---|
| 1 | service unreachable | `wrangler dev` not running on port 8787 |
| 2 | `pages=0`, no `degraded_reason` | Queue consumer not receiving messages; check `[queues.consumers]` in `wrangler.toml` and that the queue was created |
| 2 | `degraded_reason: CDX survey…` | archive.org CDX unreachable (expected if offline); status `partial` still passes |
| 3 | `found 0 results` | `indexStatements()` not called at ingest, or `DB.batch()` of index statements is not flushing |
| 3 | `column filter survived: "text":secret"*` | `buildFtsExpression` strip regex missing the colon; see `packages/api/src/lib/search.ts` |
| 4 | `no content digests` | `content_digest` column missing from the `INSERT OR REPLACE INTO snapshots` statement in `queue/ingest.ts` |
| 4 | `change list is empty` | `snapshots` table has no rows for the tested months; re-check migration 0004 was applied (`wrangler d1 migrations apply --local`) |
| 5 | `revoked token still resolves` | `revoked_at` check missing from the resolve handler |
| 5 | `/s/<token>` → not 302 | `/s/:token` route not registered before the SPA fallthrough in `apps/api/src/index.ts` |
| 6 | `export still building after 40s` | Worker CPU or memory limit hit on the ZIP pass; check `MAX_BUNDLE_BYTES` (64 MiB) and that the crawled month is small |
| 6 | download not a ZIP | `Content-Type: application/zip` missing, or `buildZipStream` produced malformed output; run `apps/api/test/bundle.test.ts` first |

---

## Notes on test data

`scripts/phase5-smoke.state.json` holds the credentials and domain id from the
last `-Crawl` run. The JWT stored there is expired by the time the normal run
starts, which is why the non-crawl path always re-logs in before any request.
Never commit real credentials to this file. The domain is `example.com` (IANA
reserved, safe for automated crawls) and the budget is 5 pages.
