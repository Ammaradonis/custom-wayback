/**
 * Domain management routes.
 *
 * GET    /v1/domains           — list all tracked domains for the user
 * POST   /v1/domains           — add a domain
 * DELETE /v1/domains/:domainId — remove a domain (soft delete)
 * GET    /v1/domains/:domainId/coverage — CDX coverage bar (year × day)
 */

import { archiveHeadersFor } from "../lib/archive-auth.js";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  AddDomainSchema,
  DomainParamSchema,
  DEFAULT_BUDGET,
  CDX_BASE,
} from "@custom-wayback/shared";
import { authenticateRequest } from "../lib/auth.js";
import { ulid } from "../lib/ulid.js";
import type { Env } from "../env.js";

export const domainsRouter = new Hono<{ Bindings: Env }>();

// ── Auth middleware ───────────────────────────────────────────────────────────

domainsRouter.use("/*", async (c, next) => {
  const userId = await authenticateRequest(c.req.raw, c.env);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
});

// ── Normalise raw domain input ────────────────────────────────────────────────

function normaliseDomain(raw: string): { domain: string; hostFilter: string | null } {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Invalid domain: ${raw}`);
  }
  const domain = url.hostname.replace(/^www\./, "");
  const hostFilter = url.pathname !== "/" ? `${url.hostname}${url.pathname}` : null;
  return { domain, hostFilter };
}

// ── List ─────────────────────────────────────────────────────────────────────

domainsRouter.get("/", async (c) => {
  const userId = c.get("userId" as never) as string;
  const rows = await c.env.DB.prepare(
    `SELECT id, domain, host_filter, budget_json, tracking_status, added_at, last_crawled_at
     FROM domains WHERE user_id = ? AND tracking_status != 'deleted' ORDER BY added_at DESC`,
  )
    .bind(userId)
    .all();
  return c.json(rows.results);
});

// ── Add ──────────────────────────────────────────────────────────────────────

domainsRouter.post("/", zValidator("json", AddDomainSchema), async (c) => {
  const userId = c.get("userId" as never) as string;
  const { rawInput, budget } = c.req.valid("json");

  let domain: string;
  let hostFilter: string | null;
  try {
    ({ domain, hostFilter } = normaliseDomain(rawInput));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM domains WHERE user_id = ? AND domain = ? AND tracking_status != 'deleted'",
  )
    .bind(userId, domain)
    .first();
  if (existing) return c.json({ error: "Domain already tracked" }, 409);

  const id = ulid();
  const mergedBudget = { ...DEFAULT_BUDGET, ...budget };
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `INSERT INTO domains (id, user_id, domain, host_filter, budget_json, tracking_status, added_at)
     VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(id, userId, domain, hostFilter, JSON.stringify(mergedBudget), "active", now)
    .run();

  return c.json({ id, domain, hostFilter, budget: mergedBudget }, 201);
});

// ── Delete (soft) ─────────────────────────────────────────────────────────────

domainsRouter.delete("/:domainId", async (c) => {
  const userId = c.get("userId" as never) as string;
  const parsed = DomainParamSchema.safeParse(c.req.param());
  if (!parsed.success) return c.json({ error: "Invalid domainId" }, 400);

  await c.env.DB.prepare(
    "UPDATE domains SET tracking_status = 'deleted' WHERE id = ? AND user_id = ?",
  )
    .bind(parsed.data.domainId, userId)
    .run();

  return c.json({ ok: true });
});

// ── Coverage bar ──────────────────────────────────────────────────────────────

domainsRouter.get("/:domainId/coverage", async (c) => {
  const userId = c.get("userId" as never) as string;
  const parsed = DomainParamSchema.safeParse(c.req.param());
  if (!parsed.success) return c.json({ error: "Invalid domainId" }, 400);

  const domainRow = await c.env.DB.prepare(
    "SELECT domain, coverage_json FROM domains WHERE id = ? AND user_id = ?",
  )
    .bind(parsed.data.domainId, userId)
    .first<{ domain: string; coverage_json: string | null }>();
  if (!domainRow) return c.json({ error: "Not found" }, 404);

  // Return cached coverage if available.
  if (domainRow.coverage_json) {
    return c.json(JSON.parse(domainRow.coverage_json));
  }

  // Fetch from KV (cheaper, globally replicated).
  const kvKey = `coverage:${domainRow.domain}`;
  const cached = await c.env.COVERAGE_KV.get(kvKey, "text");
  if (cached) {
    // Backfill the domain row.
    await c.env.DB.prepare("UPDATE domains SET coverage_json = ? WHERE id = ?")
      .bind(cached, parsed.data.domainId)
      .run();
    return c.json(JSON.parse(cached));
  }

  // Fetch from CDX (cheap: collapse=timestamp:365 gives one row per year).
  const url = new URL(CDX_BASE);
  url.searchParams.set("url", domainRow.domain);
  url.searchParams.set("matchType", "domain");
  url.searchParams.set("output", "json");
  url.searchParams.set("fl", "timestamp");
  url.searchParams.set("filter", "statuscode:200");
  url.searchParams.set("collapse", "timestamp:6"); // one per month
  url.searchParams.set("limit", "2000");

  const resp = await fetch(url.toString(), {
    headers: archiveHeadersFor(url.toString(), c.env, { "User-Agent": c.env.CRAWLER_USER_AGENT }),
  });
  if (!resp.ok) return c.json({ error: "CDX fetch failed" }, 502);

  const rows = (await resp.json()) as string[][];
  // rows[0] is the header line ["timestamp"]
  const coverage = rows
    .slice(1)
    .map((r) => r[0] ?? "")
    .filter(Boolean);

  const payload = JSON.stringify(coverage);
  // Cache forever — historical CDX data is immutable.
  await c.env.COVERAGE_KV.put(kvKey, payload, { expirationTtl: 60 * 60 * 24 * 365 });
  await c.env.DB.prepare("UPDATE domains SET coverage_json = ? WHERE id = ?")
    .bind(payload, parsed.data.domainId)
    .run();

  return c.json(coverage);
});
