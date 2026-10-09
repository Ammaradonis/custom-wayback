# custom-wayback

Personal, mobile-first Wayback Machine browser.  
Pick a domain + month → wait a few seconds → browse that snapshot as if it were live.

> **Phase status:** Phase 0 (foundations) and Phase 1 (local crawler + viewer) are complete.  
> Phase 2 (cloud API + React PWA) is in progress.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22.5 | Uses `node:sqlite` (built-in, Node 22.5+) |
| pnpm | ≥ 9 | `npm i -g pnpm` |
| Git | any | |
| Playwright browsers | auto | installed by `pnpm install` via `playwright install chromium` |
| Docker (optional) | any | only needed for MinIO local R2 stand-in |

---

## First 30 minutes — local only, zero cloud spend

### 1. Clone and install

```powershell
cd C:\Users\FingerWeg\Documents\custom-wayback   # already here
pnpm install
bash scripts/install-hooks.sh   # installs the gitleaks pre-commit guard
```

### 2. Run your first crawl (Phase 1)

```powershell
cd apps/crawler-local

# Crawl example.com for January 2024, up to 25 pages
node --experimental-sqlite --experimental-strip-types --disable-warning=ExperimentalWarning `
     src/cli.ts crawl --domain=example.com --month=2024-01 --max-pages=25

# Or a real site (be patient — 1 req/s to archive.org)
node --experimental-sqlite --experimental-strip-types --disable-warning=ExperimentalWarning `
     src/cli.ts crawl --domain=samsung.com --month=2024-03 --max-pages=50
```

Output is in `apps/crawler-local/data/`.  
The crawl respects archive.org's rate limits (≥ 1 s between requests) and backs off on 429s.

### 3. Browse the mirror locally

```powershell
node --experimental-sqlite --experimental-strip-types --disable-warning=ExperimentalWarning `
     src/cli.ts serve --port=8787

# Open http://localhost:8787 in your browser
# Or jump straight to a domain: http://localhost:8787?domain=samsung.com&month=2024-03
```

### 4. Check stats

```powershell
node --experimental-sqlite --experimental-strip-types --disable-warning=ExperimentalWarning `
     src/cli.ts stats
```

### pnpm shortcuts (from the repo root)

```powershell
# Crawl
pnpm --filter @custom-wayback/crawler-local run crawl -- --domain=samsung.com --month=2024-03 --max-pages=100

# Serve
pnpm --filter @custom-wayback/crawler-local run serve

# Stats
pnpm --filter @custom-wayback/crawler-local run stats
```

---

## Phase 2 — Cloudflare Workers + React PWA

### Before you deploy: rotate all credentials

`env-sensitive-so-never-expose-in-the-chat-log.txt` contains live credentials in plaintext.  
**Rotate everything before any code touches it.** Follow `plan.md §13`:

1. Revoke the GitHub PAT
2. Rotate both Cloudflare API tokens (replace with a scoped token)
3. Rotate the R2 access key pair (replace with a bucket-scoped write-only key)
4. Regenerate the webhook signing secret

### Local dev with Wrangler

```powershell
# 1. Copy the example vars and fill in your rotated credentials
Copy-Item .dev.vars.example .dev.vars
# Edit .dev.vars — see the comments inside

# 2. Fill in the three REPLACE_WITH_ placeholders in apps/api/wrangler.toml:
#    - database_id    (from `wrangler d1 list`)
#    - bucket_name    (from your Cloudflare R2 dashboard)
#    - KV namespace id (from `wrangler kv namespace list`)

# 3. Apply D1 migrations
cd apps/api
pnpm exec wrangler d1 migrations apply custom-wayback-ledger --local

# 4. Start MinIO (R2 stand-in)
cd ../..
docker compose up -d

# 5. Start the Worker and web dev servers in parallel
pnpm dev
```

The Vite dev server proxies `/v1/*` and `/a/*` to the Wrangler dev Worker on `:8787`.

### Deploy to production

```powershell
# Set secrets (run once)
cd apps/api
pnpm exec wrangler secret put JWT_SECRET
pnpm exec wrangler secret put STORAGE_ACCESS_KEY_ID
pnpm exec wrangler secret put STORAGE_SECRET_ACCESS_KEY

# Apply migrations to production D1
pnpm exec wrangler d1 migrations apply custom-wayback-ledger --remote

# Deploy
pnpm exec wrangler deploy
```

CI does this automatically on every push to `main`.

---

## Repository layout

```
apps/
  crawler-local/   Phase 1: local Node crawler + viewer (no cloud deps)
  crawler/         Phase 2: same crawler, wired to Cloudflare Queues + R2
  api/             Cloudflare Worker: auth, domains, jobs, archive viewer
  web/             React 19 + Vite PWA shell
packages/
  shared/          Drizzle D1 schema, Zod types, shared constants
scripts/
  install-hooks.sh gitleaks pre-commit guard
```

---

## Crawler CLI reference

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

## Etiquette / archive.org limits

This tool stays at ≥ 1 s between requests, sends an honest User-Agent with contact info,
backs off exponentially on 429/503, and stops the survey rather than hanging on a 504.
See `plan.md §12` for the full etiquette rules.

**Never reduce `--min-delay-ms` below 250.** The CLI enforces this.

---

## Cost (cloud, when you use Phase 2)

Personal use (2 domains, ~400 pages/month): **≈ $6/month** (Workers Paid plan $5 + R2 storage).  
Running the crawler from your own PC keeps it at **$0–2/month**.  
See `plan.md §11` for the full cost breakdown.

---

## Security notes

- Passwords hashed with **Argon2id** (via `oslo/password`)
- JWTs signed with **HS256**, 7-day TTL, revocable via the sessions table
- R2 content deleted after the user has visited the page (storage-cost strategy)
- Archived pages served in a `sandbox="allow-scripts allow-forms allow-popups"` iframe
- Strict `Content-Security-Policy` on every served snapshot
- `gitleaks` scans every commit; see `.gitleaks.toml`
