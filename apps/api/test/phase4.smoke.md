# Phase 4 smoke test — expected transcript

This file is the reference transcript for `scripts/phase4-smoke.ps1`.
It is read by `apps/api/test/phase4.test.ts` and referenced by
`docs/phase-4-deployment.md §7` to anchor what a passing run looks like.

Run the smoke test with:

```powershell
# 1. Start wrangler dev (in a separate terminal)
cd apps/api
npx wrangler d1 migrations apply custom-wayback-ledger --local
npx wrangler dev --port 8787

# 2. Run the script
powershell -ExecutionPolicy Bypass scripts/phase4-smoke.ps1
```

---

## Expected output (annotated)

```
=== 1. Health check (D1 + R2 + Queues + required secrets) ===
{"ok":true,"checks":{"d1":true,"r2":true,"queue":true,"secrets":true}}
  PASS  D1, R2, the queue binding and required secrets all report healthy
```

Every binding must be reachable before proceeding. If `secrets` is false, a
required env var (`JWT_SECRET`, `STORAGE_ACCESS_KEY_ID`,
`STORAGE_SECRET_ACCESS_KEY`) is missing from `.dev.vars`.

```
=== 2. Register and log in (PBKDF2 hashing in the Workers runtime) ===
  PASS  registered in <N> ms (PBKDF2 cost is visible and bounded)
  PASS  JWT issued
  PASS  wrong password rejected with 401
```

`<N>` is typically 300–800 ms for PBKDF2 in Miniflare; this confirms the
`POST /v1/auth/register` route actually hashes (not a no-op stub).

```
=== 3. Cost monitoring: /v1/jobs/usage and /limits ===
{"crawlQuotaPerDay":8,"crawlQuotaRemaining":8,"crawlQuotaResetsAt":<ts>,"monthlyBudgetUsd":25,"readLimitPerMinute":120}
  PASS  guardrails are the configured values (budget $25, quota 8/day)
  PASS  usage report for <YYYY-MM>: plan floor counted, budget state 'ok'
```

`planFloorUsd` must equal `5` (the Workers Paid plan floor; see `PLAN_FLOOR_USD`
in `packages/shared/src/constants.ts`). If `monthlyBudgetUsd` does not equal 25,
`MONTHLY_BUDGET_USD` is not set in `.dev.vars` and the default is being used —
that is allowed but note it for production.

```
=== 4. Add domain, start crawl, watch the queue consumer ===
  PASS  tracking example.com (id <ulid>)
  PASS  queued job <ulid> at stage 'survey'
    stage=survey    status=surveying  pages=0/0     assets=0/0    429s=0
    stage=pages     status=fetching   pages=0/3     assets=0/0    429s=0
    stage=pages     status=fetching   pages=1/3     assets=0/12   429s=0
    stage=pages     status=fetching   pages=2/3     assets=0/24   429s=0
    stage=pages     status=fetching   pages=3/3     assets=0/36   429s=0
    stage=assets    status=rewriting  pages=3/3     assets=0/36   429s=0
    stage=assets    status=rewriting  pages=3/3     assets=12/36  429s=0
    stage=assets    status=rewriting  pages=3/3     assets=24/36  429s=0
    stage=assets    status=rewriting  pages=3/3     assets=36/36  429s=0
  final: status=ready stage=done pages=3/3 bytes=<N> attempts=<N>
  PASS  job reached terminal state 'ready'
  PASS  consumer fetched and rewrote 3 page(s) through the queue
```

Exact page/asset counts vary by budget and by what CDX returns for
`example.com/2024-01`. The important invariants:

- Stage transitions appear in order: `survey` → `pages` → `assets` → `done`.
- `pages_done` never decreases between frames (cursor is durable).
- Final `status` is `ready`, `partial`, or (if CDX is unreachable) `failed`.
  A `partial` with `degraded_reason` is still a pass if the reason is a CDX
  timeout, not a crash; see the conditional `NOTE` in the script.
- `attempts` is ≥ 1 and ≤ `MAX_QUEUE_ATTEMPTS * 4` (stages × max attempts).

If archive.org is throttling during this run, you will see:
```
    THROTTLED: archive.org is throttling us — resuming in <N>s
```
That is expected behaviour, not a failure. The circuit-breaker logic is asserted
in unit tests (`apps/api/test/phase4.test.ts`).

```
=== 5. Cost monitoring after the crawl ===
  total=$5.xx  metered=$0.00  budget=ok ($5.xx/$25.00)
  quota: 1/8 today
  throttle: 0 event(s), 0 ms waited
    ia_fetch          <N>    requests  $0.000000
    r2_put            <N>    ops       $0.000000
    bytes_stored      <N>    bytes     $0.000000
    queue_op          <N>    ops       $0.000000
    worker_request    <N>    requests  $0.000000
  domain example.com: $0.000000, <N> bytes, <N> ia fetches
  PASS  the crawl was counted against the daily quota
  PASS  usage ledger recorded <N> archive.org fetch(es)
```

All `costUsd` values are `$0.000000` in a small smoke run because the free
allowances are not exhausted. `total` equals `planFloorUsd` ($5.00) plus any
metered cost; `metered` is $0.00 here. If `byKind` is empty or `ia_fetch` is
missing, the `UsageBatch` flushed nothing — check `queue/ingest.ts` `usage.flush()`.

```
=== 6. Throttling: request rate limit and crawl quota ===
    2024-02 -> 429 rate limit
    2024-03 -> 429 rate limit
    ...
    2024-0<N> -> 429 quota
    ...
  PASS  the hourly request rate limit refused <N> request(s) with a 429
  PASS  the daily crawl quota also refused <N> request(s)
  PASS  quota counter reflects <N>/8 crawls started today
```

The rate limit (`RATE_LIMITS.jobs`, 12 requests/hour) fires before the daily
quota (8 crawls/day) because the burst loop is faster than a human. Which fires
depends on the window state at the time of the run. Both are acceptable; the
important thing is that *something* refused a 429 and the quota counter moved.

```
=== 7. SSE progress stream ===
  PASS  SSE emitted a frame: data: {"type":"open","ingestId":"<ulid>"}
```

The first frame is always `{"type":"open","ingestId":"..."}` and is emitted
synchronously on connection. If this step reports `NOTE SSE read failed` with a
connection-refused error, `wrangler dev` is not running. If it fails with a
timeout, the SSE handler is not returning a `ReadableStream` response.

```
PHASE 4 SMOKE TEST: all checks passed
```

---

## What to do when a step fails

| Step | Failure | Likely cause |
|---|---|---|
| 1 | `d1` false | D1 migration not applied (`wrangler d1 migrations apply --local`) |
| 1 | `r2` false | `STORAGE_*` env vars missing from `.dev.vars` |
| 1 | `queue` false | `[[queues.consumers]]` not in `wrangler.toml` or queue not created |
| 1 | `secrets` false | `JWT_SECRET` missing from `.dev.vars` |
| 2 | register fails | Auth routes not mounted (`app.route("/v1/auth", authRouter)`) |
| 3 | `planFloorUsd` wrong | `PLAN_FLOOR_USD` constant changed in `packages/shared` without rebuilding |
| 4 | job never finishes | Queue not delivering messages (check `wrangler dev` output for `[Queue]`) |
| 4 | `pages_done = 0` with no `degraded_reason` | `runPages` is throwing and re-enqueueing indefinitely; check D1 `error_message` column |
| 5 | `ia_fetch` units = 0 | `usage.flush()` is not being called after the stage, or `UsageBatch.add()` calls have wrong arguments |
| 6 | no 429s at all | Rate-limit table not created (migration missing); D1 failing open silently |
| 7 | no SSE frame | `GET /v1/jobs/:id/events` handler is not returning a streaming response |

---

## Notes on the 429 acceptance test (plan.md §14 Phase 4)

This smoke test does **not** induce archive.org throttling artificially — doing
so from a shared test environment would be irresponsible. The 429 path is
exercised separately by setting `DEFAULT_FETCH_BUDGET.maxRequests = 1` and
`minDelayMs = 0` in a **preview** (`--env dev`) deployment only, as described in
`docs/phase-4-deployment.md §9`. The unit test in `apps/api/test/phase4.test.ts`
asserts the policy logic deterministically with injected jitter and clock.
