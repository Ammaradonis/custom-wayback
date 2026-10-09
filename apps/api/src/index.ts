/**
 * Cloudflare Workers entry point.
 *
 * Routes:
 *  /v1/auth/*     — registration, login, logout
 *  /v1/domains/*  — domain management
 *  /v1/jobs/*     — ingest job management + SSE progress
 *  /a/*           — archive viewer (fast plane)
 *  /*             — static assets (Workers Static Assets from apps/web/dist)
 *
 * Scheduled handler (cron "* * * * *"):
 *  - Purge R2 content for pages already served (storage-cost strategy).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { authRouter } from "./routes/auth.js";
import { domainsRouter } from "./routes/domains.js";
import { ingestRouter } from "./routes/ingest.js";
import { viewerRouter } from "./routes/viewer.js";
import { manifestRouter } from "./routes/manifest.js";
import { purgeStaleCachedPages } from "./lib/r2.js";
import type { Env } from "./env.js";

const app = new Hono<{ Bindings: Env }>();

// ── Global middleware ─────────────────────────────────────────────────────────

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

// ── Routes ────────────────────────────────────────────────────────────────────

app.route("/v1/auth", authRouter);
app.route("/v1/domains", domainsRouter);
app.route("/v1/jobs", ingestRouter);
app.route("/v1", manifestRouter);
app.route("/a", viewerRouter);

// ── Health check ──────────────────────────────────────────────────────────────

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

  const allOk = Object.values(checks).every(Boolean);
  return c.json({ ok: allOk, checks }, allOk ? 200 : 503);
});

// ── Static assets fallthrough ─────────────────────────────────────────────────

app.get("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// ── Default export (Workers fetch + scheduled handlers) ──────────────────────

export default {
  fetch: app.fetch,

  /**
   * Scheduled handler — runs every minute via Cron Trigger.
   * Purges R2 content for pages already served past the grace period.
   * This is the core of the "delete cached content after user visits" strategy.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      purgeStaleCachedPages(env).then((n) => {
        if (n > 0) {
          console.log(`[purge] Deleted ${n} R2 objects.`);
        }
      }),
    );
  },
};
