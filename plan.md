# custom-wayback — Plan

**A personal, fast, mobile-first alternative to the Wayback Machine browser.**

Goal: pick a site + a month → wait a few seconds once → then browse that month's version of the
site as if it were live. Nothing slower than normal Chrome. Modern UI. Works on
**Galaxy A36 5G (Chrome/Android)** and **iPhone 18 Pro (Safari + Chrome/iOS)**.

- Status: plan / pre-build
- Working directory: `C:\Users\FingerWeg\Documents\custom-wayback`
- Inputs reviewed: [random-thoughts.txt](random-thoughts.txt), [env.txt](env.txt)
- Research date: October 2026 (all prices verified against vendor pricing pages, cited inline)

---

## 0. Handling of the input files (read this first)

`env.txt` contains **live-looking production credentials in plaintext** in an ordinary working
directory: a GitHub personal access token, two Cloudflare API tokens, an R2/S3 access key pair,
a webhook signing secret, an account ID, and an R2 bucket name.

**I have not printed, echoed, quoted, or transmitted any of those values anywhere in this
session, and this plan never will.** They are referred to below by variable *name* only.

What the file is used for in this plan: it tells us the target account already has
**Cloudflare R2 + Workers** provisioned and a KV namespace reserved for the link ledger, so
Phase 0 costs nothing new and the stack choice below matches infrastructure you already own.

> **Action required before any code is written — rotate everything in `env.txt`.**
> A credential that has lived in a plaintext file on disk should be treated as compromised.
> Order: revoke the GitHub PAT → rotate both Cloudflare API tokens → rotate the R2 access key
> pair → regenerate the webhook secret. Then store the replacements only in `.dev.vars`
> (git-ignored), `wrangler secret put`, and/or a real secret manager. Add `.gitignore` entries
> for `env.txt`, `.env`, `.dev.vars`, and `*.local` **before** `git init`, so no secret can
> reach a remote. If that GitHub PAT was ever pushed anywhere, check the account's secret
> scanning alerts and audit log. See §13.

---

## 1. The problem, stated precisely

You were on `samsung.com` and `apple.com` in the Wayback Machine for business research and
marketing analysis. What you actually experienced:

| What hurt | Root cause |
|---|---|
| Long wait before a page appeared | Every page view is rendered **on demand** from a cold index lookup over 1T+ captures |
| Assets (CSS/JS/images/fonts) crawled in slowly | Every asset is a **separate** on-demand fetch through `web.archive.org/web/…`, each with its own latency and rewrite pass |
| Navigation between pages felt sluggish | No warm cache, no prefetch, no connection reuse; the toolbar and injected JS add weight |
| The calendar is old and awkward | Legacy UI, snapshot-per-day granularity exposed as a dense wall of captures |
| Multiple snapshots per day are useless noise | The UI surfaces them because it must serve everyone; you need **one clean snapshot per day** |
| "1 trillion web pages" is the wrong scope | The tool optimizes for universal coverage; you need **2 domains, one month, fast** |

**The insight that makes this buildable and cheap:** the expensive part of the Wayback experience
is *serving every request cold*. If a single snapshot per URL is fetched once, normalized once,
and then served from an edge cache forever, the experience is bounded by CDN latency — not by
archive.org. That is the entire product.

**Non-goal:** this is not a new archive, and it is not a bulk mirror of the Internet Archive.
It is a **personal cache and reader** in front of the public Wayback APIs, scoped to domains and
months you care about. See §12 for the etiquette and legal rules that fall out of that.

---

## 2. What a user sees (the product)

### 2.1 The flow

1. **Add a site.** Paste `samsung.com` or `https://www.apple.com/marketing`. The app normalizes
   it to a registrable domain + host set and shows a small "coverage bar" — for each year since
   1996, how many days that domain actually has captures. Roughly one cheap CDX query; cached
   forever per domain.
2. **Pick year + month.** A modern date-grid month picker (not a wall of timestamps). Days with
   no capture are dimmed. Tapping a day shows *the* snapshot for that day — one per day, chosen
   by a "best capture" policy (§6.2), not the raw pile.
3. **Watch the pre-load happen (a few seconds).** A live progress panel: `CDX index ✓ → 412 pages
   discovered → fetching 318/412 → rewriting assets → 2,847 assets cached → ready`. It is
   honest, cancellable, and it reports the crawl budget it is respecting.
4. **Browse instantly.** The site opens inside the app shell, rendered from our edge cache. A
   floating toolbar gives: day scrubber (◀ Oct 3 ▶), month jump, "open in Wayback", "copy link",
   "page not captured in this month → nearest capture" and a per-page load indicator.
5. **Revisit later, from the phone, instantly.** Second visit to the same domain+month is a
   cache hit: shell paints immediately, pages stream from edge cache.

### 2.2 What "fast" means, in numbers

| Metric | Target | How it is achieved |
|---|---|---|
| App shell (cold, mobile) | < 1.0 s LCP on 4G | Static shell on Workers Static Assets, ~60 KB gzipped JS, no blocking fonts |
| Archive page → first pixel (warm) | < 150 ms | R2 + Workers Cache hit at the edge nearest the device; zero archive.org involvement |
| Archive page → first pixel (cold, single page) | < 2.5 s | Streaming HTML from edge while the page's own assets come from cache; `id_` raw fetch only for the HTML |
| Snapshot selection after "pre-load" | 0 ms, no spinner | Calendar and ledger are precomputed during pre-load; the UI never queries archive.org interactively |
| Click → next page | < 100 ms perceived | Service worker pre-warms the ≤ 8 most likely links from the current page |
| Repeat visit after 7+ days | still instant | The edge cache — not the phone — is the source of truth (§9) |

### 2.3 The modern UI

Single design language across both phones and desktop:

- **Layout**: mobile-first. Sticky translucent top bar (`backdrop-blur`), bottom sheet for the
  day/month picker (thumb-reachable), safe-area insets respected (`env(safe-area-inset-*)`).
- **Calendar**: shadcn/ui `Calendar` in `mode="single"` with a **month/year dropdown** — modern,
  not a 1990s grid. Density dots per day (capture count bucket, not a raw number).
- **Feel**: 150–200 ms transitions, spring easing, skeleton loaders shaped like the content,
  optimistic navigation (the URL bar and toolbar update *before* the iframe commits),
  `touch-action: manipulation` to kill the 300 ms tap delay, `-webkit-overflow-scrolling: touch`.
- **State**: URL-driven (`/samsung.com/2024/03/15/`). Every view is shareable and
  back-button-correct, including inside the archive iframe (history `pushState` bridge).
- **Type & color**: one variable font, neutral surface scale, one accent; dark mode by default
  with `prefers-color-scheme` support. No gradients-for-the-sake-of-gradients, no drop shadows
  heavier than 2 layers.
- **Shell weight budget**: ≤ 60 KB gzipped JS for the shell route. The archive viewer is a
  lazy route so the picker stays tiny.
- **Errors are designed**: "This page wasn't captured between Mar 1–31, 2024. Nearest: Feb 27
  (2 days earlier) / Apr 2." One tap to jump. Never a dead end, never a raw 404 wall.

---

## 3. Architecture

Two planes: a **slow plane** that touches archive.org once per (domain, month), and a **fast
plane** that never touches archive.org at all. The product lives entirely in the fast plane.

```
                         SLOW PLANE (once per domain+month, seconds→minutes)
  ┌──────────────┐
  │  Phone / PC  │  POST /v1/jobs  { domain, month, budget }
  └──────┬───────┘
         ▼
  ┌──────────────────────┐     ┌───────────────────────────────┐
  │  API Worker (Hono)   │────▶│  Queue (Cloudflare Queues)     │
  │  auth, quota, jobs   │     └──────────────┬────────────────┘
  └──────────┬───────────┘                    ▼
             │                    ┌───────────────────────────────┐
             │                    │  Crawler (Container / VPS /   │
             │                    │  local Node runner)           │
             │                    │  · CDX survey + day bucketing │
             │                    │  · politeness gate (1 rps/host)│
             │                    │  · id_ raw fetch, HTML + assets│
             │                    │  · rewrite, sanitize, optimize │
             │                    └───────┬───────────────┬───────┘
             │                            ▼               ▼
             │                  ┌──────────────┐  ┌──────────────┐
             │                  │  R2 bucket   │  │  D1 ledger   │
             │                  │  (content-   │  │  snapshots,  │
             │                  │  addressed)  │  │  link map    │
             │                  └──────┬───────┘  └──────┬───────┘
             ▼                         │                 │
                         FAST PLANE    ▼                 ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │  Viewer Worker:  /a/:domain/:ts/*                                 │
  │   1. Workers Cache API lookup  ──hit──▶ stream, 0 archive.org I/O │
  │   2. miss → R2 get (Class B)   ──hit──▶ cache-aside, stream       │
  │   3. miss → HTMLRewriter on stream: base href, CSP, shims,        │
  │              image optimize, SW-friendly headers                  │
  │   4. cold + un-crawled → single on-demand id_ fetch (budgeted)    │
  └───────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │  Client shell (React PWA): picker, day scrubber, iframe sandbox,  │
  │  service worker (shell cache + prefetch of likely next links)     │
  └───────────────────────────────────────────────────────────────────┘
```

### 3.1 Why this shape

- **Nothing is rewritten at read time.** HTML is rewritten exactly once, during ingest, and the
  result is stored. Reads are byte serving. This is the single biggest reason the tool will feel
  fast, and it also means we are *kind* to archive.org.
- **Content-addressed storage.** Assets are stored under `sha256(content)` keys. On a corporate
  site, the logo/CSS/fonts are byte-identical across hundreds of pages and many months, so the
  second and subsequent snapshots of the same domain cost almost nothing to store. This is what
  turns "10 years of a big domain" from an expensive idea into a cheap one.
- **The edge cache is the source of truth.** iPhone Safari deletes script-writable storage after
  7 days of inactivity and caps it hard (§9). So we must never depend on the phone holding the
  archive. The phone caches only the shell plus a few likely next pages; everything else is a CDN
  hit.
- **A separate crawler process.** Crawling is bursty, CPU-idle, I/O-heavy, and needs a place to
  keep ~1 request/second per host with backoff. Workers are the wrong shape for that; a
  container or tiny VPS is the right shape, and can also simply be **your own PC** (§7, Option C).

---

## 4. Tech stack, and why

The bias throughout: **minimum number of moving parts, zero egress fees, scale-to-zero, and no
service you cannot pay for with the infrastructure you already own.**

| Layer | Choice | Why this, and not the alternative |
|---|---|---|
| **Client shell** | React 19 + TypeScript + Vite + Tailwind CSS v4 + shadcn/ui + TanStack Query, as a **PWA** | Vite gives the smallest, fastest mobile shell (an SSR framework buys nothing here — the app is behind auth and mostly client-stateful). shadcn/ui gives owned, accessible primitives (sheet, calendar, popover) with no runtime lock-in, and Tailwind v4 makes the "modern, fast" look a token change rather than a CSS refactor. One codebase serves both target phones. |
| **API + viewer** | **Cloudflare Workers** (TypeScript, Hono router) | You already own this account. No cold starts to speak of, global anycast, and **requests to static assets are free and unlimited** — which is exactly the traffic profile of a cached-archive reader. Hono is ~14 KB, edge-native, and keeps the Worker under its CPU budget. Alternative (Next.js on Vercel) costs $20/seat/mo *plus* metered fast data transfer, and its serverless model is worse for streaming large cached assets. |
| **HTML rewriting** | **`HTMLRewriter`** (built into Workers) at ingest + at render time; `lol-html` if we later need max throughput | It is a streaming rewriter: constant memory, no DOM parse of a 2 MB page, and it is already in the runtime. Cheerio is the fallback for the crawler (where a DOM is genuinely convenient) but it is parse-everything and will blow Worker CPU limits on big pages. |
| **Crawler** | Node 22 + TypeScript, `undici` (HTTP/2, connection pooling), `p-limit` for concurrency, `HTMLRewriter`/Cheerio for asset discovery | Runs identically as a Cloudflare Container, a Fly.io machine, a Hetzner VPS, or `node crawler.js` on your own PC. The politeness gate and CDX survey logic are the same code in all four. |
| **Job orchestration** | **Cloudflare Queues** | 1M operations/month included on the paid plan, 3 ops per message, then $0.40/M. Replaces the entire BullMQ + Redis tier from the original blueprint with one binding and no server. Adds retries, DLQ, and 4–14 day retention for free. |
| **Metadata / link ledger** | **D1** (SQLite) for the authoritative ledger; **Durable Objects (SQLite backend)** only if we need per-domain serialization (e.g. one crawl per domain at a time) | D1's paid tier includes 25 billion rows read and 50 million rows written per month — this workload will not come close. A ledger row is ~200 bytes; 5M rows is ~1 GB, i.e. $0.75/GB-mo. This deletes Redis from the critical path entirely. **No Redis, no Upstash, no BullMQ in v1** — one less service, one less bill, one less outage mode. Keep the existing KV namespace for coarse caches (calendar summaries, coverage bars) because KV reads are cheap and globally replicated. |
| **Blob storage** | **R2** (the bucket already provisioned), content-addressed keys | **$0.015/GB-month and free egress** — egress is the entire reason not to use S3/Backblaze-for-delivery. Free tier: 10 GB-month storage, 1M Class A, 10M Class B per month, which likely covers v1 outright. |
| **Read-through cache** | **Workers Cache API** with tiered cache, `Cache-Control: immutable` on hashed assets | A hit is served without touching R2, so we pay neither Class B ops nor storage-read latency. Hashed assets are immutable by construction → `max-age=31536000, immutable` is safe and gives near-100% hit rates. |
| **Auth** | Cloudflare Access (email OTP) in front of the app for v1 | Zero code, zero user table, zero password reset flow — correct for a personal tool. Swap to passkeys/WebAuthn later if it becomes multi-user. |
| **CI/CD** | GitHub Actions + `wrangler deploy`; `drizzle-kit` migrations for D1 | You already have a GitHub token provisioned. Preview deploys per PR, `main` → production. |
| **Local dev** | `wrangler dev` (Miniflare) + `docker compose` for the crawler + MinIO as an R2 stand-in | Full stack runs offline on your PC; nothing touches archive.org during UI work. |
| **Observability** | Workers Logs + Analytics Engine; a `/v1/health` endpoint asserting R2/D1/Queue reachability; cost counters per domain-month | We need to *see* the crawl budget and the 429 rate, because archive.org throttling is the main external risk (§11). |

### 4.1 Explicitly rejected

| Rejected | Reason |
|---|---|
| Next.js on Vercel | $20/seat/mo floor plus metered fast data transfer; a mostly-cached read path is exactly what Workers + R2 does cheaper, and you already own Cloudflare. |
| Redis + BullMQ (from the original blueprint) | An entire always-on service to duplicate what Queues + D1 already do. Adds a bill and a failure mode for no latency benefit at this scale. Revisit only if the local runner needs a distributed queue across many machines. |
| Crawling `web.archive.org/web/<ts>/…` rewritten pages | Rewritten pages arrive with the Wayback toolbar and injected JS, and push rewrite cost onto archive.org's servers. Use `id_` raw mode instead (§6.1). |
| Full-domain deep crawl as the default | A news site or marketplace can have 50k+ URLs in one month. Unbounded crawl = the "few seconds" promise becomes minutes and the bill becomes unpredictable. Budgeted, depth-limited, resumable ingestion is the default (§6.3). |
| Storing the archive on the phone | iPhone Safari's script-writable storage is capped (~50 MB in the conservative case, higher/unspecified by origin quota in modern WebKit) and **evicted after 7 days of non-use**. Unusable as a source of truth (§9). |
| `localStorage` / IndexedDB for the ledger | Same 7-day eviction, plus no cross-device sync. The ledger belongs on the server. |
| Client-side-only tool (browser extension) | Cannot do shared, cross-device caching, and cannot be fast on a cold phone. The community extension (project #6 in your notes) is a fine *inspiration* for the CDX+Availability dual-API trick, but a server-side cache is what actually removes the wait. |

---

## 5. The one design decision that makes it fast

Everything else is detail; this is the product:

> **Ingest once per (URL × chosen-day), rewrite once, store bytes, and serve bytes forever.**

Concretely, for a chosen domain + month:

1. One paginated CDX survey (`collapse=timestamp:8` → one capture per day per URL, `filter=statuscode:200`,
   `output=json`, `fl=timestamp,original,mimetype,statuscode,digest,length`) — see §6.1 for exact params.
2. Bucket captures into **days**. Pick the day's best capture per URL (usually the latest 200 with
   the largest length, or the one whose digest matches the most-linked version).
3. Fetch **raw** bytes via the `id_` modifier (original file, no toolbar, no injected JS, no
   server-side rewrite). Cheapest possible request for archive.org, cleanest possible input for us.
4. Rewrite **once**: absolute asset URLs → our cache paths; internal links → our router; strip or
   stub dead third-party scripts; inject the bridge script and CSP.
5. Store **content-addressed** bytes in R2; store the URL→hash and link-resolution map in D1.
6. Warm the Workers cache for the pages in the first-navigation set.

After step 6, browsing that month is pure CDN. The "couple of seconds" you asked for is the
pre-load; everything after it is a cache hit.

---

## 6. Ingest engine detail

### 6.1 Talking to the Wayback APIs correctly

Three official surfaces, used for three different jobs:

| API | Used for | Notes |
|---|---|---|
| **CDX Server** `web.archive.org/cdx/search/cdx` | The domain+month survey, and any prefix/host enumeration | Supports `matchType=domain\|host\|prefix\|exact`, `from`/`to`, `filter=!statuscode:200`, **`collapse=timestamp:8`** (one row per day), `collapse=digest`, `fl=` field selection, `output=json`, `limit`, and cursor-style `showResumeKey=true` / `resumeKey=` for safe pagination. Max ~150,000 rows per query by default — paginate. `showNumPages=true` lets us show an honest progress bar. |
| **Availability JSON** `archive.org/wayback/available?url=&timestamp=` | Cheap single-page existence/closest-match checks for the UI ("does Oct 3 exist? what's nearest?") | Fast, no index scan, perfect for hover/tap previews and for the 404/"no capture" experience. |
| **Raw replay** `web.archive.org/web/<TS>id_/<original-url>` | The actual byte fetch of a page or asset | `id_` returns the **original, un-rewritten** capture: no Wayback toolbar, no injected JS, no on-the-fly link rewriting. This is both faster and more correct for us than replaying the rewritten page, and it is cheaper for the Internet Archive. |

CDX request, concretely (this is the whole "pre-load" trigger):

```
GET https://web.archive.org/cdx/search/cdx
  ?url=samsung.com
  &matchType=domain
  &from=20240301&to=20240331
  &filter=statuscode:200
  &filter=mimetype:text/html
  &collapse=timestamp:8          # ← one capture per day per URL: the "single snapshot a day" you wanted
  &fl=timestamp,original,mimetype,statuscode,digest,length
  &output=json
  &limit=5000
  &showResumeKey=true
```

Two more CDX passes per month: one for non-HTML assets under the same host set, and one for
`matchType=prefix` on the paths discovered in pass one, to catch assets living on a different
host (CDNs, `images.samsung.com`, etc.). All three are cached permanently per (domain, month) —
the survey is immutable history, so it is fetched exactly once, ever.

### 6.2 Choosing "the one snapshot for the day"

Per URL, within the chosen day:

1. Prefer `statuscode=200`.
2. Prefer the largest `length` (truncated captures are short).
3. Prefer the latest timestamp that is not a `warc/revisit` duplicate of a *different* payload —
   `digest` tells us this, and `collapse=digest` (adjacent) plus `showDupeCount=true` helps.
4. Tie-break deterministically on timestamp so results are reproducible across re-runs.

Attach a confidence label per page in the UI (`captured 2024-03-15 09:12 · 3 captures this day`).
Honest metadata is a feature, not clutter.

### 6.3 Budgets: the promise is "seconds", so bound the work

Config-driven caps, surfaced in the UI *before* the crawl starts:

| Budget | Default | Rationale |
|---|---|---|
| `MAX_PAGES_PER_MONTH` | 250 | Keeps a pre-load in the seconds-to-low-minutes range; comfortably covers a corporate marketing site's key paths. |
| `MAX_DEPTH` | 3 | Homepage + section + product/article. |
| `MAX_ASSETS_PER_PAGE` | 120 | Beyond this you are pulling trackers and ad iframes nobody wants. |
| `MAX_BYTES_PER_MONTH` | 750 MB (pre-optimization) | Hard stop that prevents a runaway bill. |
| `CONCURRENCY` | 6 globally, **1/second/host** to archive.org | Politeness (§12) and 429 avoidance. |
| `NAV_SET` (deep-fetch priority) | top 40 in-site links by (nav position, in-link count) | These are the pages a user actually clicks in the first minute, so they get cached first. |

Anything outside the budget is not an error — it is **on-demand**: the first time you click an
un-crawled page, the viewer worker fetches that one page via `id_`, rewrites and caches it, then
serves it. Cost: one extra ~1.5 s on a page you may never open, instead of minutes of crawling
pages you never open. This is the single most important cost-control idea in the plan.

### 6.4 Normalization pipeline (runs once, at ingest)

| Step | What | Why |
|---|---|---|
| De-toolbar | Nothing to strip — `id_` gives raw bytes | We never inherit archive.org's injected UI or JS |
| De-base | Remove/normalize `<base>`; inject `<base href="/a/:domain/:ts/">` | All relative URLs resolve against *our* router, not the original host |
| Asset rewrite | `src`/`href`/`srcset`/`url()` in CSS → `/a/:domain/:ts/…` content-addressed paths | One origin for the whole snapshot; enables HTTP/2/3 reuse and caching |
| Link remap | Internal links → `/a/:domain/:ts/<path>` | Keeps navigation inside the snapshot's month |
| Temporal resolution | If the target page has no capture in the chosen month, walk outward (±1 day, ±7, ±30) and record the resolved URL | This is what kills the "broken link" experience. Store the resolution in the D1 ledger so the UI can show "→ Mar 27" |
| Script triage | Classify each third-party script: **keep** (jQuery, framework libs, same-origin app code) / **stub** (analytics, ads, tag managers, dead CDNs) / **strip** (known-broken Flash/legacy) | Prevents dead endpoints from hanging the page for 30 s and spraying console errors |
| Shim injection | `window.dataLayer`, `ga`, `gtag`, `fbq`, `_gaq` → no-op stubs; `IntersectionObserver`/`fetch` polyfill only when the page's own code needs it | Old pages break on missing globals far more often than on missing APIs |
| Error shield | `window.onerror`, `unhandledrejection`, XHR/fetch failure interceptor → swallow, report to our toolbar badge counter | The page looks intact even when a dead API call fails behind it |
| CSP | Strict `Content-Security-Policy` on served snapshots allowing our origin + `data:`/`blob:` only | Archived pages are untrusted input; a sandbox alone is not a content policy |
| Image optimize | On-the-fly `cf.image` resize/format conversion for raster assets, respecting a max width per device class | Big win on mobile: 2–4× smaller transfers on the exact image-heavy sites you named |

### 6.5 Asset-graph follow-up

While rewriting, collect every same-snapshot asset reference and enqueue it. Assets referenced
from *multiple* pages are de-duplicated by content hash, so a 400-page crawl of a corporate site
typically pulls a few hundred unique images and a handful of CSS/JS bundles — not 20,000
requests. Follow-up depth for assets is 1 (CSS `@import`/`url()` and font references only).

---

## 7. Where the crawler runs — three costed options

The crawler is a stateless Node process, so this is a deployment choice, not a rewrite.

| Option | Setup | Cost | Best when |
|---|---|---|---|
| **A. Cloudflare Containers** | `wrangler` container binding, `sleepAfter` for scale-to-zero | Included in the $5/mo Workers Paid plan: 25 GiB-hours + 375 vCPU-minutes/month, then $0.0000025/GiB-s and $0.00002/vCPU-s | You want one deploy target and no servers |
| **B. Tiny VPS** (Hetzner CX22-class / Fly.io `shared-cpu-1x·512MB @ $4.39/mo`) | Docker image, cron/queue consumer | Hetzner: single-digit €/mo with ~20 TB egress included; Fly.io: $4.39/mo compute + $0.15/GB-mo volume | You crawl a lot and want flat, predictable cost |
| **C. Your own PC** (`node apps/crawler`) | `pnpm crawl --domain=samsung.com --month=2024-03` | $0 (electricity) | **Best starting point.** Personal tool, bursty work, and your PC is already the machine you research on |

**Recommendation: start with C, plan for A.** The local runner validates the CDX/`id_`/rewrite
pipeline against real archive.org responses before any cloud money is spent, and it works
offline-ish and instantly for iteration. Because the crawler only writes to R2 + D1 (both already
provisioned) via the S3 API and D1's HTTP API, the same binary then runs unchanged as a Container.

---

## 8. Data model

```sql
-- 1. One row per (domain, month) ingest
CREATE TABLE ingest (
  id            TEXT PRIMARY KEY,          -- ulid
  domain        TEXT NOT NULL,
  month         TEXT NOT NULL,             -- 'YYYY-MM'
  status        TEXT NOT NULL,             -- queued|surveying|fetching|rewriting|ready|partial|failed
  pages_total   INTEGER DEFAULT 0,
  pages_done    INTEGER DEFAULT 0,
  assets_total  INTEGER DEFAULT 0,
  assets_done   INTEGER DEFAULT 0,
  bytes_stored  INTEGER DEFAULT 0,
  budget_json   TEXT,                      -- the caps in force, echoed in the UI
  ia_429_count  INTEGER DEFAULT 0,
  error         TEXT,
  started_at    INTEGER, finished_at INTEGER
);
CREATE UNIQUE INDEX ingest_domain_month ON ingest(domain, month);

-- 2. One row per original URL per day-snapshot  (the "one snapshot a day" ledger)
CREATE TABLE snapshot (
  domain     TEXT NOT NULL,
  url        TEXT NOT NULL,                -- original absolute URL
  day        TEXT NOT NULL,                -- 'YYYY-MM-DD'
  ts         TEXT NOT NULL,                -- 14-digit chosen capture
  status     INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  digest     TEXT,
  bytes      INTEGER,
  r2_key     TEXT,                         -- rewritten HTML blob
  page_id    TEXT,                         -- route id used by the viewer
  PRIMARY KEY (domain, url, day)
);
CREATE INDEX snapshot_day ON snapshot(domain, day);

-- 3. Link resolution ledger (what makes navigation feel unbroken)
CREATE TABLE link_resolution (
  domain   TEXT NOT NULL,
  day      TEXT NOT NULL,
  from_url TEXT NOT NULL,
  to_url   TEXT NOT NULL,
  resolved_day TEXT,                       -- same day, or nearest
  resolved_ts  TEXT,
  delta_days   INTEGER,                    -- signed; drives the "→ Mar 27" badge
  kind         TEXT,                       -- internal|external|cross-host
  PRIMARY KEY (domain, day, from_url, to_url)
);

-- 4. Asset registry (content-addressed → shared across pages, months, snapshots)
CREATE TABLE asset (
  hash       TEXT PRIMARY KEY,             -- sha256 of bytes
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  r2_key     TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  ref_count  INTEGER DEFAULT 1
);

-- 5. Immutable CDX survey cache (history never changes)
CREATE TABLE cdx_survey (
  domain     TEXT NOT NULL,
  month      TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  payload    BLOB NOT NULL,                -- gzipped JSON
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (domain, month, query_hash)
);

-- 6. Usage ledger (per-domain-month cost attribution, feeds the guardrails)
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT, month TEXT, kind TEXT,      -- ia_fetch|r2_put|r2_get|bytes|worker_cpu_ms
  value  INTEGER, at INTEGER
);
```

R2 layout (content-addressed, immutable keys):

```
r2://<bucket>/
  pages/<domain>/<day>/<url-hash>.html          # rewritten HTML (varies by day → not content-addressed)
  assets/<hash[0:2]>/<hash>                     # bytes, deduped globally, immutable
  meta/<domain>/<month>/manifest.json.gz        # page list, day map, resolutions, budgets
  raw/<domain>/<day>/<url-hash>.orig            # optional: verbatim original, for re-rewrite without re-fetch
```

Keeping `raw/` is a deliberate cheapness decision: a re-rewrite (new shim, new CSP, better
optimizer) costs zero archive.org requests. Storage is $0.015/GB-mo, so re-fetch-avoidance is
almost free insurance. Enable an R2 lifecycle rule to drop `raw/` after 90 days if it ever grows.

---

## 9. Mobile support: Galaxy A36 5G and iPhone 18 Pro

### 9.1 What each device actually runs

| | Galaxy A36 5G | iPhone 18 Pro |
|---|---|---|
| OS | Android 15/16 (One UI) | iOS 26 |
| Chrome | **Chrome for Android** (Blink) — full API surface | **Chrome for iOS** — *WebKit*, not Blink |
| Safari | n/a | **Safari** (WebKit) |
| Install | PWA install prompt, real standalone app | Manual "Add to Home Screen"; standalone outside the EU |
| Storage | Origin quota in the hundreds of MB+, persistent storage grantable | Script-writable storage capped (~50 MB conservative budget) and **evicted after 7 days of inactivity** |
| Background work | Service worker + Background Sync + Background Fetch | Service worker yes; **no** Background Sync / Periodic Sync / Background Fetch |
| Viewport | ~6.7", 1080×2340, 120 Hz | ~6.3", high-DPI, Dynamic Island + safe areas |

**The decisive consequence:** because Chrome on iOS is WebKit underneath, *all three of your
target combinations are the same web platform with two engine variants.* There is no separate
iOS build, no native app, and no way to dodge WebKit — so the plan assumes WebKit is the
constraint and designs for the **worst** case (iPhone Safari), which automatically satisfies
Chrome/Android.

### 9.2 Design rules that follow

1. **Never rely on device storage for correctness.** The archive lives at the edge. The service
   worker caches only the app shell (few hundred KB) plus a small LRU of visited snapshot pages,
   budgeted at **≤ 25 MB** so it survives iOS's cap and is cheap to rebuild after a 7-day eviction.
2. **Assume the cache is empty on every launch.** On boot the SW re-validates the shell and
   warms only the *most likely next* links (`<link rel=prefetch>` on the 4–8 top in-site links of
   the current page). No bulk background download — iOS will not do it anyway.
3. **No Background Sync dependency.** Writes (e.g. "add to research notes", crawl requests) go
   straight to the API with optimistic UI and an IndexedDB outbox retried on `online` /
   `visibilitychange`.
4. **Request persistent storage when available** (`navigator.storage.persist()`), use
   `navigator.storage.estimate()` to show real "cached on this device" numbers, and degrade
   silently when unsupported.
5. **Touch & viewport correctness:** `viewport-fit=cover`, safe-area insets on every fixed
   element, `-webkit-fill-available` alongside `100dvh`, `touch-action: manipulation`, ≥ 44×44 px
   targets, and a bottom sheet for the calendar so the picker is reachable one-handed.
6. **Data discipline:** default to `cf.image` AVIF/WebP with device-appropriate `srcset`; cap
   in-iframe image width at the device class; lazy-load iframe content frames below the fold.
7. **iOS-specific fixes:** force SW update checks on launch (Safari caches SWs aggressively),
   avoid `100vh` layout jumps, treat autoplay as blocked, and verify copy/select behaviour inside
   the sandboxed iframe.
8. **EU caveat:** on iOS 17.4+ in the EU, home-screen web apps may open in a Safari tab with no
   standalone/push. The design must be fully usable as a plain browser tab — which the shell-first
   architecture already guarantees.

### 9.3 Real-device test gate (blocking for "done")

Run on both physical devices over a throttled 4G profile, per release:

- [ ] Cold shell LCP < 1.0 s; warm archive page < 150 ms; no layout shift on load
- [ ] Deep link straight to `/samsung.com/2024/03/15/` works cold on both engines
- [ ] In-iframe navigation (10+ sequential link taps) with no scroll position errors, no history
      desync, no stuck back button
- [ ] Day scrubber and month sheet: 60 fps minimum on the A36, no jank on the iPhone
- [ ] Prefetch produces a visibly instant next-page tap; verify SW cache size stays ≤ 25 MB
- [ ] After a simulated 7-day storage eviction, the app still works and is still fast
- [ ] Offline: shell loads, cached pages open, uncached pages show a designed "needs network" state
- [ ] Add-to-Home-Screen on both; standalone launch; correct status bar/safe-area rendering
- [ ] Rotate portrait↔landscape mid-navigation without losing iframe state
- [ ] Safari-only checks: copy/paste out of the iframe, `backdrop-filter` fallback, momentum scroll

---

## 10. Rendering archived pages safely

Archived pages are untrusted code from another era. Containment is non-negotiable:

- **Iframe sandbox:** `sandbox="allow-scripts allow-forms allow-popups"` — deliberately **no**
  `allow-same-origin`, so snapshot code cannot reach our origin's storage, cookies, or APIs.
  (If a specific site needs `allow-same-origin`, it is served from a **separate origin**
  (`snap-<hash>.example.net`), never the app origin.)
- **CSP** on the served snapshot: `default-src 'self' 'unsafe-inline' data: blob:`; no
  `frame-ancestors` escape; `form-action` restricted; `base-uri 'self'`.
- **Toolbar bridge** via `postMessage` with an origin + nonce check, for: current URL, "open in
  Wayback", day scrub, error-count badge.
- **No third-party live network.** Any request the archived page makes that we did not rewrite is
  blocked by CSP, so a 2014 analytics beacon cannot leak the user's IP to a dead domain — and
  cannot make the page hang for 30 s.
- **Iframe URL sync:** `history.pushState` bridge so the phone's back gesture walks snapshot
  history, not out of the app.
- **Rate shape:** the viewer streams HTML first, then assets, so the user sees the layout before
  images finish — perceived speed even on a cold page.

---

## 11. Cost estimates

All figures **USD**, verified October 2026. Sources at the end of this section.

### 11.1 Unit prices used

| Resource | Price | Free allowance |
|---|---|---|
| Workers Paid plan | **$5/month minimum** | includes Workers + KV + D1 + DO + Queues + Containers usage allotments |
| Workers requests | $0.30 per additional million | 10M/month included; **static-asset requests free & unlimited** |
| Workers CPU | $0.02 per additional million CPU-ms | 30M CPU-ms/month included |
| R2 storage (Standard) | **$0.015/GB-month** | 10 GB-month |
| R2 Class A (writes/list) | $4.50/million | 1M/month |
| R2 Class B (reads) | $0.36/million | 10M/month |
| R2 egress | **$0.00** — always free | — |
| D1 rows read | $0.001/million | 25 **billion**/month |
| D1 rows written | $1.00/million | 50 million/month |
| D1 storage | $0.75/GB-month | 5 GB |
| Durable Objects | $0.15/M requests, $12.50/M GB-s | 1M requests, 400k GB-s |
| Queues | $0.40/million operations (≈3 ops/message) | 1M ops/month |
| Containers | $0.0000025/GiB-s, $0.00002/vCPU-s | 25 GiB-h, 375 vCPU-min/month |
| Fly.io `shared-cpu-1x·512MB` | $4.39/month | — |
| Fly.io volume | $0.15/GB-month | — |
| Hetzner Cloud | single-digit €/month, ~20 TB egress included | — |
| Upstash Redis (only if ever needed) | PAYG $0.20/100k commands | 250 MB / 500k commands/month |
| Vercel Pro (rejected baseline) | $20/seat/month + metered fast data transfer | — |

### 11.2 Scenario A — Personal / hobby (you, two domains, this use case)

Assumptions: `samsung.com` + `apple.com`, 12 months each per year, ~400 pages/month/domain,
~60 unique assets/page after dedupe ≈ 24k assets/month/domain, ~2.5 GB stored per domain-month
pre-optimization, ~1,500 page views/month from your phones and laptop.

| Line item | Usage | Cost |
|---|---|---|
| Workers Paid plan | — | $5.00 |
| R2 storage | ~60 GB-month, minus 10 GB free = 50 GB → 50 × $0.015 | $0.75 |
| R2 Class A | ~600k writes/month (inside 1M free) | $0.00 |
| R2 Class B | ~2M reads after edge caching (inside 10M free) | $0.00 |
| D1 | ≪ 25B reads, ≪ 50M writes; < 1 GB storage | $0.00 |
| Queues | ~50k messages × 3 ops ≪ 1M | $0.00 |
| Containers / crawler | either the included 25 GiB-h + 375 vCPU-min, or **$0** running on your PC | $0.00 |
| Cloudflare Access | ≤ 50 users free | $0.00 |
| **Total** | | **≈ $6/month** |

Reality check: on the free Workers plan (100k requests/day, 10 ms CPU/invocation) this specific
scenario is **$0/month** except for R2 storage above 10 GB — the paid plan is bought for
headroom, not necessity. Crawling from your own PC keeps it at **$0–2/month**.

### 11.3 Scenario B — Power user / small team

Assumptions: 20 domains tracked, 3 TB stored, 2M page views/month, ~1M R2 reads/month after
caching, heaviest month = 8 full-domain crawls.

| Line item | Usage | Cost |
|---|---|---|
| Workers Paid plan | — | $5.00 |
| Workers requests | 2M (inside 10M included); static assets free | $0.00 |
| Workers CPU | ~20M CPU-ms (inside 30M included) | $0.00 |
| R2 storage | 3,000 GB × $0.015 | $45.00 |
| R2 Class A | 8 crawls × ~1.3M writes ≈ 10M − 1M free = 9M × $4.50/M | $40.50 |
| R2 Class B | ~60M − 10M free = 50M × $0.36/M | $18.00 |
| D1 + Queues + DO | well inside included | $0.00 |
| Crawler (Hetzner CX22-class, always-on) | — | ~$5.00 |
| **Total** | | **≈ $114/month** (≈ $35–45/month if crawls are batched slowly and Class A writes are halved by incremental ingest) |

### 11.4 Scenario C — 10k users, growth

| Line item | Rough monthly cost |
|---|---|
| R2 storage 10 TB (with hash dedupe holding it near this) | ~$150 |
| R2 Class A 30M writes | ~$130 |
| R2 Class B 300M reads (aggressive edge caching assumed) | ~$104 |
| Workers plan + ~50M dynamic requests + CPU | ~$110 |
| D1 (100M+ rows written, 500 GB) | ~$475 |
| Crawler fleet (4–8 Hetzner boxes) | ~$50 |
| **Total** | **~$1,000/month** |

Two levers dominate at this scale and both are already in the design: **(a)** edge cache hit
ratio — every percentage point is real money on Class B ops; **(b)** R2 Class A writes — halving
crawl frequency or introducing R2 Infrequent Access for `raw/` (already planned) cuts this tier
noticeably.

### 11.5 Cost guardrails (build these, not later — now)

1. **Per-domain-month byte and page caps** in config, echoed in the UI, enforced in the crawler
   with a hard abort (`MAX_BYTES_PER_MONTH`, §6.3).
2. **Cloudflare billing alerts** at $10 / $50 / $200, plus a hard spend cap where the dashboard
   supports it.
3. **R2 lifecycle rules**: `raw/` → Infrequent Access at 30 days (min storage duration is 30 days
   on IA, so no early-delete waste), delete raw at 180 days.
4. **Cache-first reads only**: a viewer request must never be allowed to trigger a crawl. Crawls
   are user-initiated and quota'd (N per day).
5. **`/v1/usage` dashboard** reading the `usage` table: cost per domain, cost per month, and
   archive.org request counts, visible in the app before you start another crawl.
6. **Workers CPU limit** set per-invocation in `wrangler.toml` so a pathological page cannot
   burn the CPU allotment.
7. **No unbounded crawl mode.** `MAX_PAGES_PER_MONTH` is a required field, not a default you can
   blank out.

---

## 12. Etiquette, legality, and the archive.org reality check

**This matters more than any technical choice, because it can break the product overnight.**

The Internet Archive has been hit by waves of high-volume automated traffic and has deployed
protections — including a rewritten 429 "too many requests" page — that also catch legitimate
users. Its director has publicly asked for patience and invited reports of false positives. Any
tool that fans out parallel crawlers against `web.archive.org` is both a bad citizen and
*technically fragile*: your pre-load will fail intermittently, and the failure will look like
your bug.

Rules this design follows:

1. **Cache hard, so you rarely ask.** One CDX survey per (domain, month) ever; one `id_` fetch per
   URL per day-snapshot ever; content-addressed assets shared across pages/months. A second user
   viewing the same domain+month generates **zero** archive.org traffic.
2. **Identify honestly.** A descriptive `User-Agent` with contact info
   (e.g. `CustomWaybackFastBot/1.0 (+contact@yourdomain)`) — never a browser string.
3. **Stay under 1 request/second/host**, serialized per host, with **exponential backoff +
   jitter on 429/503**, a circuit breaker that pauses the domain's ingest after repeated 429s,
   and a visible "archive.org is throttling us — resuming in Ns" state in the UI (never a silent
   hang).
4. **Prefer the cheapest endpoint.** `id_` raw fetch (no rewrite work for IA) over replay of
   rewritten pages; Availability API (single index probe) over CDX scans for one-page lookups.
5. **Don't crawl what you weren't asked for.** No global breadth-first wandering: the frontier is
   the domain+month the user named, depth-limited, budget-limited.
6. **Ask before you scale.** If this ever becomes multi-user with heavy ingest, contact
   `info@archive.org` / `wwm@archive.org` about appropriate access rather than scaling quietly.
   Bulk programmatic access is a conversation, not a config flag.
7. **Keep it personal.** This is a reader/cache for research. It is not a re-publication service:
   don't serve the cached corpus publicly, don't strip attribution, and keep a visible "archived
   from the Internet Archive Wayback Machine" credit plus a link to the original capture. Respect
   `robots.txt` and site terms for any *live* fetching you add later; respect copyright in what
   you store and how you use it — archival research use is very different from redistribution.

If these constraints ever conflict with the product promise, the product promise yields. A tool
that gets your IP blocked, or that degrades the service you depend on, is not a good tool.

---

## 13. Security & secrets lifecycle

Trigger: `env.txt` contains live credentials in plaintext in a working directory. Treat as an
incident.

1. **Rotate now, in this order:** GitHub PAT → Cloudflare API token #1 → Cloudflare API token #2
   → R2 access key pair → webhook signing secret.
2. **Never in the repo.** `.gitignore` first: `env.txt`, `.env*`, `.dev.vars*`, `*.local`,
   `.wrangler/`. Add a pre-commit secret scanner (gitleaks) so this cannot regress.
3. **Store by purpose:** local dev → `.dev.vars` (git-ignored); production → `wrangler secret put`
   / Cloudflare Secrets Store; CI → GitHub Actions encrypted secrets with per-environment scoping.
4. **Least privilege.** The two Cloudflare tokens appear to be full-account API tokens; replace
   with a single scoped token limited to `Workers Scripts:Edit`, `Workers KV:Edit`, `R2:Edit`,
   `D1:Edit`, `Queues:Edit` on *this account only*, and separate deploy vs runtime credentials.
   R2 keys should be bucket-scoped (that `custom-wayback` bucket only) and, for the crawler
   container, write-only where possible.
5. **Short-lived where possible.** Prefer Cloudflare Access service tokens and OIDC from GitHub
   Actions over long-lived static keys.
6. **Environment variables the app actually needs** (names only — no values here, ever):
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (deploy only), a *new* bucket-scoped
   `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` / `STORAGE_ENDPOINT` /
   `STORAGE_BUCKET_NAME`, `LINK_LEDGER_KV_ID`, `CRAWLER_USER_AGENT`, rate-limit and budget vars,
   and (later, optionally) `NEXTAUTH_SECRET`-class signing keys for real user accounts. Note the
   existing `REDIS_URL` line in the input file is a **Zod schema snippet, not a connection
   string** — with Redis removed from v1 there is nothing to fill in.
7. **Never log secrets.** Sanitize request/response logging in the crawler; redact `Authorization`,
   `Cookie`, and S3 signature headers; ensure CI logs cannot echo `.dev.vars`.
8. **Audit the blast radius:** if those tokens were used from more than one machine or were ever
   shared, review Cloudflare's audit log and GitHub's security log for activity you don't
   recognize, and check for unexpected R2 objects or Worker deployments.

---

## 14. Delivery roadmap

Each phase ships something demonstrable and is gated on the acceptance criteria in §9.3 and below.

### Phase 0 — Foundations (0.5–1 day)
Repo skeleton (`apps/web`, `apps/api`, `apps/crawler`, `packages/shared`), TypeScript project
references, Tailwind v4 + shadcn/ui, `wrangler` config, D1 schema + Drizzle migrations, secret
rotation from §13, `.gitignore` + gitleaks, CI running typecheck/lint/test on push.
**Done when:** `wrangler dev` serves a hello-world shell and `wrangler d1 migrations apply` runs
against a preview D1.

### Phase 1 — Prove the pipeline locally (2–3 days) ← **highest-risk work, do it first**
Local Node runner: CDX survey with `collapse=timestamp:8` for `samsung.com` / one month; day
bucketing with the §6.2 "best capture" policy; `id_` raw fetch of the homepage + 20 pages;
rewrite + store to a local MinIO bucket and a local SQLite ledger; print a stats table (pages,
unique assets, dedupe ratio, bytes, 429 count, wall time).
**Done when:** `pnpm crawl --domain=samsung.com --month=2024-03` produces a browsable local
folder and a stats report, at < 1 req/s with zero unhandled 429s. **This phase decides the real
per-domain cost numbers** — everything in §11 gets re-checked against measured data here.

### Phase 2 — Viewer + minimal UI (3–4 days)
Viewer Worker (`/a/:domain/:day/*`) with Cache API + R2 read-through, `HTMLRewriter` base/CSP/shim
injection, iframe sandbox shell, day scrubber toolbar, link-resolution badges. API: `POST /v1/jobs`,
`GET /v1/jobs/:id` (SSE progress), `GET /v1/coverage/:domain`.
**Done when:** a crawled month browses locally with warm pages < 150 ms and no archive.org calls
in the request log.

### Phase 3 — Mobile PWA hardening (2–3 days)
Modern picker (month/year calendar, density dots), bottom sheet, safe areas, dark mode, skeleton
states, error/empty states, service worker (shell + ≤ 25 MB LRU + prefetch of top in-site links),
`navigator.storage.estimate()` reporting, install prompts/instructions.
**Done when:** the full §9.3 real-device checklist passes on physical A36 and iPhone.

### Phase 4 — Production ingest (3–5 days)
Move the crawler to a Cloudflare Container (or Hetzner box), wire Queues, resumable jobs,
circuit breaker + 429 telemetry, R2 lifecycle rules, Cloudflare Access in front of the app,
billing alerts, `/v1/usage` dashboard, cron-based refresh for tracked domains.
**Done when:** a crawl survives an induced archive.org 429 storm, resumes, and completes; usage
dashboard matches the invoice line items.

### Phase 5 — Polish (ongoing)
Cross-domain search inside crawled snapshots (D1 FTS5), "compare two months" view for the
marketing-research use case, share links, export a snapshot as a static bundle (see §15), PDF/
screenshot capture, and passkey-based multi-user if it ever leaves your pocket.

---

## 15. Optional add-ons worth knowing about

| Idea | Value | Rough cost |
|---|---|---|
| **Snapshot export as a static ZIP** | Hand a self-contained month of a site to a colleague, or archive it yourself with no dependency on this tool | R2 egress free; ZIP built in a Worker/Container |
| **"Download for offline" per month** | True offline browsing in the field | Same; works with iOS's 7-day limit by re-fetching on demand |
| **Full-text search across snapshots** | Huge for marketing research ("when did they change the price page?") | D1 FTS5, ~$0.75/GB-mo |
| **Diff two months** | Visual change detection on a competitor's site | CPU-only; no new services |
| **Local-first desktop mode** (`node apps/crawler` + local viewer) | Zero cloud cost, fully private research corpus | $0 |
| **Save Page Now integration** | Archive a live page you're looking at, then read it here fast | SPN has its own access policy — evaluate before building |

---

## 16. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **archive.org rate-limits / blocks the crawler (429)** | **High** — it is happening today, publicly | ≤ 1 req/s/host, honest UA, exponential backoff + circuit breaker, aggressive caching so repeat work is zero, batch crawls off-peak, visible throttling state in the UI, and a documented escalation path (§12) |
| Crawl of a huge domain blows the time/cost budget | High | Mandatory budgets (§6.3), on-demand fallback for everything outside the budget, byte cap with hard abort |
| iPhone storage eviction (7 days) + ~50 MB cap breaks "offline" expectations | Medium | Edge cache is the source of truth; SW cache ≤ 25 MB and rebuildable; never promise device-local offline for the whole month |
| Archived JS depends on dead APIs → broken interactions | Medium | Script triage, global shims, error shield with visible counter, and honest UI copy that the tool optimizes layout/static DOM (some 2010s AJAX apps will not fully work) |
| Content-addressed storage grows unbounded | Low–Medium | R2 lifecycle rules, `raw/` → IA class, per-domain retention policy, usage dashboard |
| Legal/copyright complaint about a stored corpus | Medium | Personal research scope, no public serving, attribution + link to the original capture, keep it private behind Access |
| Iframe sandbox breaks a specific site | Low | Per-site opt-in served from a separate origin; never relax the app origin |
| Cloudflare vendor lock-in | Low | Crawler is portable Node, storage is S3-compatible, ledger is SQLite — moving to a Hetzner box + MinIO is a config change |

---

## 17. Open decisions for you

1. **Scope of v1:** "two domains, one month" (fastest to value, matches your actual use) or
   "N domains tracked continuously" (needs the Phase 4 cron/refresh machinery)?
2. **Crawler location for v1:** local PC ($0, private, must be running) vs Cloudflare Container
   (included in $5, always available)?
3. **How much of each site matters?** A budget of 250 pages/month is generous for a corporate
   marketing site but trivial for a marketplace. Your call sets `MAX_PAGES_PER_MONTH`.
4. **Do you want the "single best day" picker, or "nearest capture" auto-resolution as the
   default behaviour** with the picker as an override?
5. **Auth:** Cloudflare Access (zero code, email OTP) or real accounts with passkeys from day one?
6. **Metric to optimize:** warm-page latency (< 150 ms, more aggressive caching) vs storage cost
   (store less, re-fetch more) — they trade off directly.

---

## 18. Pricing sources (verified October 2026)

- Cloudflare R2 pricing — <https://developers.cloudflare.com/r2/pricing/>
- Cloudflare Workers / D1 / Durable Objects / Queues / Containers pricing — <https://developers.cloudflare.com/workers/platform/pricing/>
- Cloudflare D1 pricing — <https://developers.cloudflare.com/d1/platform/pricing/>
- Cloudflare Cache API / Workers Cache — <https://blog.cloudflare.com/workers-cache/>
- Fly.io 2026 pricing update — <https://fly.io/pricing-update/>
- Hetzner Cloud — <https://www.hetzner.com/cloud/>
- Upstash Redis pricing (only if Redis is ever added) — <https://upstash.com/docs/redis/overall/billing>
- Vercel Pro plan (rejected baseline) — <https://vercel.com/docs/plans/pro-plan>
- Wayback CDX Server API reference — <https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md>
- Internet Archive, "An Update on Wayback Machine Access" (Sept 15, 2026) — <https://blog.archive.org/2026/09/15/an-update-on-wayback-machine-access/>
- PWA iOS limitations & Safari support (2026) — <https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide>

**Recommended next step:** Phase 1, locally, on one domain and one month. It is a day or two of
work, costs nothing, touches no production credentials beyond a rotated bucket-scoped key, and it
converts every cost and latency number in §11 from an estimate into a measurement.
