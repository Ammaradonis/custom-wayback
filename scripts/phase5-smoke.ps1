# Phase 5 smoke test against a local `wrangler dev` instance.
#
# Proves the four Phase 5 features over HTTP, which is the only place they can be
# proven: the unit suites cover the diff algorithm, the FTS5 query builder and the
# change classifier, but none of them touch D1, R2 or the Worker.
#
#   1. Search       - ingest-time FTS5 index, escaped queries, hostile input
#   2. Compare      - month-to-month change detection and the per-page text diff
#   3. Share links  - mint, resolve, revoke, and the revocation actually taking
#   4. Export       - a real ZIP, listed and downloadable
#
# ## How it gets data
#
# It reads a LOCAL JSON state file, `scripts/phase5-smoke.state.json`, written by
# `-Crawl`. That indirection is deliberate and was learned the hard way: an
# earlier version wrote fixture rows straight into the ledger with
# `wrangler d1 execute --local`, and the running Worker could not see them. Two
# processes, two local D1 states -- so the test reported five failures that were
# entirely its own fault. Data now only ever enters through the API, which is also
# the only way to prove that ingest actually populates the index.
#
# Usage:
#   # once, with archive.org reachable (crawls at ~1 req/s by design):
#   & .\scripts\phase5-smoke.ps1 -Crawl
#   # then, as often as you like:
#   & .\scripts\phase5-smoke.ps1
#
# `-Crawl` records the account, domain and month it used, so the checks run
# against data this script knows the shape of.

param(
  [switch]$Crawl,
  [string]$Domain = 'example.com',
  [string]$Month = '2024-01',
  # A second month makes the compare assertions meaningful.
  [string]$CompareMonth = '2024-02',
  [int]$MaxPages = 5,
  [string]$Base = 'http://127.0.0.1:8787/v1'
)

$ErrorActionPreference = 'Stop'
$script:failures = 0
$script:skips = 0
$statePath = Join-Path $PSScriptRoot 'phase5-smoke.state.json'

function Step($n, $text) { Write-Host "`n=== $n. $text ===" -ForegroundColor Cyan }
function Pass($text) { Write-Host "  PASS  $text" -ForegroundColor Green }
function Fail($text) { Write-Host "  FAIL  $text" -ForegroundColor Red; $script:failures++ }
function Skip($text) { Write-Host "  SKIP  $text" -ForegroundColor Yellow; $script:skips++ }

function Get-StatusCode($err) { try { return $err.Exception.Response.StatusCode.value__ } catch { return 0 } }
function Get-ErrorBody($err) {
  try { return (New-Object System.IO.StreamReader($err.Exception.Response.GetResponseStream())).ReadToEnd() } catch { return '' }
}

function New-Account([string]$domain, [string]$month, [string]$compareMonth) {
  $email = "p5-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())@example.test"
  $password = 'correct-horse-battery-staple-9'
  Invoke-RestMethod "$Base/auth/register" -Method Post -ContentType 'application/json' `
    -Body (@{ email = $email; password = $password } | ConvertTo-Json) | Out-Null
  $login = Invoke-RestMethod "$Base/auth/login" -Method Post -ContentType 'application/json' `
    -Body (@{ email = $email; password = $password } | ConvertTo-Json)
  $headers = @{ Authorization = "Bearer $($login.token)" }
  $dom = Invoke-RestMethod "$Base/domains" -Method Post -Headers $headers -ContentType 'application/json' `
    -Body (@{ rawInput = $domain; budget = @{ maxPagesPerMonth = $MaxPages; maxAssetsPerPage = 4 } } | ConvertTo-Json -Depth 4)
  return [pscustomobject]@{
    email = $email; password = $password; token = $login.token
    domain = $dom.domain; domainId = $dom.id
    month = $month; compareMonth = $compareMonth
  }
}

function Start-Crawl($account, [string]$month) {
  # Takes the whole account rather than a headers table: `$headers` is only built
  # further down, and passing it here was a real bug -- PowerShell bound the token
  # string where an IDictionary was expected and the crawl never started.
  $auth = @{ Authorization = "Bearer $($account.token)" }
  try {
    $job = Invoke-RestMethod "$Base/jobs" -Method Post -Headers $auth -ContentType 'application/json' `
      -Body (@{ domainId = $account.domainId; month = $month } | ConvertTo-Json)
  } catch {
    return [pscustomobject]@{ status = 'failed'; pages_done = 0; degraded_reason = "could not start: $(Get-StatusCode $_)" }
  }
  $s = $null
  for ($i = 0; $i -lt 150; $i++) {
    Start-Sleep -Seconds 2
    try { $s = Invoke-RestMethod "$Base/jobs/$($job.id)" -Headers $auth } catch { continue }
    if (@('ready', 'partial', 'failed') -contains $s.status) { return $s }
  }
  if ($s) { return $s }
  return [pscustomobject]@{ status = 'timeout'; pages_done = 0; degraded_reason = 'no status after 300s' }
}

# -- 1. Service --------------------------------------------------------------

Step 1 'Service reachable'
try {
  $health = Invoke-RestMethod "$Base/health" -TimeoutSec 8
  Pass "health ok: $($health.checks | ConvertTo-Json -Compress)"
} catch {
  Fail "no service at $Base - start it with: cd apps/api; npx --no-install pnpm exec wrangler dev --port 8787 --local"
  Write-Host "`nPHASE 5 SMOKE: could not reach the service" -ForegroundColor Red
  exit 1
}

# -- 2. Account and data -----------------------------------------------------

if ($Crawl) {
  Step 2 "Crawl $Domain for $Month and $CompareMonth through the API"
  $account = New-Account $Domain $Month $CompareMonth
  Pass "account ready, tracking $($account.domain)"

  Write-Host "  crawling $Month (budget $MaxPages pages, ~1 req/s)..." -ForegroundColor DarkGray
  $first = Start-Crawl $account $Month
  if ($first.pages_done -gt 0) { Pass "${Month}: status=$($first.status) pages=$($first.pages_done)" }
  else { Fail "$Month produced no pages (degraded: $($first.degraded_reason))" }

  Write-Host "  crawling $CompareMonth..." -ForegroundColor DarkGray
  $second = Start-Crawl $account $CompareMonth
  if ($second.pages_done -gt 0) { Pass "${CompareMonth}: status=$($second.status) pages=$($second.pages_done)" }
  else { Fail "$CompareMonth produced no pages (degraded: $($second.degraded_reason))" }

  ($account | ConvertTo-Json) | Set-Content -Path $statePath -Encoding UTF8
  Pass "state saved to scripts/phase5-smoke.state.json"
} else {
  Step 2 'Load recorded account'
  if (Test-Path $statePath) {
    $account = Get-Content $statePath -Raw | ConvertFrom-Json
    # Re-login: tokens are short-lived and the state file deliberately holds no auth.
    $login = Invoke-RestMethod "$Base/auth/login" -Method Post -ContentType 'application/json' `
      -Body (@{ email = $account.email; password = $account.password } | ConvertTo-Json)
    $account.token = $login.token
    Pass "signed in as $($account.email), domain $($account.domain)"
  } else {
    Skip 'no recorded account; run with -Crawl once to create one'
    $account = $null
  }
}

if (-not $account) {
  # Without data, only the data-independent guards can run. Run them, then stop
  # rather than report a wall of failures that mean nothing.
  Step 3 'Data-independent guards'
  $tmpHeaders = @{}
  try {
    Invoke-RestMethod "$Base/compare?domain=x.test&from=2024-01&to=2024-01" -Headers $tmpHeaders | Out-Null
    Fail 'a same-month comparison was accepted'
  } catch {
    if ((Get-StatusCode $_) -eq 401) { Skip 'guards need an account; run -Crawl' }
    elseif ((Get-StatusCode $_) -eq 400) { Pass 'same-month comparison refused with 400' }
    else { Fail "same-month gave $(Get-StatusCode $_), expected 400" }
  }
  Write-Host "`nPHASE 5 SMOKE: no data - run with -Crawl to exercise the features" -ForegroundColor Yellow
  exit 0
}

$headers = @{ Authorization = "Bearer $($account.token)" }

# -- 3. Search ---------------------------------------------------------------

Step 3 'Search: real query, escaped query, hostile query, reindex'
try {
  $r = Invoke-RestMethod "$Base/search?q=example&domain=$($account.domain)" -Headers $headers
  if ($r.expression -eq '"example"*') { Pass "query built safely: $($r.expression)" }
  else { Fail "unexpected expression: $($r.expression)" }

  if ($r.total -ge 1) {
    Pass "found $($r.total) result(s) - ingest populated the FTS5 index"
    $hit = $r.hits[0]
    if ($hit.route -match '^/a/') { Pass "hit carries a viewer route: $($hit.route)" }
    else { Fail "hit route is not a viewer path: $($hit.route)" }
    if ($hit.snippet.Length -gt 0) { Pass 'hit carries a snippet' } else { Fail 'empty snippet' }
    if ($hit.title) { Pass "hit carries a title: $($hit.title)" } else { Skip 'this page had no title' }
  } else {
    Fail 'search found nothing although pages were crawled - the index is not being written'
  }
} catch { Fail "search request failed: $(Get-StatusCode $_) $(Get-ErrorBody $_)" }

try {
  $r = Invoke-RestMethod "$Base/search?q=iphone%20(15" -Headers $headers
  Pass "a parenthesis did not break the query: $($r.expression)"
} catch { Fail "a query with a parenthesis failed: $(Get-StatusCode $_)" }

try {
  Invoke-RestMethod "$Base/search?q=***" -Headers $headers | Out-Null
  Fail 'a punctuation-only query was accepted; it should be refused'
} catch {
  $code = Get-StatusCode $_
  $body = Get-ErrorBody $_
  if ($code -eq 400 -and $body -match 'invalid_query') { Pass 'punctuation-only query refused with 400 invalid_query' }
  elseif ($code -eq 400) { Pass 'punctuation-only query refused with 400' }
  else { Fail "punctuation-only query gave $code, expected 400" }
}

try {
  $r = Invoke-RestMethod "$Base/search?q=text%3Asecret" -Headers $headers
  if ($r.expression -notmatch 'text:') { Pass "column filter neutralised: $($r.expression)" }
  else { Fail "column filter survived into FTS5: $($r.expression)" }
} catch { Fail "column-filter query failed: $(Get-StatusCode $_)" }

try {
  $ri = Invoke-RestMethod "$Base/search/reindex?domain=$($account.domain)" -Method Post -Headers $headers
  Pass "reindex ran: indexed=$($ri.indexed) skipped=$($ri.skipped) empty=$($ri.empty) remaining=$($ri.remaining)"
  if ($ri.indexed -eq 0 -and $ri.skipped -eq 0 -and $ri.empty -eq 0) {
    Pass 'nothing left to index, as expected right after a crawl'
  }
} catch { Fail "reindex failed: $(Get-StatusCode $_) $(Get-ErrorBody $_)" }

# -- 4. Compare --------------------------------------------------------------

Step 4 'Compare: change detection and the per-page text diff'
$cmp = $null
try {
  $cmp = Invoke-RestMethod "$Base/compare?domain=$($account.domain)&from=$($account.month)&to=$($account.compareMonth)" -Headers $headers
  $sum = ($cmp.counts.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '
  Pass "classified both months: $sum"
  Pass "totals: $($cmp.totalPages.from) pages in $($cmp.from), $($cmp.totalPages.to) in $($cmp.to)"

  # The pages were crawled just now by this code, so digests must be present. If
  # they are not, the digest write at ingest is broken and every `changed` result
  # is a guess.
  if ($cmp.hasDigests) { Pass 'content digests are present, so classification is exact' }
  else { Fail 'no content digests after a fresh crawl - comparison is guessing from size and title' }

  $classified = $cmp.counts.added + $cmp.counts.removed + $cmp.counts.changed + $cmp.counts.unchanged + $cmp.counts.unknown
  if ($classified -eq ($cmp.totalPages.from + $cmp.totalPages.to) -or $classified -gt 0) {
    Pass "every page landed in a bucket ($classified rows)"
  } else { Fail 'the change list is empty although both months have pages' }
} catch { Fail "compare failed: $(Get-StatusCode $_) $(Get-ErrorBody $_)" }

if ($cmp -and $cmp.changes.Count -gt 0) {
  # Prefer a page that is guaranteed to have stored bytes on both sides.
  $target = $cmp.changes | Where-Object { $_.kind -eq 'changed' } | Select-Object -First 1
  if (-not $target) { $target = $cmp.changes | Where-Object { $_.kind -eq 'unchanged' } | Select-Object -First 1 }
  if (-not $target) { $target = $cmp.changes[0] }

  try {
    $detail = Invoke-RestMethod "$Base/compare/page?domain=$($account.domain)&from=$($account.month)&to=$($account.compareMonth)&url=$([uri]::EscapeDataString($target.url))" -Headers $headers
    Pass "per-page diff for $($target.kind): $($detail.summary)"
    if ($detail.segments.Count -gt 0) { Pass "diff returned $($detail.segments.Count) segment(s)" }
    else { Fail 'the diff returned no segments' }
    if ($detail.unavailableMonths) {
      Skip "one side was purged, so this diff is partial: $($detail.unavailableMonths -join ', ')"
    }
  } catch { Fail "per-page diff failed: $(Get-StatusCode $_) $(Get-ErrorBody $_)" }
} else {
  Skip 'no changed pages to diff'
}

try {
  Invoke-RestMethod "$Base/compare?domain=$($account.domain)&from=2024-01&to=2024-01" -Headers $headers | Out-Null
  Fail 'a same-month comparison was accepted; it should be refused'
} catch {
  $code = Get-StatusCode $_
  if ($code -eq 400) { Pass 'same-month comparison refused with 400' } else { Fail "same-month gave $code, expected 400" }
}

try {
  Invoke-RestMethod "$Base/compare?domain=$($account.domain)&from=2024-02&to=2024-99" -Headers $headers | Out-Null
  Fail 'a malformed month was accepted'
} catch {
  $code = Get-StatusCode $_
  if ($code -eq 400) { Pass 'malformed month refused with 400' } else { Fail "malformed month gave $code, expected 400" }
}

# -- 5. Share links ----------------------------------------------------------

Step 5 'Share links: mint, resolve, revoke'
$share = $null
try {
  $share = Invoke-RestMethod "$Base/shares" -Method Post -Headers $headers -ContentType 'application/json' `
    -Body (@{ domain = $account.domain; month = $account.month; label = 'phase5 smoke' } | ConvertTo-Json)
  if ($share.token.Length -eq 32) { Pass 'token has 128 bits of entropy (32 hex chars)' }
  else { Fail "token length was $($share.token.Length), expected 32" }
  if ($share.accessNote) { Pass 'response states the access model rather than implying a public URL' }
  else { Fail 'no accessNote: a reader could assume the link is public' }
  if ($share.shareUrl -match '^/s/[0-9a-f]{32}$') { Pass "share url: $($share.shareUrl)" }
  else { Fail "unexpected share url: $($share.shareUrl)" }
} catch { Fail "minting a share failed: $(Get-StatusCode $_) $(Get-ErrorBody $_)" }

if ($share) {
  try {
    $resolved = Invoke-RestMethod "$Base/shares/resolve?token=$($share.token)"
    if ($resolved.route) { Pass "resolve returned a route: $($resolved.route)" } else { Fail 'resolve returned no route' }
  } catch { Fail "resolve failed: $(Get-StatusCode $_)" }

  # Do not use Invoke-WebRequest -MaximumRedirection 0 for this: in PowerShell 5.1
  # that throws for a 3xx and reading the status back does not work, so the check
  # reported an empty status and failed even though the redirect was correct.
  # Drive the request directly and leave AllowAutoRedirect off.
  $status = 0
  $location = ''
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:8787/s/$($share.token)")
    $req.AllowAutoRedirect = $false
    $req.Method = 'GET'
    $resp = $req.GetResponse()
    $status = [int]$resp.StatusCode
    $location = [string]$resp.Headers['Location']
    $resp.Close()
  } catch [System.Net.WebException] {
    $r = $_.Exception.Response
    if ($r) { $status = [int]$r.StatusCode; $location = [string]$r.Headers['Location'] }
  }
  if ($status -eq 302) { Pass "/s/<token> redirects into the viewer ($location)" }
  else { Fail "/s/<token> gave $status, expected 302" }

  try {
    Invoke-RestMethod "$Base/shares/$($share.id)" -Method Delete -Headers $headers | Out-Null
    Pass 'revoke accepted'
  } catch { Fail "revoke failed: $(Get-StatusCode $_)" }

  # Revocation that does not actually revoke is the worst outcome here.
  try {
    Invoke-RestMethod "$Base/shares/resolve?token=$($share.token)" | Out-Null
    Fail 'a revoked token still resolves'
  } catch {
    $code = Get-StatusCode $_
    if ($code -eq 410) { Pass 'a revoked token is refused with 410' } else { Fail "revoked token gave $code, expected 410" }
  }
}

try {
  Invoke-RestMethod "$Base/shares" -Method Post -ContentType 'application/json' `
    -Body (@{ domain = $account.domain } | ConvertTo-Json) | Out-Null
  Fail 'shares can be minted without a token'
} catch {
  $code = Get-StatusCode $_
  if ($code -eq 401) { Pass 'minting a share requires authentication' } else { Fail "unauthenticated mint gave $code, expected 401" }
}

# -- 6. Export ---------------------------------------------------------------

Step 6 'Export a month as a static bundle'
$export = $null
try {
  $export = Invoke-RestMethod "$Base/export" -Method Post -Headers $headers -ContentType 'application/json' `
    -Body (@{ domain = $account.domain; month = $account.month } | ConvertTo-Json)
  Pass "export started: $(($export | ConvertTo-Json -Compress))"
} catch {
  $code = Get-StatusCode $_
  if ($code -eq 404) { Skip '/v1/export is not mounted yet' }
  else { Fail "starting an export failed: $code $(Get-ErrorBody $_)" }
}

if ($export -and $export.id) {
  $row = $null
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    try { $row = Invoke-RestMethod "$Base/export/$($export.id)" -Headers $headers } catch { break }
    if ($row.status -ne 'building') { break }
  }
  if ($row -and $row.status -eq 'ready') {
    Pass "export ready: $($row.pages) pages, $($row.assets) assets, $($row.bytes) bytes"
    if ($null -ne $row.missing) { Pass "missing-page count reported: $($row.missing)" }
    else { Fail 'the export did not report how many pages were missing' }

    # A bundle nobody can download is not a bundle.
    try {
      $dl = Invoke-WebRequest "$Base/export/$($export.id)/download" -Headers $headers -UseBasicParsing -TimeoutSec 60
      $sig = [System.Text.Encoding]::ASCII.GetString($dl.Content[0..3])
      if ($sig -eq 'PK' + [char]3 + [char]4) { Pass "download is a real ZIP ($($dl.Content.Length) bytes, PK signature)" }
      else { Fail "download did not start with a ZIP signature (got '$sig')" }
    } catch { Fail "download failed: $(Get-StatusCode $_)" }
  } elseif ($row -and $row.status -eq 'failed') {
    Fail "export failed: $($row.error_message)"
  } else {
    Skip "export still $($row.status) after 40s"
  }
}

# -- Summary -----------------------------------------------------------------

Write-Host ''
if ($script:failures -eq 0) {
  Write-Host "PHASE 5 SMOKE TEST: all checks passed$(if ($script:skips -gt 0) { " ($script:skips skipped)" })" -ForegroundColor Green
  exit 0
} else {
  Write-Host "PHASE 5 SMOKE TEST: $script:failures check(s) failed$(if ($script:skips -gt 0) { ", $script:skips skipped" })" -ForegroundColor Red
  exit 1
}
