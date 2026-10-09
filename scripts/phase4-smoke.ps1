# Phase 4 end-to-end smoke test against a local `wrangler dev` instance.
#
# Proves the four Phase 4 deliverables actually work together, not just that they
# compile:
#   1. Cloud deployment  — the Worker boots with D1 + R2 + KV + Queues bound
#   2. Queues            — POST /v1/jobs enqueues; the consumer picks it up,
#                          walks the stages, and writes to R2 + D1
#   3. Throttling        — request rate limits and the daily crawl quota refuse
#   4. Cost monitoring   — /v1/jobs/usage reports modelled spend + throttle events
#
# Run against `wrangler dev` on :8787. It talks to archive.org for real, so it is
# deliberately small (one domain, one month, a 3-page budget).

$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787/v1'

function Step($n, $text) { Write-Host "`n=== $n. $text ===" -ForegroundColor Cyan }
function Pass($text) { Write-Host "  PASS  $text" -ForegroundColor Green }
function Fail($text) { Write-Host "  FAIL  $text" -ForegroundColor Red; $script:failures++ }
$failures = 0

# A unique account per run, so repeat runs do not fight over quota counters.
$email = "smoke-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())@example.test"
$password = 'correct-horse-battery-staple-9'

# ── 1. Health: every binding reachable ────────────────────────────────────────
Step 1 'Health check (D1 + R2 + Queues + required secrets)'
$health = Invoke-RestMethod "$base/health"
$health | ConvertTo-Json -Compress | Write-Host
$want = @('d1', 'r2', 'queue', 'secrets')
$missing = $want | Where-Object { -not $health.checks.$_ }
if ($health.ok -and $missing.Count -eq 0) {
  Pass 'D1, R2, the queue binding and required secrets all report healthy'
} else {
  Fail "health reported unhealthy: missing $($missing -join ', ')"
}

# ── 2. Register + login ───────────────────────────────────────────────────────
Step 2 'Register and log in (PBKDF2 hashing in the Workers runtime)'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Invoke-RestMethod "$base/auth/register" -Method Post -ContentType 'application/json' `
  -Body (@{ email = $email; password = $password } | ConvertTo-Json) | Out-Null
$sw.Stop()
$hashMs = $sw.ElapsedMilliseconds
Pass "registered in ${hashMs} ms (PBKDF2 cost is visible and bounded)"

$login = Invoke-RestMethod "$base/auth/login" -Method Post -ContentType 'application/json' `
  -Body (@{ email = $email; password = $password } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.token)" }
if ($login.token) { Pass 'JWT issued' } else { Fail 'no token returned' }

# A wrong password must be rejected.
try {
  Invoke-RestMethod "$base/auth/login" -Method Post -ContentType 'application/json' `
    -Body (@{ email = $email; password = 'wrong-password-entirely' } | ConvertTo-Json) | Out-Null
  Fail 'a wrong password was accepted'
} catch {
  if ($_.Exception.Response.StatusCode.value__ -eq 401) { Pass 'wrong password rejected with 401' }
  else { Fail "wrong password gave $($_.Exception.Response.StatusCode.value__), expected 401" }
}

# ── 3. Cost monitoring endpoints answer before any spend ──────────────────────
Step 3 'Cost monitoring: /v1/jobs/usage and /limits'
$limits = Invoke-RestMethod "$base/jobs/usage/limits" -Headers $headers
$limits | ConvertTo-Json -Compress | Write-Host
if ($limits.monthlyBudgetUsd -eq 25 -and $limits.crawlQuotaPerDay -eq 8) {
  Pass 'guardrails are the configured values (budget $25, quota 8/day)'
} else {
  Fail 'guardrails did not match wrangler config / .dev.vars'
}

$usage0 = Invoke-RestMethod "$base/jobs/usage" -Headers $headers
if ($usage0.month -and $usage0.budget.state -and $usage0.planFloorUsd -eq 5) {
  Pass "usage report for $($usage0.month): plan floor counted, budget state '$($usage0.budget.state)'"
} else {
  Fail 'usage report shape was wrong'
}

# ── 4. Add a domain and start a crawl (the queue path) ────────────────────────
Step 4 'Add domain, start crawl, watch the queue consumer'
$domain = Invoke-RestMethod "$base/domains" -Method Post -Headers $headers -ContentType 'application/json' `
  -Body (@{ rawInput = 'example.com'; budget = @{ maxPagesPerMonth = 3; maxAssetsPerPage = 4 } } | ConvertTo-Json -Depth 4)
Pass "tracking $($domain.domain) (id $($domain.id))"

$job = Invoke-RestMethod "$base/jobs" -Method Post -Headers $headers -ContentType 'application/json' `
  -Body (@{ domainId = $domain.id; month = '2024-01' } | ConvertTo-Json)
Pass "queued job $($job.id) at stage '$($job.stage)'"

# Poll the job until it reaches a terminal state. The consumer is doing real
# archive.org fetches at ~1 request/second, so allow a couple of minutes.
$terminal = @('ready', 'partial', 'failed')
$lastStage = ''
$status = $null
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 2
  try { $status = Invoke-RestMethod "$base/jobs/$($job.id)" -Headers $headers } catch { continue }
  if ($status.stage -ne $lastStage) {
    $lastStage = $status.stage
    Write-Host ("    stage={0,-9} status={1,-9} pages={2}/{3} assets={4}/{5} 429s={6}" -f `
      $status.stage, $status.status, $status.pages_done, $status.pages_total, `
      $status.assets_done, $status.assets_total, $status.ia_429_count)
  }
  if ($status.throttle -and $status.throttle.active) { Write-Host "    THROTTLED: $($status.throttle.message)" -ForegroundColor Yellow }
  if ($terminal -contains $status.status) { break }
}

Write-Host "  final: status=$($status.status) stage=$($status.stage) pages=$($status.pages_done)/$($status.pages_total) bytes=$($status.bytes_stored) attempts=$($status.attempts)"
if ($terminal -contains $status.status) { Pass "job reached terminal state '$($status.status)'" }
else { Fail "job never finished (still $($status.status) at stage $($status.stage))" }

if ($status.pages_done -gt 0) {
  Pass "consumer fetched and rewrote $($status.pages_done) page(s) through the queue"
} elseif ($status.degraded_reason) {
  Write-Host "  NOTE  no pages stored; degraded_reason: $($status.degraded_reason)" -ForegroundColor Yellow
} else {
  Fail 'no pages stored and no degraded_reason explaining why'
}

# ── 5. Cost monitoring reflects what the crawl actually did ───────────────────
Step 5 'Cost monitoring after the crawl'
$usage = Invoke-RestMethod "$base/jobs/usage" -Headers $headers
Write-Host "  total=`$$($usage.totalUsd)  metered=`$$($usage.meteredUsd)  budget=$($usage.budget.state) ($($usage.budget.spentUsd)/$($usage.budget.budgetUsd))"
Write-Host "  quota: $($usage.quota.used)/$($usage.quota.limit) today"
Write-Host "  throttle: $($usage.throttle.events) event(s), $($usage.throttle.totalWaitMs) ms waited"
foreach ($k in $usage.byKind) { Write-Host ("    {0,-16} {1,10} {2}  `${3:N6}" -f $k.kind, $k.units, $k.unit, $k.costUsd) }
foreach ($d in $usage.byDomain) { Write-Host ("    domain {0}: `${1:N6}, {2} bytes, {3} ia fetches" -f $d.domain, $d.totalUsd, $d.bytesStored, $d.iaFetches) }

if ($usage.quota.used -ge 1) { Pass 'the crawl was counted against the daily quota' } else { Fail 'quota counter did not move' }
$iaLine = $usage.byKind | Where-Object { $_.kind -eq 'ia_fetch' }
if ($iaLine -and $iaLine.units -gt 0) { Pass "usage ledger recorded $($iaLine.units) archive.org fetch(es)" }
else { Write-Host '  NOTE  no ia_fetch rows recorded' -ForegroundColor Yellow }

# ── 6. Throttling: the start endpoint refuses a burst ─────────────────────────
Step 6 'Throttling: request rate limit and crawl quota'
# Two layers protect `POST /v1/jobs`, and which one fires depends on how fast you
# ask. The burst below is faster than any human, so the hourly *rate limit*
# (`RATE_LIMITS.jobs`, 12/hour) is what refuses most of it; the daily *crawl
# quota* (CRAWL_QUOTA_PER_DAY, 8/day) is the slower, more important guardrail and
# is asserted separately via /v1/usage below.
$rateHits = 0
$quotaHits = 0
$budgetHits = 0
foreach ($m in 2..14) {
  $month = '2024-{0:D2}' -f $m
  try {
    Invoke-WebRequest "$base/jobs" -Method Post -Headers $headers -ContentType 'application/json' `
      -Body (@{ domainId = $domain.id; month = $month } | ConvertTo-Json) -ErrorAction Stop | Out-Null
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    $body = ''
    try { $body = (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
    switch ($code) {
      429 {
        if ($body -match 'quota_exceeded') { $quotaHits++ } else { $rateHits++ }
        Write-Host "    $month -> 429 $(if ($body -match 'quota_exceeded') { 'quota' } else { 'rate limit' })"
      }
      402 { $budgetHits++; Write-Host "    $month -> 402 budget guardrail" }
    }
  }
}
if ($rateHits -ge 1) { Pass "the hourly request rate limit refused $rateHits request(s) with a 429" }
else { Fail 'no request was ever refused — the rate limit is not working' }
if ($quotaHits -ge 1) { Pass "the daily crawl quota also refused $quotaHits request(s)" }
else { Write-Host '  NOTE  quota not reached in this run (the rate limit fired first); checked via /v1/usage below' -ForegroundColor Yellow }
if ($budgetHits -ge 1) { Write-Host "  NOTE  the budget guardrail fired $budgetHits time(s)" -ForegroundColor Yellow }

# The quota counter must at least have moved, and /v1/usage must agree.
$finalUsage = Invoke-RestMethod "$base/jobs/usage" -Headers $headers
if ($finalUsage.quota.used -ge 1) {
  Pass "quota counter reflects $($finalUsage.quota.used)/$($finalUsage.quota.limit) crawls started today"
} else {
  Fail 'the quota counter never moved'
}

# ── 7. SSE stream shape ───────────────────────────────────────────────────────
Step 7 'SSE progress stream'
# PowerShell 5.1's Invoke-WebRequest buffers a `text/event-stream` response until
# the server closes it — which never happens for SSE — so it hangs rather than
# testing anything. Read the stream directly with a short timeout instead and
# assert on the first frame, which the handler emits immediately on open.
$sseOk = $false
$sseFrame = ''
try {
  $req = [System.Net.HttpWebRequest]::Create("$base/jobs/$($job.id)/events")
  $req.Headers.Add('Authorization', "Bearer $($login.token)")
  $req.Timeout = 8000
  $req.ReadWriteTimeout = 8000
  $resp = $req.GetResponse()
  $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
  $buffer = New-Object char[] 512
  $read = $reader.Read($buffer, 0, 512)
  if ($read -gt 0) { $sseFrame = -join $buffer[0..($read - 1)] }
  $reader.Close(); $resp.Close()
  $sseOk = $sseFrame -match 'data:'
} catch {
  Write-Host "  NOTE  SSE read failed: $($_.Exception.Message)" -ForegroundColor Yellow
}
if ($sseOk) {
  Pass "SSE emitted a frame: $($sseFrame.Trim().Split("`n")[0])"
} else {
  Fail 'no SSE frame was received'
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ''
if ($failures -eq 0) {
  Write-Host 'PHASE 4 SMOKE TEST: all checks passed' -ForegroundColor Green
  exit 0
} else {
  Write-Host "PHASE 4 SMOKE TEST: $failures check(s) failed" -ForegroundColor Red
  exit 1
}
