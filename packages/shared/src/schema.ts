/**
 * D1 / SQLite schema — authoritative definition via Drizzle ORM.
 *
 * Design choices encoded here:
 *  - Storage-cost-first: pages and assets are deleted from R2 once the user
 *    has visited them (served_at IS NOT NULL). The D1 ledger row is kept so
 *    navigation badges and link-resolution still work without a second fetch.
 *  - Nearest-capture auto-resolution is the default (SNAPSHOT_BEHAVIOR=nearest).
 *  - Many domains, tracked continuously (scope = "all" from Day 1).
 *  - No Redis, no BullMQ. Jobs live in this table + Cloudflare Queues.
 */

import {
  blob,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ── 1. Users (email + password auth) ────────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // ulid
  email: text("email").notNull().unique(),
  /** Argon2id hash — never the raw password. */
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(), // unix seconds
  lastLoginAt: integer("last_login_at"),
  /** Soft-delete / banned flag. */
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
});

// ── 2. Sessions (JWT alternative: server-side session table) ─────────────────
// We use short-lived JWTs for the API, but a revocation table lets us
// invalidate tokens immediately (e.g. on password change / logout-all).

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // ulid = jti claim
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issuedAt: integer("issued_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    /** Set on logout or password change. */
    revokedAt: integer("revoked_at"),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"), // sha256(ip), not the raw IP
  },
  (t) => [index("sessions_user_id").on(t.userId)],
);

// ── 3. Tracked domains ────────────────────────────────────────────────────────

export const domains = sqliteTable("domains", {
  id: text("id").primaryKey(), // ulid
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Canonical registrable domain, e.g. "samsung.com". */
  domain: text("domain").notNull(),
  /** Optional host filter prefix, e.g. "www.samsung.com/uk". */
  hostFilter: text("host_filter"),
  /** JSON-serialised CrawlBudget — see types.ts. */
  budgetJson: text("budget_json").notNull(),
  /** "active" | "paused" | "deleted" */
  trackingStatus: text("tracking_status").notNull().default("active"),
  addedAt: integer("added_at").notNull(),
  lastCrawledAt: integer("last_crawled_at"),
  coverageJson: text("coverage_json"), // CDX coverage-bar summary, cached forever
});

// ── 4. Ingest jobs (one per domain+month crawl) ──────────────────────────────

export const ingests = sqliteTable(
  "ingests",
  {
    id: text("id").primaryKey(), // ulid
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** "YYYY-MM" */
    month: text("month").notNull(),
    /** queued | surveying | fetching | rewriting | ready | partial | failed */
    status: text("status").notNull().default("queued"),
    pagesTotal: integer("pages_total").notNull().default(0),
    pagesDone: integer("pages_done").notNull().default(0),
    assetsTotal: integer("assets_total").notNull().default(0),
    assetsDone: integer("assets_done").notNull().default(0),
    bytesStored: integer("bytes_stored").notNull().default(0),
    /** Budget actually in force (snapshot of domain.budgetJson at job start). */
    budgetJson: text("budget_json"),
    ia429Count: integer("ia_429_count").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    /** Queue message ID for cancellation / deduplication. */
    queueMsgId: text("queue_msg_id"),
  },
  (t) => [
    uniqueIndex("ingests_domain_month").on(t.domainId, t.month),
    index("ingests_status").on(t.status),
  ],
);

// ── 5. Snapshot ledger (one row per original-URL × chosen-day) ───────────────
// Kept forever for navigation UX even after R2 content is deleted.

export const snapshots = sqliteTable(
  "snapshots",
  {
    /** sha256(domain + '|' + url + '|' + day)[0:32] */
    id: text("id").primaryKey(),
    ingestId: text("ingest_id")
      .notNull()
      .references(() => ingests.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    /** Original absolute URL. */
    url: text("url").notNull(),
    /** "YYYY-MM-DD" — the chosen day from the CDX survey. */
    day: text("day").notNull(),
    /** 14-digit Wayback timestamp of the chosen capture. */
    ts: text("ts").notNull(),
    statusCode: integer("status_code").notNull(),
    mime: text("mime").notNull(),
    digest: text("digest"), // CDX sha1 digest
    bytes: integer("bytes"),
    /** R2 key for the rewritten HTML — nulled after deletion. */
    r2Key: text("r2_key"),
    /** Human-readable path used by the viewer route. */
    pageId: text("page_id"),
    /** Nearest-capture resolution: actual day served if ≠ requested day. */
    resolvedDay: text("resolved_day"),
    resolvedTs: text("resolved_ts"),
    deltaDays: integer("delta_days"),
    /** unix seconds; set once the viewer Worker has served this page. */
    servedAt: integer("served_at"),
    /** unix seconds; set once R2 content has been purged post-serve. */
    purgedAt: integer("purged_at"),
  },
  (t) => [
    index("snapshots_domain_day").on(t.domain, t.day),
    index("snapshots_ingest").on(t.ingestId),
    index("snapshots_purge").on(t.servedAt, t.purgedAt), // purge-queue scan
  ],
);

// ── 6. Asset registry (content-addressed, shared across domains/months) ───────

export const assets = sqliteTable("assets", {
  /** sha256 hex of the raw bytes. */
  hash: text("hash").primaryKey(),
  mime: text("mime").notNull(),
  bytes: integer("bytes").notNull(),
  r2Key: text("r2_key").notNull(),
  firstSeenAt: integer("first_seen_at").notNull(),
  /** How many snapshot rows reference this asset. */
  refCount: integer("ref_count").notNull().default(1),
  /** Nulled after R2 deletion; row kept for refCount tracking. */
  r2DeletedAt: integer("r2_deleted_at"),
});

// ── 7. Link resolution (internal nav cross-reference) ────────────────────────

export const linkResolutions = sqliteTable(
  "link_resolutions",
  {
    id: text("id").primaryKey(), // ulid
    domain: text("domain").notNull(),
    /** "YYYY-MM-DD" of the source snapshot. */
    day: text("day").notNull(),
    fromUrl: text("from_url").notNull(),
    toUrl: text("to_url").notNull(),
    /** "internal" | "external" | "cross-host" */
    kind: text("kind").notNull(),
    /** Day actually resolved (same or nearest). */
    resolvedDay: text("resolved_day"),
    resolvedTs: text("resolved_ts"),
    deltaDays: integer("delta_days"),
  },
  (t) => [
    index("link_res_domain_day").on(t.domain, t.day),
    uniqueIndex("link_res_unique").on(t.domain, t.day, t.fromUrl, t.toUrl),
  ],
);

// ── 8. CDX survey cache (immutable — history never changes) ──────────────────

export const cdxSurveys = sqliteTable(
  "cdx_surveys",
  {
    id: text("id").primaryKey(), // ulid
    domain: text("domain").notNull(),
    month: text("month").notNull(),
    /** sha256 of the CDX query params — differentiates host/domain matchType etc. */
    queryHash: text("query_hash").notNull(),
    /** Gzip-compressed JSON bytes from CDX. */
    payload: blob("payload").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [
    uniqueIndex("cdx_survey_unique").on(t.domain, t.month, t.queryHash),
  ],
);

// ── 9. Usage ledger (cost attribution + guardrail counters) ──────────────────

export const usageLedger = sqliteTable(
  "usage_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    domain: text("domain"),
    month: text("month"),
    /** ia_fetch | r2_put | r2_get | r2_delete | bytes_stored | bytes_served | worker_cpu_ms */
    kind: text("kind").notNull(),
    value: integer("value").notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (t) => [index("usage_domain_month").on(t.domain, t.month)],
);
