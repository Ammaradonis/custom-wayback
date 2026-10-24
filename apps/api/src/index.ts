/**
 * Cloudflare Workers entry point.
 *
 * Routes:
 *  POST /v1/auth/…      — registration, login, logout
 *  GET  /v1/domains/…   — domain management
 *  POST /v1/jobs        — start a crawl;  GET /v1/jobs/:id for status
 *  GET  /v1/jobs/usage  — cost monitoring dashboard payload
 *  …    /v1/precrawl/…  — the local crawler publishes pre-crawled pages into R2
 *  GET  /a/:domain/…    — archive viewer (fast plane); a top-level navigation gets the shell
 *  GET  /_cw/r/…        — archived resources for on-demand pages
 *  POST /_cw/warm       — prepare likely next pages at the edge
 *  anything else        — static assets (Workers Static Assets from apps/web/dist)
 *
 * Queue handler:
 *  Consumes `custom-wayback-ingest`. One message = one bounded stage of one
 *  crawl, so a delivery failure costs a batch rather than a whole job. The
 *  dead-letter queue is drained by the same handler and recorded, never dropped.
 *
 * Scheduled handler (every 5 minutes — see [triggers] in wrangler.toml):
 *  - Purge R2 content for pages already served (storage-cost strategy).
 *  - Prune expired rate-limit windows.
 *  - Re-drive stalled jobs whose lease expired without a completion.
 */

import { archiveAuthMode } from "./lib/archive-auth.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { authRouter } from "./routes/auth.js";
import { domainsRouter } from "./routes/domains.js";
import { ingestRouter } from "./routes/ingest.js";
import {
  fetchOnDemandResource,
  frameAppOrigin,
  leakedArchiveResource,
  parseResourcePath,
  scheduleWarm,
  viewerRouter,
} from "./routes/viewer.js";
import { manifestRouter } from "./routes/manifest.js";
import { precrawlRouter } from "./routes/precrawl.js";
import { searchRouter } from "./routes/search.js";
import { sharesRouter } from "./routes/shares.js";
import { compareRouter } from "./routes/compare.js";
import { exportRouter } from "./routes/export.js";
import { backupRouter, backupHealth } from "./routes/backup.js";
import { assetKey, purgeStaleCachedPages } from "./lib/r2.js";
import { pruneRateLimits } from "./lib/ratelimit.js";
import { BackupNotConfiguredError, BackupSync, backupEnabled } from "./lib/backup.js";
import { handleIngestMessage, handleDeadLetter } from "./queue/ingest.js";
import { LEASE_SECONDS, type IngestQueueMessage } from "@custom-wayback/shared";
import type { Env } from "./env.js";

const app = new Hono<{ Bindings: Env }>();

function setArchiveResourceHeaders(headers: Headers, origin: string | undefined): void {
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  // The viewer iframe has an opaque origin (`null`). Allow that isolated frame to
  // read archived assets, while avoiding a wildcard CORS grant to unrelated sites.
  if (origin === "null") headers.set("Access-Control-Allow-Origin", "null");
  else headers.delete("Access-Control-Allow-Origin");
  const vary = (headers.get("Vary") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!vary.some((value) => value.toLowerCase() === "origin")) vary.push("Origin");
  headers.set("Vary", vary.join(", "));
}

// ── Global middleware ─────────────────────────────────────────────────────────

// The archive-only frame origin (wrangler.frame.toml) serves archived pages and their
// resources, and nothing else: no app shell, no API, no share links. Archived documents
// there keep a real origin, so nothing that holds a session may ever run on it. It is
// framed by the app origin alone — the header form, because `frame-ancestors` is
// ignored in a meta policy — instead of `X-Frame-Options: SAMEORIGIN`, which would
// refuse the app. Registered first, so it is outermost and has the last word.
app.use("*", async (c, next) => {
  const appOrigin = frameAppOrigin(c.env);
  if (!appOrigin) return next();

  const path = c.req.path;
  if (!path.startsWith("/a/") && !path.startsWith("/_cw/") && !/^\/assets\/[0-9a-f]{2}\/[0-9a-f]{64}$/i.test(path)) {
    // A root-relative URL an archived page built in script lands here; on this origin
    // every same-origin request comes from an archived page.
    const leaked = leakedArchiveResource(c.req.raw, { sameOriginIsArchive: true });
    if (!leaked) return c.text("Not found", 404);
    const response = await fetchOnDemandResource(leaked.ts, leaked.url, c.env, c.executionCtx, leaked.destination);
    setArchiveResourceHeaders(response.headers, c.req.header("Origin"));
    return response;
  }

  await next();
  c.res.headers.delete("X-Frame-Options");
  c.res.headers.append("Content-Security-Policy", `frame-ancestors ${appOrigin}`);
});

// The archived page lives in an opaque-origin iframe. CORP's normal same-origin
// default would block its font and other no-cors asset requests, so opt the archive's
// asset responses — and only those — into cross-origin resource loading. They are
// recognised by route, or by the source marker the resource producer sets, which also
// covers assets answered on a viewer route or recovered by the leak handler below.
// Registered before secureHeaders, so it wraps it and its value is the final header.
app.use("*", async (c, next) => {
  await next();
  const path = c.req.path;
  if (
    path.startsWith("/assets/") ||
    path.startsWith("/_cw/r") ||
    c.res.headers.get("X-Custom-Wayback-Source") === "on-demand-resource"
  ) {
    setArchiveResourceHeaders(c.res.headers, c.req.header("Origin"));
  }
  // The viewer's warm request to a separate frame origin is a no-cors POST; a
  // same-origin resource policy would make the browser refuse the (empty) answer and
  // log it as an error, though the warm itself went through.
  if (path === "/_cw/warm") c.res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
});

app.use("*", logger());

app.use(
  "*",
  secureHeaders({
    // Prevent clickjacking on the app shell.
    xFrameOptions: "SAMEORIGIN",
    // Strict transport (set here; Cloudflare also enforces it at the edge).
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    // Prevent MIME sniffing.
    xContentTypeOptions: "nosniff",
    // No referrer to external sites.
    referrerPolicy: "strict-origin-when-cross-origin",
    // Permissions policy: deny camera, mic, geolocation.
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
    },
  }),
);

app.use(
  "/v1/*",
  cors({
    origin: (origin) => {
      // In dev allow localhost; in prod allow only the configured app origin.
      // CORS is an added layer — JWTs are the real auth mechanism.
      if (!origin) return null;
      if (origin.startsWith("http://localhost")) return origin;
      return origin; // Workers already enforce auth on every request
    },
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  }),
);

// ── Health check ──────────────────────────────────────────────────────────────
//
// Registered BEFORE any router is mounted. `manifestRouter` is mounted at `/v1`
// and attaches auth middleware to `/v1/*`, and Hono matches in registration
// order — so a health route declared after it would be rejected with a 401 by
// middleware that has nothing to do with health. That is exactly the kind of bug
// that only shows up when something outside the app tries to check on the app.

app.get("/v1/health", async (c) => {
  const checks: Record<string, boolean> = {};

  // D1 reachability.
  try {
    await c.env.DB.prepare("SELECT 1").first();
    checks["d1"] = true;
  } catch {
    checks["d1"] = false;
  }

  // R2 reachability (list with limit 1 = Class B op, cheap).
  try {
    await c.env.STORAGE.list({ limit: 1 });
    checks["r2"] = true;
  } catch {
    checks["r2"] = false;
  }

  // Queue reachability: `send` is the only probe Workers exposes, so we check the
  // binding exists and is callable rather than spending a real message.
  checks["queue"] = typeof c.env.INGEST_QUEUE?.send === "function";

  // Config presence. This is not paranoia: `.dev.vars` is read relative to the
  // Worker's own directory, so a file at the repo root is silently ignored and
  // every login fails with an opaque 500 from `crypto.subtle.importKey` on an
  // empty secret. Asserting here turns a five-minute debugging session into a
  // failed health check that names the missing variable.
  checks["secrets"] = typeof c.env.JWT_SECRET === "string" && c.env.JWT_SECRET.length >= 32;

  // The Supabase backup mirror is reported but deliberately **not** folded into
  // `ok`. It is best-effort by design: Supabase having a bad minute must not make
  // the Worker declare itself unhealthy, or every uptime monitor pointed here
  // would page for something the app is built to survive. The nested object
  // carries the states a boolean cannot (`behind`, `failing`, `drift`,
  // `unreachable`), and `configured: false` is the ordinary "not set up yet".
  const backup = await backupHealth(c.env);
  const allOk = Object.values(checks).every(Boolean);
  return c.json(
    {
      ok: allOk,
      checks,
      // How archive.org traffic is attributed. `anonymous` is not an error — the crawler
      // works, it just collects 429s that an account does not (see
      // `lib/archive-auth.ts`) — so this is reported rather than checked, and it is the
      // first thing to look at when a crawl is throttled.
      archiveAuth: archiveAuthMode(c.env),
      backup: {
        configured: backup.configured,
        enabled: backup.enabled,
        reachable: backup.reachable,
        health: backup.health,
        lagSeconds: backup.lagSeconds,
        pendingRows: backup.pendingRows,
        ...(backup.error ? { error: backup.error } : {}),
      },
    },
    allOk ? 200 : 503,
  );
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.route("/v1/auth", authRouter);
app.route("/v1/domains", domainsRouter);
app.route("/v1/jobs", ingestRouter);
app.route("/v1/search", searchRouter);
app.route("/v1/shares", sharesRouter);
app.route("/v1/compare", compareRouter);
app.route("/v1/export", exportRouter);
app.route("/v1/backup", backupRouter);
app.route("/v1/precrawl", precrawlRouter);
app.route("/v1", manifestRouter);
app.route("/a", viewerRouter);

// ── Share-link entry point ────────────────────────────────────────────────────
//
// `/s/<token>` is the URL a share link actually is. It resolves the token and
// sends the browser to the snapshot route the token scopes. A redirect rather
// than a bespoke view means the recipient lands on the ordinary viewer, with the
// ordinary toolbar and day scrubber, and there is no second rendering path to
// keep in step with the first.
//
// Registered before the asset fallthrough so it is not swallowed by the SPA
// handler. It intentionally requires whatever access control fronts the app —
// see the note in `routes/shares.ts`: a share link is a capability, not a way
// around Cloudflare Access (plan.md §13).
app.get("/s/:token", async (c) => {
  const token = c.req.param("token");
  if (!/^[0-9a-f]{32}$/.test(token)) {
    return c.text("This share link is not valid.", 404);
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const row = await c.env.DB.prepare(
    `SELECT domain, month, day, url, expires_at, revoked_at FROM share_links WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{
      domain: string;
      month: string | null;
      day: string | null;
      url: string | null;
      expires_at: number | null;
      revoked_at: number | null;
    }>();

  if (!row) return c.text("This share link does not exist.", 404);
  if (row.revoked_at !== null) return c.text("This share link has been revoked.", 410);

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at !== null && row.expires_at < now) {
    return c.text("This share link has expired.", 410);
  }

  c.executionCtx.waitUntil(
    c.env.DB.prepare(`UPDATE share_links SET view_count = view_count + 1, last_viewed_at = ? WHERE token_hash = ?`)
      .bind(now, tokenHash)
      .run()
      .catch(() => void 0),
  );

  if (row.url && row.day) {
    let path = "/";
    try {
      const parsed = new URL(row.url);
      path = parsed.pathname.startsWith("/") ? parsed.pathname : `/${parsed.pathname}`;
      if (parsed.search) path += `%3F${encodeURIComponent(parsed.search.slice(1))}`;
    } catch {
      // A malformed stored URL falls back to the month view below.
      path = "";
    }
    if (path) return c.redirect(`/a/${row.domain}/${row.day}${path}`, 302);
  }

  // A month-scoped link opens the picker for that month.
  const query = row.month ? `?domain=${encodeURIComponent(row.domain)}&month=${row.month}` : "";
  return c.redirect(`/${query}`, 302);
});

// ── Static assets fallthrough ─────────────────────────────────────────────────

// The ingest rewriter points archived page assets at their immutable R2 hash.
// Serve those before the SPA's static-assets fallback, which only knows about
// Vite's own files and otherwise returns the app shell for every missing path.
app.get("/assets/:prefix/:hash", async (c) => {
  const { prefix, hash } = c.req.param();
  if (!/^[a-f0-9]{2}$/i.test(prefix) || !/^[a-f0-9]{64}$/i.test(hash) || hash.slice(0, 2).toLowerCase() !== prefix.toLowerCase()) {
    return new Response("Not found", { status: 404 });
  }

  const cacheKey = `https://cache.internal/assets/${prefix.toLowerCase()}/${hash.toLowerCase()}`;
  let cached: Response | undefined;
  try {
    cached = await caches.default.match(cacheKey);
  } catch {
    // Cache is an optimization; R2 remains the source of truth.
  }
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers: new Headers(cached.headers),
    });
  }

  const object = await c.env.STORAGE.get(assetKey(hash.toLowerCase()));
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  // The archived page runs in an opaque sandbox origin. Fonts and other CORS-mode
  // resources therefore need an anonymous wildcard response from this public route.
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("ETag", object.httpEtag);
  if ((headers.get("Content-Type") ?? "").toLowerCase().startsWith("image/svg+xml")) {
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  const response = new Response(object.body, { headers });
  c.executionCtx.waitUntil(caches.default.put(cacheKey, response.clone()).catch(() => void 0));
  return response;
});

// Cold captures are rewritten to this same-origin route so the page's strict CSP
// can allow archived resources without letting the browser contact live hosts.
// `/_cw/r/<ts>/<scheme>/<host><path>` is the current form (see `resourcePath` for why it
// is path-shaped); `/_cw/resource?ts=&url=` is what pages cached before it still use.
const preflight = () =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
app.options("/_cw/resource", preflight);
app.options("/_cw/r/*", preflight);
app.get("/_cw/resource", (c) =>
  fetchOnDemandResource(
    c.req.query("ts") ?? "",
    c.req.query("url") ?? "",
    c.env,
    c.executionCtx,
    c.req.header("Sec-Fetch-Dest") ?? "",
  ),
);
app.get("/_cw/r/*", (c) => {
  const url = new URL(c.req.url);
  const resource = parseResourcePath(url.pathname, url.search);
  if (!resource) return new Response("Invalid archived resource request", { status: 400 });
  return fetchOnDemandResource(resource.ts, resource.url, c.env, c.executionCtx, c.req.header("Sec-Fetch-Dest") ?? "");
});

// The viewer asks the edge to prepare the pages a visitor is likely to open next
// (`scheduleWarm`). Same-origin only: it is the viewer's own optimisation, not an
// endpoint for other sites to make this Worker fetch from archive.org.
app.post("/_cw/warm", async (c) => {
  // From the viewer itself: same-origin, or — on the frame origin — the app origin.
  const site = c.req.header("Sec-Fetch-Site");
  const fromApp = frameAppOrigin(c.env) !== null && c.req.header("Origin") === frameAppOrigin(c.env);
  if (site && site !== "same-origin" && !fromApp) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => null)) as { routes?: unknown } | null;
  const accepted = scheduleWarm(c.env, c.executionCtx, new URL(c.req.url).origin, body?.routes);
  return c.json({ accepted }, 202);
});

app.get("*", async (c) => {
  // A root-relative URL an archived page built in script (`/images/hero.jpg`) arrives
  // here, on the app's own origin. Its Referer says which capture it belongs to.
  const leaked = leakedArchiveResource(c.req.raw);
  if (leaked) return fetchOnDemandResource(leaked.ts, leaked.url, c.env, c.executionCtx, leaked.destination);

  const response = await c.env.ASSETS.fetch(c.req.raw);
  // Re-wrap before returning. A Response that came out of the ASSETS fetcher can
  // carry immutable headers, and middleware that runs after this handler
  // (`secureHeaders`) then throws "Can't modify immutable headers" — turning
  // every deep link the SPA handles client-side into a 500. Copying the body and
  // headers into a fresh Response costs nothing and makes the response ours to
  // decorate.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
});

// ── Stalled-job recovery ──────────────────────────────────────────────────────

/**
 * Re-drive jobs whose consumer died mid-batch.
 *
 * A Worker can be evicted without notice; when that happens the lease it held
 * simply expires. Without this sweep the job would sit in `fetching` forever and
 * the UI would show a progress bar that never moves. Re-driving is safe because
 * every stage is idempotent and resumes from the cursor.
 */
async function requeueStalledJobs(env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const stale = await env.DB.prepare(
    `SELECT i.id, i.month, i.stage, i.domain_id, d.domain
     FROM ingests i
     JOIN domains d ON d.id = i.domain_id
     WHERE i.status IN ('queued','surveying','fetching','rewriting')
       AND i.stage IS NOT NULL
       AND i.stage != 'done'
       AND (i.lease_until IS NULL OR i.lease_until < ?)
       AND (i.breaker_open_until IS NULL OR i.breaker_open_until < ?)
       AND (i.started_at IS NULL OR i.started_at < ?)
     LIMIT 20`,
  )
    .bind(now, now, now - LEASE_SECONDS)
    .all<{ id: string; month: string; stage: string; domain: string }>();

  let requeued = 0;
  for (const row of stale.results ?? []) {
    const message: IngestQueueMessage = {
      ingestId: row.id,
      domain: row.domain,
      month: row.month,
      stage: row.stage as IngestQueueMessage["stage"],
      enqueuedAt: now,
    };
    try {
      await env.INGEST_QUEUE.send(message);
      // Take the lease immediately so two consecutive cron ticks cannot both
      // re-drive the same job.
      await env.DB.prepare(`UPDATE ingests SET lease_until = ? WHERE id = ?`)
        .bind(now + LEASE_SECONDS, row.id)
        .run();
      requeued += 1;
    } catch {
      // Next tick will retry.
    }
  }
  return requeued;
}

/**
 * Mirror the D1 ledger into Supabase.
 *
 * Runs on every cron tick; the *syncer* decides whether there is anything to do,
 * via three cheap gates that cost one D1 read each and no network:
 *
 *   1. `BACKUP_ENABLED` — an off switch that does not require removing secrets.
 *   2. a lease, so two ticks cannot run concurrently;
 *   3. an interval and a per-day run ceiling, so a quiet deployment still talks to
 *      Supabase often enough to keep a free project from being paused for
 *      inactivity, but not once every five minutes forever.
 *
 * A run that finds nothing new costs no HTTP requests at all: each table's high
 * watermark is compared against the mirror's cursor first. That is what makes it
 * reasonable to leave this on the five-minute trigger rather than adding a second
 * schedule — and adding a second cron entry would mean a second `[triggers]`
 * block, which is one more thing to get wrong at deploy time.
 */
async function runScheduledBackup(env: Env): Promise<void> {
  if (!backupEnabled(env)) return;
  try {
    const sync = new BackupSync(env);
    const summary = await sync.run();
    if (summary.rows > 0) {
      console.log(
        `[backup] mirrored ${summary.rows} row(s) across ${summary.tables.length} table(s) in ${summary.durationMs}ms`,
      );
    }
    if (summary.failures.length > 0) {
      console.error(`[backup] failed tables: ${summary.failures.join(", ")}`);
    }
    if (summary.stoppedBecause === "drift") {
      console.error(
        `[backup] schema drift: ${(summary.drift ?? [])
          .map((d) => d.detail)
          .slice(0, 5)
          .join("; ")}`,
      );
    }
  } catch (err) {
    if (err instanceof BackupNotConfiguredError) return; // Optional feature, not an error.
    console.error(`[backup] run failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Default export (fetch + queue + scheduled handlers) ──────────────────────

export default {
  fetch: app.fetch,

  /**
   * Queue consumer. `batch` is bounded by `max_batch_size` in wrangler.toml, and
   * each message does its own bounded slice of work, so total archive.org
   * request rate is a configuration value rather than an emergent property.
   */
  async queue(batch: MessageBatch<IngestQueueMessage>, env: Env): Promise<void> {
    const isDlq = batch.queue.includes("dlq");

    for (const message of batch.messages) {
      const body = message.body;
      if (!body || typeof body.ingestId !== "string") {
        // Unparseable message: ack it, or the queue will redeliver it forever.
        console.error(`[queue] dropping malformed message on ${batch.queue}`);
        message.ack();
        continue;
      }

      if (isDlq) {
        await handleDeadLetter(env, body, "exhausted retries");
        message.ack();
        continue;
      }

      try {
        await handleIngestMessage(env, body);
        message.ack();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[queue] ${body.ingestId} (${body.stage}) threw: ${reason}`);
        // Retry with backoff; the platform sends it to the DLQ after
        // `max_retries`, and the DLQ handler records the failure in D1.
        message.retry({ delaySeconds: Math.min(60 * (message.attempts + 1), 900) });
      }
    }
  },

  /**
   * Scheduled handler — runs every 5 minutes via Cron Trigger.
   * Each sweep is independent and non-fatal: one failing must not skip the others.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const purged = await purgeStaleCachedPages(env);
          if (purged > 0) console.log(`[purge] deleted ${purged} R2 objects`);
        } catch (err) {
          console.error(`[purge] failed: ${err instanceof Error ? err.message : err}`);
        }

        try {
          const pruned = await pruneRateLimits(env);
          if (pruned > 0) console.log(`[ratelimit] pruned ${pruned} expired windows`);
        } catch (err) {
          console.error(`[ratelimit] prune failed: ${err instanceof Error ? err.message : err}`);
        }

        try {
          const requeued = await requeueStalledJobs(env);
          if (requeued > 0) console.log(`[queue] re-drove ${requeued} stalled job(s)`);
        } catch (err) {
          console.error(`[queue] stalled-job sweep failed: ${err instanceof Error ? err.message : err}`);
        }

        // Last, so a slow mirror can never delay the sweeps that keep the crawler
        // moving. It is the only one of the four that talks to a third party.
        await runScheduledBackup(env);
      })(),
    );
  },
};
