# @custom-wayback/crawler-local

Phase 1 of [plan.md](../../plan.md): **local ingestion of one domain and one month** from the
Wayback Machine into a fast, browsable local mirror.

Self-contained on purpose. No Cloudflare account, no cloud spend, no build step, no native
toolchain. It writes the same content-addressed layout that R2 will hold in Phase 4.

---

## Quick start

```bash
cd apps/crawler-local

# Ingest one domain for one month
npm run crawl -- --domain=samsung.com --month=2024-03

# A cheaper first run while you are evaluating
npm run crawl -- --domain=samsung.com --month=2024-03 --max-pages=25 --no-assets

# Browse what you ingested
npm run serve
#   http://127.0.0.1:8787/

# What have I ingested so far?
npm run stats
```

Requirements: **Node 22.5+** (24 recommended). Two experimental flags are wired into the npm
scripts: `--experimental-sqlite` (the ledger uses the built-in `node:sqlite`, so there is no
`better-sqlite3` native build and no Visual Studio dependency) and `--experimental-strip-types`
(Node runs the TypeScript directly; there is no bundler and no `dist/`).

---

## What it does, and why it is fast

The whole product idea is in one sentence: **fetch each URL once per chosen day, rewrite it
once, store the bytes, and serve bytes forever.**

```
   1. CDX survey      one bounded query per (domain, month)  -> cached on disk, fetched once ever
   2. Day selection   collapse every capture down to ONE clean snapshot per URL per day
   3. Pass 1: fetch   pull raw `id_` bytes for each page + its assets, dedupe assets by content hash
   4. Pass 2: rewrite rewrite each page exactly once, now that the link ledger is complete
   5. Store           content-addressed blobs on disk (identical in shape to R2)
   6. Serve           read straight from disk; never touches archive.org
```

Step 4 is deliberately a separate pass. Links can only be resolved once every page of the run is
stored, so rewriting during the fetch would leave early pages pointing at nothing. Nothing is ever
rewritten at read time — that is what makes browsing feel like a normal site.

On the one run measured against a real domain, the day policy collapsed **2,000 index captures
into 130 page-loads (a 93.5% reduction)**. That is exactly the "one snapshot a day, not every
capture" behaviour the Wayback UI cannot give you.

---

## Measured archive.org behaviour (October 2026)

The Internet Archive is under heavy automated load and is actively rate-limiting. Probes against
`web.archive.org/cdx/search/cdx` for `example.com`, January 2024:

| Query shape | Result |
|---|---|
| plain `limit=3` / `limit=10` | 200 OK, ~10-11 s |
| plain `limit=50` | 200 OK, ~25 s |
| `from`/`to` + `filter=statuscode:200`, no limit | **hung, connection closed at 119 s** |
| `from`/`to` + `collapse=timestamp:8` | **504 Gateway Timeout at 62 s** |
| `from`/`to` + `collapse=urlkey` | **hung, closed at 120 s** |
| single-day range query | **504 Gateway Timeout at 60 s** |
| `showResumeKey=true` | **hung, closed at 181 s** |
| `showNumPages=true` | 200 OK, ~1 s |
| `page=0&pageSize=1` | 200 OK, ~1 s, returns `[]` |

Consequences baked into the code:

1. **`showResumeKey=true` is a trap.** It forces a full index scan to find a resumption point, and
   it is not used anywhere on the default path.
2. **Expensive CDX queries do not fail fast; they hang until the server 504s.** So the survey has a
   hard wall-clock deadline (`--cdx-deadline`) and a request ceiling (`--cdx-max-requests`), and it
   returns whatever it collected instead of throwing.
3. **`limit=N` genuinely bounds server work** (the scan stops at N rows). It is the one knob that
   reliably keeps a query cheap, which is why day-selection happens client-side instead of via
   `collapse=`.
4. **The documented pagination API is currently unusable from outside** (an index reporting 912
   pages returns an empty first page), so it is not relied upon.

### Graceful degradation

If the survey returns nothing, the crawler asks the **Availability API** for the closest capture of
the seed URL and produces a shallow but genuinely browsable mirror, marking the run `partial` and
telling you exactly why. This has been observed working on two domains independently.

The run report never hides this. You will see, for example:

```
  ! the CDX survey was incomplete for this run
    reason: CDX html query failed: timed out after 30000 ms
    fell back to the Availability API for the seed URL only (one page deep)
    re-run with --refresh later; a complete survey is cached and reused
```

---

## Politeness (not optional)

This tool deliberately cannot be configured into being rude.

- Requests to the same host are serialized and spaced by at least `--min-delay-ms`
  (default 1000 ms; **values below 250 are refused outright**).
- 429/503/502 responses trigger exponential backoff with jitter, then a per-host circuit breaker
  that pauses rather than retries into a wall.
- An honest `User-Agent` with a contact string is always sent
  (`CustomWaybackFastBot/0.1 (local Phase 1; +contact: ...)`).
- Surveys are cached per (domain, month) on disk. Re-running an ingest costs **zero** CDX requests.
- Raw `id_` replay is used rather than the rewritten replay pages, which is the cheapest request for
  the Internet Archive (no on-the-fly rewriting server-side) and gives cleaner input to us.
- Every crawl has a mandatory page budget and byte ceiling. Anything outside the budget is left for
  on-demand delivery instead of crawled speculatively.

If you ever intend to run this at multi-user scale, contact `info@archive.org` /
`wwm@archive.org` about appropriate access first. See plan.md section 12.

---

## CLI reference

```
npm run crawl -- --domain=<domain> --month=YYYY-MM [options]
npm run serve [--port=8787]
npm run stats [--domain=<domain>]
npm test
```

| Option | Default | Meaning |
|---|---|---|
| `--mode=perday\|anchor` | `perday` | `perday`: one best capture per day per URL (drives the day scrubber). `anchor`: pin the whole site to the single best-captured day of the month. |
| `--seed=<url>` | `https://<domain>/` | Override the seed page. |
| `--max-pages=<n>` | 250 | Page-load budget. The rest are reported as deferred. |
| `--max-depth=<n>` | 3 | Link-follow depth from the seed. |
| `--max-assets=<n>` | 120 | Assets stored per page. |
| `--max-bytes=<mb>` | 750 | Hard byte ceiling; the run stops cleanly when reached. |
| `--min-delay-ms=<n>` | 1000 | Per-host spacing. Below 250 is refused. |
| `--request-timeout=<ms>` | 20000 | Per-request timeout. |
| `--cdx-deadline=<ms>` | 90000 | Wall-clock ceiling for the survey phase. |
| `--cdx-max-requests=<n>` | 12 | Survey request ceiling. |
| `--cdx-limit=<n>` | 2000 | Row cap per CDX query. |
| `--path-filter=<regex>` | none | Ingest only page URLs matching a regex. |
| `--no-assets` | off | HTML only (no images/CSS/JS). |
| `--refresh` | off | Ignore the cached survey and re-query CDX. |
| `--out=<dir>` / `--db=<path>` | `./data` | Blob store root and ledger path. |
| `--contact=<string>` | `local-phase1` | Contact string embedded in the User-Agent. |

---

## The viewer

`npm run serve` starts a dependency-free viewer on the same routes the Phase 2 Worker will use:

| Route | Purpose |
|---|---|
| `/` | Shell: site picker, day scrubber, iframe viewer, ingest-report panel. |
| `/api/sites` | Every ingested domain+month, with page and day counts. |
| `/api/manifest?domain=&month=` | Pages, days, coverage and the full ingest report. |
| `/a/<domain>/<day>/<path>` | A snapshot page, served from the content-addressed store. |
| `/assets/<aa>/<hash>` | Asset bytes. Content-addressed, so `immutable` and cacheable forever. |
| `/raw/<domain>/<day>/<path>` | The verbatim original capture (debugging, or re-rewriting without re-fetching). |

Deep link straight into a page:

```
http://127.0.0.1:8787/?domain=samsung.com&month=2024-03&day=2024-03-15
```

A page that was never ingested returns a designed 404 that says what *is* stored rather than a dead
end. If the same URL exists on another day, the viewer redirects to the nearest one — the same
"nearest capture" behaviour the link ledger records.

### What the rewriter does to archived pages

Archived pages are untrusted code from another era, so every page is transformed at ingest:

- **No Wayback toolbar, ever.** Raw `id_` captures have none, and `<base>` is replaced with our own.
- **Assets by content hash.** `src`, `srcset`, lazy-load attributes, inline `style`, `<style>` blocks
  and CSS `url()`/`@import` are all rewritten. Identical bytes are stored once, shared across pages
  and months.
- **Link drift is annotated.** A link resolved to a different day gets `data-cw-delta="-3"` and a
  "captured 3 day(s) earlier" tooltip.
- **Dead links are quarantined, not left to 404.** No capture anywhere in range means the `href` is
  removed and `data-cw-dead` records the original target.
- **Trackers are stubbed.** Analytics, tag managers and ad networks become inert markers; legacy
  globals (`dataLayer`, `ga`, `gtag`, `fbq`, ...) are no-op'd before page scripts run.
- **Dead endpoints cannot hang the page.** `fetch`, `XMLHttpRequest` and resource errors are caught
  and counted, and reported to the shell for a "N blocked requests" indicator.
- **Hostile navigation is neutralised.** `<meta http-equiv=refresh>` is removed, forms cannot post
  into the live internet, external links get `rel="noopener noreferrer nofollow"` + `target=_blank`,
  and `object`/`param` plugin content is stripped.
- **A strict CSP is served with every page**, plus `noindex,nofollow,noarchive`.

---

## Storage layout

```
data/
  ledger.db                                    SQLite: runs, captures, snapshots, links, assets, usage
  pages/<domain>/<day>/<host><path>.html       rewritten HTML, ready to serve
  raw/<domain>/<day>/<host><path>.orig         verbatim original (enables re-rewrite with no re-fetch)
  assets/<ab>/<sha256>                         content-addressed asset bytes, immutable
  meta/<domain>/<month>/manifest.json          pages, days, coverage, assets
  meta/<domain>/<month>/report.json            the full ingest report
```

`raw/` is retained deliberately: a re-rewrite (better shim, tighter CSP, new optimiser) then costs
**zero** archive.org requests. Storage is cheap; politeness is not replaceable.

The `pages/`, `assets/` and `raw/` layout is a drop-in match for the R2 bucket in Phase 4, and the
ledger schema mirrors the D1 schema in plan.md section 8. Phase 4 is therefore a migration, not a
rewrite.

---

## Tests

```bash
npm test        # 30 tests, offline, no archive.org requests
```

The suite covers the parts where the real logic lives, and never depends on archive.org being
reachable:

- URL canonicalisation, tracking-param stripping, site scoping, path depth, route round-tripping
- CDX JSON parsing (including error pages and resumption-key trailers)
- The day-selection policy: one capture per day, dense-capture collapsing, anchor mode, asset
  capture choice, non-200 and non-page exclusion
- Link resolution: same-day preference, nearest-day fallback, tolerance limits
- CSS `url()` / `@import` extraction and rewriting, including `data:` URIs being left alone
- The full rewriter: assets, lazy images, `srcset`, scripts, inline styles, links, drift annotation,
  dead-link quarantine, CSP/robots injection, form neutralisation, plugin stripping, idempotency
- Viewer routing, including site roots in both `/a/domain/day` and `/a/domain/day/` forms

Three defects found by this suite during development, all now regression-tested:

1. `pathDepth('/about/team/')` returned 1 instead of 2 (trailing-slash special case).
2. Same-day captures were silently dropped: the "within 60 seconds" filter compared `HHMMSS` as a
   decimal (`180000 - 90000 = 90000`, which is not nine hours in seconds) and only accepted later
   timestamps, so an *earlier* same-day capture disappeared from the capture count.
3. Every site root returned 404 even though the page was on disk: the route regex required a leading
   `/`, so the `/a/<domain>/<day>` form never matched. Alongside it, `node:sqlite` returns raw
   column names, so `row.r2Key` was `undefined` at runtime while TypeScript claimed it was a string —
   now mapped explicitly in one place.

---

## Known limits

- **CDX reliability is the external risk.** When the index will not answer, you get a seed-only
  mirror and a `partial` run. Re-run later with `--refresh`; the cached survey is reused, so a
  retry is cheap.
- **Assets outside the surveyed window are not fetched.** They are counted as `unavailable` and will
  be fetched on demand by the Phase 2 viewer. `--no-assets` skips them entirely.
- **Client-side JavaScript from the 2010s may still not work.** Pages that depend on dead AJAX APIs
  degrade to their static DOM. The runtime shim keeps them from hanging and reports what was blocked.
- **The viewer serves no caching headers on pages** (`no-store`) because a re-ingest can change
  them. Assets are `immutable`. Phase 2 will add a proper cache-aside layer with invalidation.
- **Not multi-user.** No auth, no quotas, no concurrent-run coordination. That is Phase 4.
