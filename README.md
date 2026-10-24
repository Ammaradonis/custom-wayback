# custom-wayback

Personal, mobile-first Wayback Machine browser.  
Pick a domain + month → wait a few seconds → browse that snapshot as if it were live.

> **Phase status:** Phases 0–3 are complete. **Phase 4 (production ingest) is implemented and
> verified locally** — queues, resumable jobs, throttling, cost monitoring and the deployment
> runbook are all in the tree and covered by tests. What remains for Phase 4 is the part that
> needs your Cloudflare account: applying migrations to the remote D1, deploying, and the
> account-level steps in [docs/phase-4-deployment.md](docs/phase-4-deployment.md) — §6 Access,
> billing alerts, and the hard spend cap.
>
> **Before you deploy anything, read §0 of that runbook. Rotate the credentials.**

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22.6 | Uses `node:sqlite` (22.5+) and `--experimental-strip-types` (22.6+) |
| pnpm | ≥ 9 | `npm i -g pnpm`; the repo is pinned to 9.14.4 |
| Git | any | |
| Playwright browsers | auto | installed by `pnpm install` via `playwright install chromium` |
| Docker (optional) | any | only needed for MinIO as a local R2 stand-in |

> `pnpm` is not always on `PATH`. Every command below also works as
> `npx --no-install pnpm <args>`, which uses the pinned version from the npx cache.

---

## Phase 4 in one minute

The cloud ingest path runs **entirely locally** under Miniflare — real D1, real R2, real Queues,
real queue consumer — with no Cloudflare account and no spend.

```powershell
cd apps\api
npx --no-install pnpm exec wrangler d1 migrations apply custom-wayback-ledger --local
npx --no-install pnpm exec wrangler dev --port 8787 --local --test-scheduled
```

Then, from the repo root in another shell:

```powershell
# Drives health, auth, a real crawl through the queue, cost reporting,
# throttling and the SSE stream. Talks to archive.org for real.
& .\scripts\phase4-smoke.ps1
```

Expected tail:

```
    stage=survey    status=queued    pages=0/3 ...
    stage=pages     status=fetching  pages=0/3 ...
    stage=assets    status=rewriting pages=3/3 ...
    stage=finalize  status=ready     pages=3/3 ...
PHASE 4 SMOKE TEST: all checks passed
```

> **`.dev.vars` must live in `apps/api/`, not the repo root.** `wrangler dev` resolves it
> relative to the Worker's own directory; a file at the root is silently ignored and every login
> then fails with an opaque 500. `GET /v1/health` reports `secrets: false` when this happens.
> That check exists because this mistake was made once already.

### The endpoints Phase 4 adds

| Endpoint | What it is for |
|---|---|
| `GET /v1/jobs/usage` | Cost dashboard: modelled spend, per-kind and per-domain breakdown, budget state, quota, throttle telemetry |
| `GET /v1/jobs/usage/limits` | The throttling and budget limits currently in force |
| `GET /v1/jobs/:id` | Now also returns `stage`, `attempts`, `degradedReason` and a `throttle` object |
| `GET /v1/jobs/:id/events` | SSE; frames carry `stage`, `throttle.message` and `degradedReason` |
| `GET /v1/health` | Asserts D1, R2, the queue binding **and** that required secrets are present |

### Guardrails you can set

| Var | Where | Default | Effect |
|---|---|---|---|
| `MONTHLY_BUDGET_USD` | `wrangler.toml` / `.dev.vars` | `25` | `POST /v1/jobs` returns **402** with the exact figures once crossed |
| `CRAWL_QUOTA_PER_DAY` | same | `8` | crawls per user per UTC day, then **429** with the reset time |
| `RATE_LIMITS.jobs` | `packages/shared/src/constants.ts` | 12/hour | throttles the start endpoint itself |
| `MAX_PAGES_PER_MONTH` | per-domain budget | `1000` | required field; caps the frozen work plan |
| `maxBytesPerMonth` | per-domain budget | 750 MB | hard abort mid-crawl, job marked `partial` |

### Politeness knobs — read `plan.md` §12 before changing these

Politeness inside a Worker cannot be an in-process gate, so it is **configuration plus a
per-message request budget**:

| Knob | Where | Default |
|---|---|---|
| `max_concurrency` / `max_batch_size` | `wrangler.toml` `[[queues.consumers]]` | 2 / 2 |
| `DEFAULT_FETCH_BUDGET.maxRequests` / `.minDelayMs` | `apps/api/src/queue/fetch.ts` | 8 / 900 ms |
| `PAGES_PER_MESSAGE` / `ASSETS_PER_MESSAGE` | `packages/shared/src/constants.ts` | 2 / 12 |
| `BREAKER_THRESHOLD` / backoff ceiling | `packages/shared/src/policy.ts` | 5 / 60 s |

Observed request rate ≈ `max_concurrency × (1 / minDelayMs)`. The shipped values keep it at or
under ~1 request/second to archive.org. **Raising `max_concurrency` without lowering `maxRequests`
breaks that** — and the cost of being wrong is not a bill, it is losing access to the archive this
tool depends on.

---

## The viewer: fast, and rendered like a real browser

Reading never waits on a crawl: any page of any day is fetched from archive.org on first view,
rewritten, and from then on served from Cloudflare's edge.

| What happens | Where | Why it is fast |
|---|---|---|
| A rendered page is cached at the edge for 7 days, keyed by route, origin and runtime version | `serveSnapshotPage` in `apps/api/src/routes/viewer.ts` | A repeat view is an edge hit: no D1 query, no archive.org request (plan.md §12 rule 1: one `id_` fetch per URL per day, ever) |
| Archived resources are cached at the edge, including "not archived" answers (1 day) | `fetchOnDemandResource` | A missing asset is not re-requested from archive.org on every view |
| The page's top in-site links — and any link the reader hovers — are prepared at the edge before they are clicked, with the stylesheets and blocking scripts they need to paint | `POST /_cw/warm` → `scheduleWarm` | The next click is an edge hit. Paced: one page at a time, at most 2 pages and 6 uncached assets per request, sent in staggered batches, inside the Free plan's subrequest and CPU limits. Any 429 from archive.org pauses it in that data centre for 2 minutes |
| The capture is found with `id_` replay, following archive.org's redirects by hand | `locateCapture` | One round trip cheaper than availability-then-fetch, and correct for sites whose homepage is a redirect (samsung.com → `/us/`) |
| Analytics, tag managers and beacons are never proxied | `isTrackerUrl`, runtime `isTracker` | They are refused in the browser by the page's policy, at no cost to anyone |

What makes a modern page *render*:

- **Resource URLs keep the original directory structure** — `/_cw/r/<ts>/<scheme>/<host><path>` —
  so code-split bundles (webpack `publicPath: 'auto'`, native `import './chunk.js'`) and a
  stylesheet's own relative `url()`s resolve to the right archived file.
- **The runtime rewrites what page scripts build after load**: `img.src`/`srcset` property writes,
  `innerHTML`, `insertAdjacentHTML`, `document.write`, inline style and CSSOM writes, and links
  rendered with root-relative hrefs — with a `MutationObserver` as the net under the hooks. A
  root-relative URL that still escapes is recovered by the Worker from its `Referer`.
- **A top-level visit to a viewer URL gets the app shell** (reload, shared link, new tab), never the
  archived page outside the viewer.
- **The page's encoding is preserved**, so a page that declared it only in markup is not decoded
  as windows-1252.

### The frame origin (recommended)

Served from the app's own origin, an archived page must run in an opaque-origin sandbox
(plan.md §10). Modern pages break there: `document.cookie` throws, so does the about:blank frame a
page builds for itself, and browsers give an opaque origin **no HTTP cache**, so every page view
downloads the site's scripts and stylesheets again. The runtime papers over the first two; nothing
fixes the third.

`apps/api/wrangler.frame.toml` deploys the same Worker a second time as an **archive-only origin**.
There, archived pages keep a real origin (`allow-same-origin` is safe because nothing of the app runs
on it: the `ROLE = "frame"` guard refuses the shell, the API and share links), only the app may frame
it (`frame-ancestors`), and a site's assets are cached by the browser across pages.

To turn it on, set one repository variable — CI does the rest on the next push to `main`:

```powershell
gh variable set FRAME_ORIGIN --body "https://custom-wayback-frame.ammar-webalchemist.workers.dev"
```

That deploys the frame Worker (before the app, so the shell never points at nothing) and builds the
web app with `VITE_FRAME_ORIGIN`. Unset the variable to go back. Locally:

```powershell
cd apps\api
npx --no-install pnpm exec wrangler dev --port 8788 --local
npx --no-install pnpm exec wrangler dev -c wrangler.frame.toml --port 8789 --local --var APP_ORIGIN:http://127.0.0.1:8788
# and build the web app with $env:VITE_FRAME_ORIGIN = "http://127.0.0.1:8789"
```

### When archive.org rate-limits the viewer

archive.org answers the Worker's own requests with HTTP 429 far more often than a person's
connection: on 24 October 2026 it refused 9 of 10 from the production Worker while the same
captures loaded normally from a home connection. A page the Worker has to fetch then cannot be
shown. Two fallbacks cover that case, and **only** that case — a page that loads is never touched:

| Fallback | What the reader sees | Trade-off |
|---|---|---|
| **A stored copy from the nearest day** | The same page from the closest day whose copy is in R2 — pre-crawled (below) or kept by a crawl — with every viewer feature. A bar says which day it is from and offers to try the requested day again | It is another day of the page |
| **archive.org's own replay** | `web.archive.org/web/<ts>if_/<url>` in the frame, loaded by the reader's own browser | archive.org sees the reader's IP address, and the viewer's links, prefetching and edge caching don't work on that page |

Both are on by default and tried in that order. Each is a switch in the viewer's **When archive.org
is rate-limiting** panel (the life-buoy button), saved per browser; with both off, the page shows the
error and a bar offering either one for that page. When a page loads but archive.org refused some of
its files, the bar says how many and offers the replay.

How it fits together: on a 429 the Worker answers the frame with a failure page whose `cw:failure`
detail carries `reason: "archive-throttled"`, the capture's URL and timestamp, and the nearest day
with a stored copy (`throttledPage` and `nearestStoredDay` in `apps/api/src/routes/viewer.ts`).
A throttled file carries `Server-Timing: cw-throttled`, the one part of a failed response a page can
read, and the runtime counts those. The shell applies the reader's settings
(`apps/web/src/lib/fallbacks.ts`). The replay frame is sandboxed without forms or top navigation,
and sends no referrer.

#### Pre-crawling with the local crawler

The local crawler fetches through your own connection, which archive.org rarely throttles, and can
publish what it crawled into the deployment's R2:

```powershell
cd apps\crawler-local
npm run login -- --api=https://custom-wayback-api.ammar-webalchemist.workers.dev   # once; asks for email and password
npm run crawl -- --domain=apple.com --month=2024-03 --publish                       # crawl, then publish
npm run publish -- --domain=apple.com --month=2024-03                                # publish an earlier crawl
```

`publish` sends the month's rewritten pages and every file they use, stylesheets' own fonts and
images included — assets first, so no page is visible before what it needs. Only files the Worker
lacks are uploaded, and R2 checks each one's SHA-256 against its key. The pages are recorded with
`snapshots.source = 'local'` (migration `0005_precrawl_source.sql`) and **the post-serve purge never
deletes them**; the viewer serves them like any stored page, with the current runtime, policy and
sandbox, and without an archive.org request. Publishing needs a signed-in account, and accounts exist
only for `ALLOWED_EMAILS`. The session lasts 7 days and is kept in
`apps/crawler-local/data/publish-session.json` (git-ignored); `CW_TOKEN` overrides it. The viewer's
panel shows how many pages of the month on screen are pre-crawled, with these commands filled in.

The upload API is `apps/api/src/routes/precrawl.ts`: `POST /v1/precrawl/runs`,
`POST /v1/precrawl/assets/missing`, `PUT /v1/precrawl/assets/:hash`,
`PUT /v1/precrawl/runs/:id/pages`, `POST /v1/precrawl/runs/:id/finish`, and
`GET /v1/precrawl?domain=&month=` for the panel. A month a cloud crawl is still writing is refused
(409) until that crawl ends, since both would write the same rows.

---

## Continuous deployment

**Every push to `main` deploys via GitHub Actions** — see the `deploy` job in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). The order is
`gitleaks → typecheck → build → tests → deploy`, so a commit that fails the 217-test suite never
reaches production.

The deploy job needs two repository secrets, `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The token is the part that bites: it must carry **five** Account-scoped
permissions, and each missing one fails a *different* step, which makes the error messages
misleading:

| Permission (Account-scoped) | Needed for | Symptom when missing |
|---|---|---|
| Workers Scripts → Edit | Uploading the script and the asset bundle | `assets-upload-session` → `403 No access to the specified resource` |
| Cloudflare Queues → Edit | Configuring the producers/consumers in `wrangler.toml` | Failure while applying bindings |
| Workers KV Storage → Edit | Binding `COVERAGE_KV` | Failure while applying bindings |
| Workers R2 Storage → Edit | Binding the `STORAGE` bucket | Failure while applying bindings |
| D1 → Edit | `wrangler d1 migrations apply --remote` | Failure in the migrations step |

Two notes if you rotate the token. Editing a token's permissions **in place** may silently keep
the old scopes in effect; rolling/regenerating it is what actually takes, and that produces a new
value you must re-set with `gh secret set CLOUDFLARE_API_TOKEN`. And `workers.dev` deploys do not
need **Workers Routes**, which is zone-scoped — that is the one permission in Cloudflare's
"Edit Cloudflare Workers" template this project does not use.

The bundle has been verified end to end: the Worker is live at
`https://custom-wayback-api.ammar-webalchemist.workers.dev`, and `GET /v1/health` reports
`{"ok":true,"checks":{"d1":true,"r2":true,"queue":true,"secrets":true}}`.

> Cloudflare's own **Workers Builds** Git integration is a reasonable alternative that needs no
> token at all — its token is generated and scoped by Cloudflare. It was evaluated and passed
> over for one concrete reason: it has no test gate, so a commit that breaks the suite would
> still deploy. If you ever switch to it, note the auto-generated build token carries **no D1**
> permission, so migrations need either a custom token or a separate deliberate step, and set
> `NODE_VERSION=22` (the image defaults to Node 24, where the crawler's `--experimental-sqlite`
> flag no longer exists) plus `PNPM_VERSION=9.14.4`.

---

## Deployment scripts

```powershell
# R2 lifecycle rules (raw/ → IA at 30d, delete at 180d, abort stale multipart uploads)
node scripts/set-r2-lifecycle.mjs --bucket custom-wayback --dry-run

# Billing alert thresholds ($10 /50 / $200). The hard spend cap is dashboard-only.
node scripts/set-billing-alerts.mjs --dry-run
```

Full runbook, including the induced-429 acceptance test and the rollback table:
[docs/phase-4-deployment.md](docs/phase-4-deployment.md).

---

## Tests

```powershell
npx --no-install pnpm turbo run typecheck   # 7 tasks, all packages
npx --no-install pnpm turbo run test        # 217 tests: 45 crawler, 172 api
```

`apps/api`'s tests run the **shipping module graph**: `scripts/run-api-tests.mjs` bundles each test
file with the same esbuild that `wrangler deploy` uses, so `.js` import specifiers and workspace
links resolve exactly as they do in production. The queue consumer is driven end to end against a
fake D1/R2/Queues with a stubbed network, which is the only way to test the parts that matter —
stage transitions, cursor resumption, and a 429 storm that no real run can schedule.

> **Workspace dependencies must be declared, even inside a monorepo.** `crawler-local` imported
> `@custom-wayback/shared` while its `package.json` listed only `@custom-wayback/pipeline`, so
> `tsc` could not resolve the module and the package's typecheck failed with
> `TS2307: Cannot find module '@custom-wayback/shared'`. pnpm's strict `node_modules` layout — the
> thing that stops a package from importing something it never asked for — is what surfaced it. The
> import was deliberate (`src/politeness.ts` shares its backoff maths with the Worker's queue
> consumer so the two crawl paths cannot drift), so the fix was the declaration, not the import.

### UI verification

A stylesheet can build green and style nothing. That is not hypothetical here — it is what
happened: `index.css` declared its colour tokens in `@layer base`, Tailwind v4 never registered
them, and every `bg-background`, `text-foreground`, `border-border` and sibling resolved to **no
CSS rule at all**, across 246 usages. The build exited 0, the CSS gzipped to 12 KB, and the app
rendered with no styling. These five scripts exist so that class of failure cannot recur silently:

```powershell
cd apps\web
npx --no-install pnpm run build          # required first: the checks read dist/
npx --no-install pnpm run verify:ui      # all five, in order
```

| Script | What it proves |
|---|---|
| `check:contrast` | Parses `src/styles/tokens.css` and asserts every foreground/background pair the app renders meets WCAG 2.1 AA (4.5:1 for text, 3:1 for UI, plus a border-visibility floor) in **both** themes. 52 checks. |
| `check:css` | Derives the semantic utility classes from `src/`, then asserts each one is a real selector in the built CSS. Catches a token that stops being registered. |
| `check:visual` | Loads the built stylesheet in Chromium and measures *resolved* colours, borders, focus rings and overlay opacity at 320 px, in both themes. Proves the rules actually apply. |
| `test:e2e` | Drives the real `MonthCalendar` in a browser against a stubbed API — opens the popover, picks a month from the month grid, a year from the year grid, a day from the day grid, and selects with the keyboard. |
| `check:mobile` | The same at 320 px, where the calendar renders as a bottom sheet: asserts the sheet is anchored to the bottom edge, spans the viewport, and keeps its day cells tappable. |

The first three need only `dist/`; the last two start a Vite dev server on a free port and stub
`/v1/**`. Screenshots and the generated fixture land in `apps/web/scripts/__screens__/`
(git-ignored) and are the artefacts to eyeball when a check fails.

**The token rule.** Semantic colours live in `src/styles/tokens.css` under `@theme`, as
`light-dark(<light>, <dark>)` pairs. Adding a colour means adding a token there *and* a matching
entry in `check:contrast`'s `CHECKS` list, or the audit will not cover it. Never use a raw Tailwind
palette colour (`text-amber-300`) for app chrome: those are dark-theme-only values and they
disappear against the light theme. Controls use the component classes defined in `src/index.css`
(`cw-field`, `cw-btn`, `cw-panel`, `cw-overlay`, `cw-label`, `cw-segment`, `cw-switch`) rather than restating
five utilities at every call site.

---

## Local-only workflow (Phases 1–3)

```powershell
# Crawl one domain, one month, into a browsable local mirror
pnpm --filter @custom-wayback/crawler-local run crawl -- --domain=samsung.com --month=2024-03 --max-pages=50

# Browse it
pnpm --filter @custom-wayback/crawler-local run serve      # http://localhost:8787

# Stats table
pnpm --filter @custom-wayback/crawler-local run stats
```

Output lands in `apps/crawler-local/data/`. The crawl respects archive.org's rate limits
(≥ 1 s between requests) and backs off on 429s. **Never reduce `--min-delay-ms` below 250** —
the CLI enforces this.

### Crawler CLI reference

```
node src/cli.ts crawl --domain=<domain> --month=YYYY-MM [options]
node src/cli.ts serve [--port=8787]
node src/cli.ts stats [--domain=<domain>]
node src/cli.ts login --api=<app url> [--email=<email>] [--token=<token>]
node src/cli.ts publish --domain=<domain> --month=YYYY-MM [--api=<app url>]

Required:
  --domain=<domain>        e.g. samsung.com
  --month=YYYY-MM          e.g. 2024-03

Options:
  --mode=perday|anchor     perday (default): one best capture per day per URL
                           anchor: pin every URL to the single best-captured day
  --seed=<url>             override the seed page
  --max-pages=<n>          page budget (default 250; your setting: up to 1000)
  --max-depth=<n>          link-follow depth (default 3)
  --max-assets=<n>         assets per page (default 120)
  --max-bytes=<mb>         total byte budget (default 750 MB)
  --min-delay-ms=<n>       per-host spacing (default 1000; minimum 250)
  --cdx-deadline=<ms>      wall-clock ceiling for CDX survey (default 90000)
  --no-assets              HTML only
  --refresh                ignore cached CDX survey, re-query
  --verbose                debug logging
  --publish                after the crawl, publish the month to the deployed viewer's R2
                           (see "Pre-crawling with the local crawler" above)
```

---

## Repository layout

```
apps/
  crawler-local/   Local Node crawler + viewer. No cloud dependencies, no spend.
  api/             Cloudflare Worker: auth, domains, jobs, cost reporting, and the
                   queue consumer that performs cloud ingestion.
  web/             React 19 + Vite PWA shell (picker, viewer, cost panel).
packages/
  pipeline/        Runtime-agnostic ingest logic (URL canonicalisation, CDX specs and
                   parsing, day selection, mirror runtime) shared by crawler-local and
                   the Worker's queue consumer. Standard globals only — no Node, no DOM.
  shared/          Drizzle D1 schema, Zod types, cost model, politeness policy, migrations.
scripts/
  install-hooks.sh        gitleaks pre-commit guard
  phase4-smoke.ps1        end-to-end smoke test against a local Worker
  set-r2-lifecycle.mjs    R2 lifecycle rules
  set-billing-alerts.mjs  billing alert thresholds
docs/
  phase-4-deployment.md   the Phase 4 runbook
```

---

## Etiquette / archive.org limits

This tool stays at ≥ 1 s between requests, sends an honest User-Agent with contact info, backs off
exponentially on 429/503, records every backoff in `throttle_events`, and parks a throttled job
rather than hammering a service that asked it to stop. See `plan.md` §12 for the full rules.

---

## Cost (cloud)

Personal use (2 domains, ~400 pages/month): **≈ $6/month** (Workers Paid plan $5 + R2 storage).
Running the crawler from your own PC keeps it at **$0–2/month**. `GET /v1/jobs/usage` reports the
same line items the invoice does, computed from usage recorded as the work happens — see
[plan.md](plan.md) §11 for the unit prices and their sources.

---

## Security notes

- Passwords hashed with **PBKDF2-HMAC-SHA-256** (600,000 iterations, the OWASP figure). Argon2id
  is the better algorithm, but `oslo/password` ships native binaries that cannot be bundled into a
  Worker; [`apps/api/src/lib/password.ts`](apps/api/src/lib/password.ts) explains the trade-off and
  the migration path.
- JWTs signed with **HS256**, 7-day TTL, revocable via the sessions table
- Archived pages served in a sandboxed iframe: an opaque origin on the app's own origin, or a
  real origin on the archive-only frame origin, which no session, API or app shell ever reaches
  (see [the frame origin](#the-frame-origin-recommended))
- Strict `Content-Security-Policy` on every served snapshot
- `gitleaks` scans every commit; see `.gitleaks.toml`

