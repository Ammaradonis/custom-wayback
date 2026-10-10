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
npx --no-install pnpm turbo run test        # 132 tests: 33 crawler, 99 api
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
(`cw-field`, `cw-btn`, `cw-panel`, `cw-overlay`, `cw-label`, `cw-segment`) rather than restating
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
- Archived pages served in a `sandbox="allow-scripts allow-forms allow-popups"` iframe
- Strict `Content-Security-Policy` on every served snapshot
- `gitleaks` scans every commit; see `.gitleaks.toml`

