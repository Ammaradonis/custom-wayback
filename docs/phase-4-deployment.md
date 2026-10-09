# Phase 4 — Production ingest: deployment runbook

Everything in this document maps to a numbered item in `plan.md` §14 Phase 4.
Do the steps **in order**; step 0 is not optional and is not a formality.

Phase 4 is "done" when: **a crawl survives an induced archive.org 429 storm,
resumes, and completes; and the usage dashboard matches the invoice line items.**

---

## 0. Rotate the credentials first (plan.md §13)

`apps/api/.dev.vars` contains live-looking values, including a commented-out R2
key pair and a production R2 endpoint in plaintext. Treat them as compromised.

1. Revoke the GitHub PAT.
2. Rotate both Cloudflare API tokens — replace with **one scoped token**:
   `Workers Scripts:Edit`, `Workers KV:Edit`, `R2:Edit`, `D1:Edit`,
   `Queues:Edit`, `Workers Tail:Read` — scoped to this account only.
3. Rotate the R2 access key pair. Issue a **bucket-scoped** key for the
   `custom-wayback` bucket and mark it **Object Read & Write** only — the crawler
   never needs bucket administration.
4. Regenerate the webhook signing secret.
5. Confirm `.gitignore` covers `.dev.vars*` and run `gitleaks detect --no-git` to
   prove nothing leaked into the tree.

```powershell
# from the repo root
gitleaks detect --no-git --config .gitleaks.toml
```

---

## 1. Create the Cloudflare resources

```powershell
cd apps/api

# D1
npx wrangler d1 create custom-wayback-ledger
# → copy database_id into wrangler.toml [[d1_databases]]

# KV (coverage bars)
npx wrangler kv namespace create COVERAGE_KV
# → copy id into wrangler.toml [[kv_namespaces]]

# Queues: the ingest queue and its dead-letter queue
npx wrangler queues create custom-wayback-ingest
npx wrangler queues create custom-wayback-ingest-dlq

# Preview environment variants
npx wrangler queues create custom-wayback-ingest-dev
npx wrangler queues create custom-wayback-ingest-dlq-dev
npx wrangler d1 create custom-wayback-ledger-dev
npx wrangler kv namespace create COVERAGE_KV --env dev
```

Then replace the three `REPLACE_WITH_*` placeholders in
[`apps/api/wrangler.toml`](../../apps/api/wrangler.toml) and set
`CRAWLER_USER_AGENT` to a real contact URL.

> **The dead-letter queue is not optional.** Without it, a message that exhausts
> `max_retries` disappears, and a job silently never finishes.

---

## 2. Apply the schema

```powershell
# local (Miniflare) — used by the smoke test in step 7
cd apps/api
npx wrangler d1 migrations apply custom-wayback-ledger --local

# production
npx wrangler d1 migrations apply custom-wayback-ledger --remote
```

Migration `0001_phase4_queues_throttling_cost.sql` adds the resumable-job columns
(`stage`, `cursor`, `pages_json`, `day_index_json`, `lease_until`, `attempts`,
`consecutive_429`, `breaker_open_until`), the `throttle_events` telemetry table,
and the `rate_limits` counter table.

---

## 3. Secrets

```powershell
cd apps/api
npx wrangler secret put JWT_SECRET                    # ≥ 32 random bytes
npx wrangler secret put STORAGE_ACCESS_KEY_ID         # the NEW bucket-scoped key
npx wrangler secret put STORAGE_SECRET_ACCESS_KEY
```

`STORAGE_ENDPOINT` and `STORAGE_BUCKET_NAME` are not secrets — set them in
`[vars]` if you use them, and never paste a key into `wrangler.toml`.

---

## 4. Tune the politeness knobs before the first crawl

`plan.md` §12 is the reason these exist. Read them as a group; they only work
together.

| Where | Setting | Meaning |
|---|---|---|
| `wrangler.toml` | `[[queues.consumers]] max_concurrency = 2` | jobs processed at once |
| `wrangler.toml` | `max_batch_size = 2` | messages per invocation |
| `apps/api/src/queue/fetch.ts` | `DEFAULT_FETCH_BUDGET.maxRequests = 8` | archive.org requests per message |
| `apps/api/src/queue/fetch.ts` | `DEFAULT_FETCH_BUDGET.minDelayMs = 900` | floor between those requests |
| `packages/shared/src/constants.ts` | `CIRCUIT_BREAKER_THRESHOLD = 5` | consecutive 429s before the breaker opens |
| `packages/shared/src/constants.ts` | `PAGES_PER_MESSAGE = 2` | pages rewritten per message |
| `packages/shared/src/constants.ts` | `ASSETS_PER_MESSAGE = 12` | assets fetched per message |

Observed request rate ≈ `max_concurrency × (1 / minDelayMs)`. At the shipped
values that is **at or under ~1 request/second to archive.org**, which is the
rule the whole product is built to respect. Raising `max_concurrency` without
lowering `maxRequests` breaks that, and the failure mode is not a bill — it is
losing access to the archive this tool depends on.

---

## 5. R2 lifecycle rules (plan.md §11.5 item 3)

```powershell
# dry run first — prints the rules it would apply
node scripts/set-r2-lifecycle.mjs --bucket custom-wayback --dry-run

# apply
$env:CLOUDFLARE_ACCOUNT_ID = "<account id>"
$env:CLOUDFLARE_API_TOKEN  = "<scoped token>"
node scripts/set-r2-lifecycle.mjs --bucket custom-wayback
```

Rules applied:

| Prefix | Action | Rationale |
|---|---|---|
| `raw/` | → Infrequent Access at 30 days | IA has a 30-day minimum storage duration, so transitioning earlier wastes money |
| `raw/` | delete at 180 days | re-fetch-avoidance insurance, not an archive |
| `assets/` | abort incomplete multipart uploads at 7 days | orphaned uploads still bill |

`pages/` is deliberately **not** given a rule: page blobs are already deleted by
the post-serve purge (§11.5 item 4), and a lifecycle rule on top of that would
race the purge and hide bugs in it.

---

## 6. Cloudflare Access, billing alerts and the spend cap

These are dashboard actions with no API surface in this repo, so they cannot be
scripted here. They are still Phase 4 deliverables — do them now, not later.

### 6.1 Access (plan.md §4, §14)

1. Zero Trust → Access → Applications → **Add an application → Self-hosted**.
2. Domain: the Worker's hostname (e.g. `wayback.example.com`).
3. Policy: **Allow**, selector *Emails*, your address. Add a second policy
   **Bypass** for `/v1/health` so uptime checks do not need a login.
4. Session duration: 1 week. This is the single factor that keeps the cached
   corpus private (§12 rule 7).
5. Application → *Settings* → enable **Service Auth** if CI needs to reach a
   protected route, and use a service token rather than a static key (§13.5).

> Keep the app behind Access for as long as the corpus is stored. A public
> `pages/` route is a re-publication service, which §12 rule 7 rules out.

### 6.2 Billing alerts and the hard cap (§11.5 item 2)

1. Cloudflare dashboard → **Manage Account → Billing → Notifications**.
2. Create three spend notifications: **$10**, **$50**, **$200**.
3. Where the dashboard offers it, set a **hard spend cap**. Confirm afterwards
   that the cap actually blocks — a cap that only warns is not a cap.
4. Add a Workers → *Usage-based billing* notification for the Queues and R2 line
   items specifically, because those are the two that can move fastest.

### 6.3 In-app guardrails (belt and braces)

The dashboard alerts are the outer ring. The inner ring is in config and is
enforced before any archive.org request happens:

| Var | Default | Effect |
|---|---|---|
| `MONTHLY_BUDGET_USD` | `25` | `POST /v1/jobs` returns **402** with the exact spent/budget figures once crossed |
| `CRAWL_QUOTA_PER_DAY` | `8` | crawls per user per UTC day, then **429** with the reset time |
| `RATE_LIMITS.jobs` | 12/hour | throttles the start endpoint itself |
| `MAX_PAGES_PER_MONTH` | `1000` | required budget field; the survey caps `pages_json` at it |
| `maxBytesPerMonth` | 750 MB | hard abort mid-crawl, job marked `partial` |

Verify them together after deploy:

```powershell
curl -H "Authorization: Bearer $TOKEN" https://<host>/v1/usage/limits
curl -H "Authorization: Bearer $TOKEN" https://<host>/v1/usage
```

---

## 7. Verify locally before spending anything

The whole Phase 4 path — queue, consumer, rewrite, R2, D1, throttle telemetry —
runs under Miniflare with no cloud account and no archive.org traffic.

```powershell
cd apps/api

# 1. local migrations
npx wrangler d1 migrations apply custom-wayback-ledger --local

# 2. start the Worker (API + queue consumer + cron) on :8787
npx wrangler dev --port 8787 --test-scheduled

# 3. in another shell: register, add a domain, start a job, watch it progress
$base = "http://127.0.0.1:8787/v1"
curl -s -X POST "$base/auth/register" -H 'Content-Type: application/json' `
     -d '{"email":"me@example.com","password":"a-long-enough-password"}'
$token = (curl -s -X POST "$base/auth/login" -H 'Content-Type: application/json' `
     -d '{"email":"me@example.com","password":"a-long-enough-password"}' | ConvertFrom-Json).token
$h = @{ Authorization = "Bearer $token" }

curl -s -H $h "$base/usage/limits"
curl -s -H $h "$base/usage"

# 4. drive the cron sweeps by hand (purge, rate-limit prune, stalled-job re-drive)
curl -s "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"
```

The reproducible version of this lives in the repo's test suite and CI; see
`apps/api/test/phase4.smoke.md` for the exact expected transcript.

---

## 8. Deploy

```powershell
cd apps/api
npx wrangler deploy                # production
npx wrangler deploy --env dev      # preview
```

CI (`.github/workflows/ci.yml`) does the production path on every push to `main`:
build web → apply remote D1 migrations → `wrangler deploy`. It needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as encrypted repository
secrets, and the token must be the **scoped** one from step 0.

---

## 9. Prove the 429 path (this is the Phase 4 acceptance test)

Do not skip this. "It worked when archive.org was healthy" is not the criterion.

1. Start a crawl of a domain+month you have not crawled.
2. Watch `GET /v1/jobs/:id/events`. You should see, in order:
   `stage: "survey"` → `stage: "pages"` with `pagesTotal` set → progress frames
   advancing `pagesDone` → `stage: "assets"` → `status: "ready"`.
3. Now induce throttling. The cheapest honest way is a temporary, deliberate
   change in a preview deployment: set `DEFAULT_FETCH_BUDGET.maxRequests` to 1 and
   `minDelayMs` to 0 in `apps/api/src/queue/fetch.ts`, deploy to `--env dev`, and
   loop the same crawl. `plan.md` §12 is unambiguous that this must never be
   deployed to production.
4. Expected behaviour under throttling, all of which is visible in the SSE
   stream and in D1:
   - `throttle.active` becomes true with a `resumeAt` and a human message;
   - `consecutive_429` climbs; after 5 the job's `breaker_open_until` is set;
   - the consumer **re-enqueues the same stage** rather than failing;
   - rows appear in `throttle_events` with `kind='backoff'` and `kind='breaker'`;
   - `pagesDone` does not go backwards, and the job eventually reaches `ready`
     or `partial` — never a silent stall.
5. Query the evidence:

```powershell
npx wrangler d1 execute custom-wayback-ledger --remote --command `
  "SELECT kind, status, COUNT(*) n, SUM(wait_ms) total_wait_ms FROM throttle_events GROUP BY kind, status"
```

6. Cross-check the dashboard against the invoice:

```powershell
curl -s -H $h "$base/usage" | ConvertFrom-Json | Select-Object month,totalUsd,meteredUsd,planFloorUsd
```

Compare `meteredUsd` and the `byKind` units against the Cloudflare dashboard's
R2 / Workers / Queues figures for the same month. **If they disagree, the
dashboard is wrong** — fix `USAGE_PRICES` or the recording call site, do not
adjust the numbers by hand.

---

## 10. Rollback

| Symptom | Action |
|---|---|
| archive.org throttling hard, all jobs parking | `npx wrangler queues pause-delivery custom-wayback-ingest` and wait; resume with `resume-delivery` |
| runaway spend | set `MONTHLY_BUDGET_USD=0`? — no: set it to a **low positive** number, which blocks new crawls while leaving the dashboard honest. Then pause queue delivery. |
| bad deploy | `npx wrangler rollback` (Workers keeps the previous version) |
| a job stuck in `fetching` | the 5-minute cron re-drives stalled leases automatically; check `attempts` — a job past `MAX_QUEUE_ATTEMPTS` is parked as `partial` by design |
| DLQ filling up | `npx wrangler queues consumer list custom-wayback-ingest-dlq`; every message there also has a D1 row with `error_message = 'dead-lettered: …'` |
