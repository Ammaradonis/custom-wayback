/**
 * The backup plan: which D1 tables are mirrored into Supabase, and how.
 *
 * ## Why this exists at all
 *
 * D1 is the authoritative ledger, and the free plan is not unbounded — row reads,
 * row writes and storage all have daily ceilings, and when one is crossed the
 * *writes* start failing, which is exactly the failure a crawl cannot tolerate.
 * Supabase (Postgres) is the second copy: a place the ledger already exists by
 * the time D1 stops accepting new rows, so nothing crawled is ever lost to a
 * quota.
 *
 * This file is deliberately the only place that knows the shape of the mirror.
 * The DDL lives in `supabase/migrations/`, but the *contract* — table, columns,
 * types, primary key, incremental cursor — lives here, so the Worker's syncer,
 * the management CLI and the drift check all read from one definition and cannot
 * disagree about what "fully backed up" means.
 *
 * ## The incremental model
 *
 * There is no change-data-capture and no triggers. Each table gets a **watermark
 * column**: a value that is monotonically non-decreasing as that table's rows are
 * written or updated. The mirror stores the highest watermark it has copied, and
 * the next run asks D1 for everything at or above it:
 *
 *     SELECT … WHERE wm >= :cursor AND wm IS NOT NULL
 *     ORDER BY wm ASC LIMIT :n
 *
 * Re-reading the boundary value is intentional. Delivery is at-least-once, so a
 * crash between "pushed to Postgres" and "recorded the new cursor" costs a
 * repeated upsert rather than a lost row. The primary key makes the repeat
 * idempotent, so at-least-once is free and exactly-once would not be.
 *
 * The window-function form in `d1ReadSql` exists so a *single* watermark value
 * shared by more rows than one batch cannot wedge the cursor: it takes the whole
 * value or none of it, then the next run asks for strictly-greater.
 *
 * ## What is deliberately not mirrored
 *
 * `snapshot_fts` is an FTS5 virtual table — a SQLite-specific index, not data.
 * Its contents are derivable from the page text that `search_docs` already
 * records, so the mirror carries `search_docs` and does not carry the index. That
 * is why the plan is a superset of the DDL rather than a mirror of `sqlite_master`:
 * a table is only restorable if a human said what its cursor is.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Aliases for the two cursor columns `d1ReadSql` projects.
 *
 * Underscore-prefixed and absent from every plan, so they cannot collide with a real
 * column and cannot be mistaken for one when reading a row back. Declared here so a
 * rename in the query and a rename in the reader cannot drift apart silently — the
 * failure mode would be a cursor stuck at `undefined`, not a type error.
 */
export const WATERMARK_FIELD = "__wm" as const;
/** The watermark of the batch's last row: the next cursor. */
export const MORE_FIELD = "__more" as const;
/** The batch boundary watermark value — the watermark of the `n`-th row in key order. */
export const BOUND_FIELD = "__bound" as const;

/** The small set of storage classes this tool actually uses. */
export type SqliteType = "TEXT" | "INTEGER" | "BOOLEAN" | "BLOB";

/** Their Postgres counterparts. `INTEGER` is widened to `BIGINT` on purpose. */
export type PostgresType = "text" | "bigint" | "smallint" | "boolean" | "bytea";

export interface ColumnPlan {
  /** Column name, identical in both databases. */
  name: string;
  sqliteType: SqliteType;
  postgresType: PostgresType;
  /**
   * True when this column participates in the mirror's primary key — i.e. the
   * `on_conflict` target for an upsert. Must match the Postgres DDL exactly, or
   * every push fails with `42P10: no unique or exclusion constraint matching`.
   */
  key: boolean;
}

export interface TablePlan {
  /** Table name, identical in both databases. */
  name: string;
  columns: ColumnPlan[];
  /**
   * SQL expression over this table's own columns producing the incremental
   * cursor. Either a bare column or a `COALESCE(a, b, …)`. Validated by
   * `assertWatermark`, because it is interpolated into the read query.
   */
  watermarkSql: string;
  /**
   * When true, rows whose watermark is NULL are not backed up. Use it when a NULL
   * means "this row has no position in the ordering at all" (an unset ULID,
   * say) rather than "not yet updated" — a NULL cursor would otherwise pin the
   * table at the same place forever.
   */
  watermarkNotNull?: boolean;
  /**
   * False when the row is derived and rebuildable, so the mirror can drop it and
   * still be a complete record of what was crawled. Surfaced in `/v1/backup/status`
   * and in the docs rather than silently omitted.
   */
  restorable: boolean;
  /** Why this table is (or is not) included, quoted in the status payload. */
  note: string;
  /** Human-readable row noun for progress messages. */
  unit: string;
}

// ── Column helpers ────────────────────────────────────────────────────────────

const t = (name: string, key = false): ColumnPlan => ({
  name,
  sqliteType: "TEXT",
  postgresType: "text",
  key,
});
const i = (name: string, key = false): ColumnPlan => ({
  name,
  sqliteType: "INTEGER",
  postgresType: "bigint",
  key,
});
const b = (name: string): ColumnPlan => ({
  name,
  sqliteType: "BOOLEAN",
  postgresType: "boolean",
  key: false,
});
const blob = (name: string): ColumnPlan => ({
  name,
  sqliteType: "BLOB",
  postgresType: "bytea",
  key: false,
});

// ── The plan ──────────────────────────────────────────────────────────────────
//
// Ordered parents-first. The order matters only cosmetically (status listing and
// log output); the push itself carries no foreign keys, so a restored database is
// loaded in this order and checked afterwards.

export const BACKUP_TABLES: readonly TablePlan[] = [
  {
    name: "users",
    unit: "accounts",
    restorable: true,
    note: "Account rows, password hashes included — without them a restore cannot log anyone in.",
    // `created_at` never changes, so `last_login_at` and `disabled` edits wait for
    // the next row that touches this user. Both are convenience state; the mirror
    // is a recovery source, not a replica.
    watermarkSql: "created_at",
    columns: [
      t("id", true),
      t("email"),
      t("password_hash"),
      i("created_at"),
      i("last_login_at"),
      b("disabled"),
    ],
  },
  {
    name: "sessions",
    unit: "sessions",
    restorable: true,
    note: "Live sessions; expiry and revocation both move the watermark, so a revoked token is mirrored as revoked.",
    watermarkSql: "COALESCE(revoked_at, expires_at, issued_at)",
    columns: [
      t("id", true),
      t("user_id"),
      i("issued_at"),
      i("expires_at"),
      i("revoked_at"),
      t("user_agent"),
      t("ip_hash"),
    ],
  },
  {
    name: "domains",
    unit: "domains",
    restorable: true,
    note: "Tracked domains, their crawl budgets and cached coverage summaries.",
    watermarkSql: "COALESCE(last_crawled_at, added_at)",
    columns: [
      t("id", true),
      t("user_id"),
      t("domain"),
      t("host_filter"),
      t("budget_json"),
      t("tracking_status"),
      i("added_at"),
      i("last_crawled_at"),
      t("coverage_json"),
    ],
  },
  {
    name: "ingests",
    unit: "jobs",
    restorable: true,
    note: "One row per domain-month crawl, with the frozen work plan a resume needs.",
    // `finished_at` is the last thing set, so it is the highest value a row ever
    // reaches; progress counters ride along with it.
    watermarkSql: "COALESCE(finished_at, started_at, 0)",
    columns: [
      t("id", true),
      t("domain_id"),
      t("month"),
      t("status"),
      i("pages_total"),
      i("pages_done"),
      i("assets_total"),
      i("assets_done"),
      i("bytes_stored"),
      t("budget_json"),
      i("ia_429_count"),
      t("error_message"),
      i("started_at"),
      i("finished_at"),
      t("queue_msg_id"),
      t("stage"),
      i("cursor"),
      t("pages_json"),
      t("assets_json"),
      i("asset_cursor"),
      t("degraded_reason"),
      t("day_index_json"),
      i("lease_until"),
      i("attempts"),
      i("stage_attempts"),
      i("consecutive_429"),
      i("breaker_open_until"),
      i("last_throttle_at"),
    ],
  },
  {
    name: "snapshots",
    unit: "pages",
    restorable: true,
    note: "The snapshot ledger: which capture was chosen for which URL on which day. The single most expensive table to lose.",
    // Three life stages, each later than the last: inserted, served, purged. A
    // reader digest/title arrives with the serve, so nothing is stranded.
    watermarkSql: "COALESCE(purged_at, served_at, 0)",
    columns: [
      t("id", true),
      t("ingest_id"),
      t("domain"),
      t("url"),
      t("day"),
      t("ts"),
      i("status_code"),
      t("mime"),
      t("digest"),
      i("bytes"),
      t("r2_key"),
      t("page_id"),
      t("resolved_day"),
      t("resolved_ts"),
      i("delta_days"),
      i("served_at"),
      i("purged_at"),
      t("content_digest"),
      t("title"),
    ],
  },
  {
    name: "assets",
    unit: "assets",
    restorable: true,
    note: "Content-addressed asset registry; the bytes stay in R2 and only the hash index is mirrored.",
    watermarkSql: "COALESCE(r2_deleted_at, first_seen_at)",
    columns: [
      t("hash", true),
      t("mime"),
      i("bytes"),
      t("r2_key"),
      i("first_seen_at"),
      i("ref_count"),
      i("r2_deleted_at"),
    ],
  },
  {
    name: "link_resolutions",
    unit: "links",
    restorable: true,
    note: "Nearest-capture link resolutions — what makes navigation inside a month feel unbroken.",
    // ULIDs are time-sortable, so the primary key is itself a cursor. The
    // predicate is covered by the primary-key index and is only evaluated for
    // rows at or after the last-synced ULID.
    watermarkSql: "id",
    watermarkNotNull: true,
    columns: [
      t("id", true),
      t("domain"),
      t("day"),
      t("from_url"),
      t("to_url"),
      t("kind"),
      t("resolved_day"),
      t("resolved_ts"),
      i("delta_days"),
    ],
  },
  {
    name: "cdx_surveys",
    unit: "surveys",
    restorable: true,
    note: "Gzipped CDX survey payloads. Re-fetchable from archive.org in principle, which is exactly why re-fetching them is worth avoiding.",
    watermarkSql: "fetched_at",
    columns: [
      t("id", true),
      t("domain"),
      t("month"),
      t("query_hash"),
      blob("payload"),
      i("fetched_at"),
    ],
  },
  {
    name: "usage_ledger",
    unit: "usage rows",
    restorable: true,
    note: "Append-only cost attribution. Mirrored so spend can be reconstructed after a restore.",
    watermarkSql: "id",
    watermarkNotNull: true,
    columns: [
      i("id", true),
      t("domain"),
      t("month"),
      t("kind"),
      i("value"),
      i("recorded_at"),
    ],
  },
  {
    name: "throttle_events",
    unit: "throttle events",
    restorable: true,
    note: "Append-only throttling telemetry — the evidence trail for how archive.org treated us.",
    watermarkSql: "id",
    watermarkNotNull: true,
    columns: [
      i("id", true),
      t("domain"),
      t("month"),
      t("ingest_id"),
      t("host"),
      i("status"),
      i("wait_ms"),
      i("attempt"),
      b("breaker_open"),
      t("kind"),
      i("created_at"),
    ],
  },
  {
    name: "rate_limits",
    unit: "windows",
    restorable: false,
    note: "Ephemeral request counters, pruned hourly. Mirrored because it holds the backup's own lease; losing it merely re-opens one window on restore.",
    watermarkSql: "window_start",
    watermarkNotNull: true,
    columns: [
      t("bucket", true),
      i("window_start", true),
      i("count"),
      i("updated_at"),
    ],
  },
  {
    name: "search_docs",
    unit: "indexed pages",
    restorable: false,
    note: "Extracted page text for full-text search. Rebuildable from R2 by re-indexing, so a restore can omit it and re-crawl instead.",
    watermarkSql: "indexed_at",
    columns: [
      t("snapshot_id", true),
      t("domain"),
      t("url"),
      t("day"),
      t("title"),
      i("bytes"),
      i("indexed_at"),
    ],
  },
  {
    name: "share_links",
    unit: "share links",
    restorable: true,
    note: "Hashed share capabilities and their view counters.",
    watermarkSql: "COALESCE(last_viewed_at, created_at)",
    columns: [
      t("id", true),
      t("user_id"),
      t("token_hash"),
      t("domain"),
      t("month"),
      t("day"),
      t("url"),
      t("label"),
      i("created_at"),
      i("expires_at"),
      i("revoked_at"),
      i("view_count"),
      i("last_viewed_at"),
    ],
  },
  {
    name: "exports",
    unit: "exports",
    restorable: true,
    note: "Static-bundle export bookkeeping. The ZIPs themselves live in R2 and are not mirrored.",
    watermarkSql: "COALESCE(finished_at, created_at)",
    columns: [
      t("id", true),
      t("user_id"),
      t("domain"),
      t("month"),
      t("r2_key"),
      i("bytes"),
      i("pages"),
      i("assets"),
      i("missing"),
      t("status"),
      t("error_message"),
      i("created_at"),
      i("finished_at"),
    ],
  },
] as const;

/** Fast lookup by name. */
export const BACKUP_TABLE_BY_NAME: ReadonlyMap<string, TablePlan> = new Map(
  BACKUP_TABLES.map((p) => [p.name, p]),
);

/** Tables the operator must be able to see are present, in dependency order. */
export const BACKUP_TABLE_NAMES: readonly string[] = BACKUP_TABLES.map((p) => p.name);

// ── Watermark validation ──────────────────────────────────────────────────────

const IDENTIFIER = "[A-Za-z_][A-Za-z0-9_]*";

/**
 * The two shapes a watermark expression may take: a bare column, or a COALESCE of
 * columns and integer literals. Anything else is a programming error and is
 * rejected rather than interpolated.
 */
const WATERMARK_BARE = new RegExp(`^${IDENTIFIER}$`);
const WATERMARK_COALESCE = new RegExp(
  `^COALESCE\\((?:${IDENTIFIER}|-?[0-9]+)(?:,\\s*(?:${IDENTIFIER}|-?[0-9]+))*\\)$`,
);

/** Column names referenced by a watermark expression, for the drift check. */
export function watermarkColumns(watermarkSql: string): string[] {
  const inner = watermarkSql.startsWith("COALESCE(")
    ? watermarkSql.slice("COALESCE(".length, -1)
    : watermarkSql;
  return inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^-?[0-9]+$/.test(part) === false);
}

/**
 * Throws unless `watermarkSql` is one of the two permitted shapes **and** every
 * column it names exists in `columns`.
 *
 * This runs at sync start, not at module load, so a plan mistake surfaces as a
 * named error in `/v1/backup/status` rather than as a Worker that will not boot.
 */
export function assertWatermark(plan: TablePlan): void {
  const expr = plan.watermarkSql;
  if (!WATERMARK_BARE.test(expr) && !WATERMARK_COALESCE.test(expr)) {
    throw new Error(
      `backup plan for "${plan.name}": watermark "${expr}" is neither a column nor a COALESCE of columns`,
    );
  }
  const known = new Set(plan.columns.map((c) => c.name));
  for (const col of watermarkColumns(expr)) {
    if (!known.has(col)) {
      throw new Error(
        `backup plan for "${plan.name}": watermark references unknown column "${col}"`,
      );
    }
  }
}

/** The `on_conflict` target for an upsert, or null when the table has no key. */
export function conflictTarget(plan: TablePlan): string | null {
  const keys = plan.columns.filter((c) => c.key).map((c) => c.name);
  return keys.length > 0 ? keys.join(",") : null;
}

/** Column names in declaration order — the shape of every pushed JSON object. */
export function columnNames(plan: TablePlan): string[] {
  return plan.columns.map((c) => c.name);
}

// ── Read query ────────────────────────────────────────────────────────────────

/**
 * Build the D1 read for one batch.
 *
 * ## Why this is not `WHERE wm >= ? ORDER BY wm LIMIT n`
 *
 * Because a watermark is not unique. `snapshots`' watermark is
 * `COALESCE(purged_at, served_at, 0)`, so every page in an ingest that has been
 * neither served nor purged shares the value `0`. With a plain `LIMIT`, a page of
 * rows carrying one watermark value would be returned again on every run, the
 * cursor would advance to that same value, and the table would repeat those `n`
 * rows forever while the rest of it was never copied.
 *
 * ## The two cursor values
 *
 * The statement returns, alongside the planned columns:
 *
 *   * `__wm` — this row's watermark: the next cursor, taken from the last row.
 *   * `__more` — the highest watermark **after** the batch boundary, or NULL when
 *     there is none: the statement's own answer to "was that everything?".
 *
 * `__bound` is the boundary itself — the watermark of the row exactly `n` places
 * into the pending set, in key order:
 *
 *     COALESCE(
 *       (SELECT s.wm FROM t s WHERE s.wm >= :c ORDER BY s.k ASC LIMIT 1 OFFSET n-1),
 *       (SELECT MAX(s9.wm) FROM t s9 WHERE s9.wm >= :c)
 *     )
 *
 * The `COALESCE` is load-bearing rather than defensive: with fewer than `n` rows
 * pending, the `OFFSET` lookup finds nothing and a NULL boundary would make
 * `__wm <= NULL` false for every row, so the whole table would silently stop
 * syncing. Falling back to `MAX` says "the boundary is the last row there is",
 * which is exactly right when there are fewer than `n` of them.
 *
 * Keeping `__wm <= __bound` then takes every row at or below that value. Values are
 * never split, because the bound *is* one of the values present: when a value
 * straddles the boundary, all of it comes back and the batch runs slightly over `n`.
 * That is a bounded loss of tidiness in exchange for never dropping a row.
 *
 * `__more` is the lookahead that keeps the cursor moving:
 *
 *     (SELECT MAX(s3.wm) FROM t s3 WHERE s3.wm >= :c AND s3.wm > :bound)
 *
 * Three shapes of this were wrong before this one, and each looked correct. They are
 * recorded because they are the obvious things to write:
 *
 *   * the *smallest* watermark in the batch (`MIN(wm) OVER ()`) — describes where the
 *     batch starts, not where it ends, so the cursor never advanced;
 *   * the *largest* (`MAX(wm) OVER ()`) compared with `__wm < __max` — when every
 *     pending row shares one value, `__max` equals it, and the batch was sliced;
 *   * using the batch size as the frame (`MAX(wm) OVER (… n PRECEDING …)`) — reports
 *     "more" even when the boundary is the last row, so the same page was re-read and
 *     re-pushed indefinitely. With seven rows at one watermark and a batch of three,
 *     it pushed seventy rows instead of seven.
 *
 * ## Ordering by the key, not by the watermark
 *
 * The boundary has to land in the same place on a re-run, and a watermark has ties by
 * design, so ties would order arbitrarily. The primary key is unique, so "the `n`-th
 * row" means the same thing twice.
 *
 * Only identifier-shaped pieces (table, columns, key, watermark expression) come from
 * the plan, and `assertWatermark` plus the fixed identifier grammar is what makes that
 * interpolation safe. The cursor is always bound, never interpolated.
 */
export function d1ReadSql(
  plan: TablePlan,
  batchSize: number,
  options: { strict?: boolean } = {},
): string {
  assertWatermark(plan);
  const cols = columnNames(plan).join(", ");
  const wm = plan.watermarkSql;
  const notNull = plan.watermarkNotNull ? ` AND ${wm} IS NOT NULL` : "";
  const keyColumns = plan.columns.filter((c) => c.key).map((c) => c.name);

  /**
   * `>` for every page after the first, `>=` for the first page of a run.
   *
   * ## Why the first page is inclusive and the rest are not
   *
   * The inclusive bound is the at-least-once guarantee: a run that died between
   * pushing a batch and recording its cursor re-reads that batch on the next run, so a
   * lost response costs a repeated upsert rather than a lost row. The primary key makes
   * the repeat harmless.
   *
   * Inside one run, though, inclusive is a *livelock*. The cursor is advanced to the
   * batch boundary, and the boundary is the watermark of the batch's last row — so the
   * next read with `>=` sees the same boundary value again, computes the same boundary,
   * and returns the same rows. With seven rows sharing a watermark and a batch of three,
   * that re-pushed all seven rows on every one of the ten permitted pages: 70 rows
   * instead of 7. The generic form of the bug is "a page whose boundary is shared by
   * more rows than fit in a batch never advances", which is precisely the case the
   * boundary logic exists to handle.
   *
   * So once a page has been committed, the next read asks for strictly greater, and the
   * value just copied is not revisited. Every placeholder in the statement uses the same
   * operator, because `d1ReadParams` supplies the same cursor to all of them.
   */
  const cmp = options.strict ? '>' : '>=';

  // `__wm` is projected alongside the planned columns so the caller can take the
  // batch's highest watermark as the next cursor without re-deriving which column
  // the expression was built from. It is dropped before the row is pushed —
  // `toPostgrestRow` only copies planned columns — so it never reaches PostgREST.
  if (keyColumns.length === 0) {
    // No primary key means no stable boundary. Every table in the plan has a key —
    // the test suite asserts it — so this is a structural fallback for a plan edited
    // to add a keyless table, not a path any current table takes.
    return (
      `SELECT ${cols}, ${wm} AS ${WATERMARK_FIELD} FROM ${plan.name}` +
      ` WHERE ${wm} ${cmp} ?${notNull}` +
      ` ORDER BY ${wm} ASC LIMIT ${batchSize}`
    );
  }

  const order = keyColumns.join(", ");
  const offset = batchSize - 1;
  // ## The watermark expression is NOT prefixed with the table alias
  //
  // It looks like it should be — the subqueries alias the table as `s`, `s3`, `s4`,
  // `s9`, and prefixing a column reference is the usual way to be explicit. But the
  // watermark is very often an *expression*, not a column: `snapshots` uses
  // `COALESCE(purged_at, served_at, 0)`, `assets` uses
  // `COALESCE(r2_deleted_at, first_seen_at)`. So `s.${wm}` expands to
  //
  //     s.COALESCE(r2_deleted_at, first_seen_at)
  //
  // which is a syntax error in SQLite and took every COALESCE-watermarked table down
  // with `near "(": syntax error` — eight of the fourteen. The simple-column tables
  // (`id`, `window_start`, `created_at`) worked, which is exactly why the bug hid: the
  // first tests anyone writes use those.
  //
  // Unqualified references are correct and unambiguous here because each subquery has
  // exactly one table in its FROM. The distinct aliases remain, because they are what
  // keeps a nested subquery from resolving a column against the *outer* table — the
  // alias disambiguates the relation, not the column expression.
  const bound =
    `COALESCE(` +
    `(SELECT ${wm} FROM ${plan.name} s WHERE ${wm} ${cmp} ?` +
    ` ORDER BY ${wm} ASC LIMIT 1 OFFSET ${offset}),` +
    `(SELECT MAX(${wm}) FROM ${plan.name} s9 WHERE ${wm} ${cmp} ?)` +
    `)`;
  const more =
    `(SELECT MAX(${wm}) FROM ${plan.name} s3` +
    ` WHERE ${wm} >= ? AND ${wm} >` +
    ` (SELECT ${wm} FROM ${plan.name} s4 WHERE ${wm} ${cmp} ?` +
    ` ORDER BY ${wm} ASC LIMIT 1 OFFSET ${offset}))`;

  return (
    `SELECT ${cols}, ${wm} AS ${WATERMARK_FIELD}, ${bound} AS ${BOUND_FIELD}, ${more} AS ${MORE_FIELD}` +
    ` FROM ${plan.name}` +
    ` WHERE ${wm} ${cmp} ?${notNull}` +
    ` AND ${wm} <= ${bound}` +
    ` ORDER BY ${order} ASC`
  );
}

/**
 * How many parameters `d1ReadSql` declares, and therefore how many must be bound.
 *
 * Counted from the generated statement rather than asserted, because the number is a
 * consequence of how the boundary is expressed and has already changed once. What
 * matters is not the number but that it is never *guessed*: a placeholder left unbound
 * is NULL in SQLite, `wm >= NULL` matches nothing, and the table would silently stop
 * syncing while every run reported success.
 */
export function d1ReadParamCount(plan: TablePlan): number {
  assertWatermark(plan);
  return (d1ReadSql(plan, 1).match(/\?/g) ?? []).length;
}

/**
 * Coerce a stored cursor into the value SQLite should compare against.
 *
 * ## Why this is not "just pass the string"
 *
 * A cursor is persisted as text (it may be an integer, a date, or a ULID), so it comes
 * back out of `backup_state` as a string. Binding that string into
 * `WHERE watermark >= ?` is wrong for every numeric watermark, and wrong silently:
 *
 *   * SQLite compares values of different storage classes by *class order* — NULL,
 *     then INTEGER/REAL, then TEXT, then BLOB. So `1000 >= '0'` is **false**, because
 *     every integer sorts before every string.
 *   * The result is a range predicate that matches nothing at all: every
 *     integer-watermarked table reads zero rows, syncs nothing, and reports success.
 *
 * A hand-written fake that compared with JavaScript's `<` never saw it, because
 * `1000 >= "0"` is true there. Real SQLite disagrees, and real SQLite is what runs.
 *
 * So a cursor that looks like a number is bound as one, and anything else (a ULID, a
 * date string) stays text — which is the correct affinity for those columns.
 */
export function coerceCursor(cursor: string): string | number {
  if (cursor === "") return cursor;
  const asNumber = Number(cursor);
  return Number.isFinite(asNumber) && String(asNumber) === cursor.trim() ? asNumber : cursor;
}

/**
 * The values to bind, in order, for a given cursor.
 *
 * Every placeholder takes the same cursor: the range predicate selects rows at or
 * above it, and the boundary and lookahead subqueries must measure that same set —
 * otherwise the batch would be sized against rows the predicate had already excluded.
 */
export function d1ReadParams(plan: TablePlan, cursor: string): (string | number)[] {
  const value = coerceCursor(cursor);
  return Array.from({ length: d1ReadParamCount(plan) }, () => value);
}

/**
 * Query for the highest watermark currently stored, used to decide whether a
 * table has anything new before spending a round trip on it. `MAX` over an
 * expression is a scan, but for every table in this plan the expression's leading
 * term is the primary key or an indexed column.
 */
export function d1HighWaterSql(plan: TablePlan): string {
  assertWatermark(plan);
  const notNull = plan.watermarkNotNull ? ` WHERE ${plan.watermarkSql} IS NOT NULL` : "";
  return `SELECT MAX(${plan.watermarkSql}) AS wm FROM ${plan.name}${notNull}`;
}

/**
 * How many rows D1 holds that a given mirror cursor does not yet cover.
 *
 * This is the number that turns "the backup is running" into "the backup is 4,120
 * rows behind", which is the difference between a reassuring dashboard and a
 * misleading one. It is a `COUNT(*)` over a range, so it is cheap on every table
 * here — each one's watermark leads with its primary key or an indexed column.
 *
 * The predicate depends on whether a cursor exists, so the query does too:
 *
 *   * **No cursor** (the table has never been mirrored) counts *every* row,
 *     including rows whose watermark is NULL. Reporting "0 pending" for a table
 *     that has never been copied is exactly the bug this function exists to
 *     prevent, and a range predicate with a NULL bound would do it.
 *   * **A cursor** counts rows at or above it that are also comparable to it, so
 *     a NULL watermark cannot make `COUNT(*)` disagree with what the syncer will
 *     actually read.
 */
export function d1PendingCountSql(plan: TablePlan, hasCursor: boolean): string {
  assertWatermark(plan);
  const wm = plan.watermarkSql;

  if (!hasCursor) {
    return `SELECT COUNT(*) AS n FROM ${plan.name}`;
  }

  // `COALESCE` and not the bare expression: a null watermark compares to nothing,
  // so `wm >= ?` would silently exclude the row and under-report what is pending.
  //
  // Strictly greater, because a cursor means "everything at or below this has been
  // pushed". The *read* is inclusive on its first page (at-least-once), but that
  // re-read is an implementation detail — reporting the boundary row as permanently
  // "pending" would show a backlog that never drains.
  return `SELECT COUNT(*) AS n FROM ${plan.name} WHERE COALESCE(${wm}, 0) > ?`;
}

// ── Value mapping ─────────────────────────────────────────────────────────────

/** A row as it comes out of D1, or as it goes into PostgREST. */
export type BackupRow = Record<string, unknown>;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Standard base64 of a byte array.
 *
 * Hand-rolled rather than `btoa`, and that is a deliberate choice about this
 * package's boundaries: `packages/shared` compiles against `lib: ["ES2022"]` with
 * no DOM and no `@types/node`, because it runs unchanged in a Worker, in Node and
 * in any future runtime (see the package README note on "standard globals only").
 * `btoa` is present in all of those today, but it is a *host* global — adding
 * `"DOM"` to this package's `lib` to reach one function would let DOM types leak
 * into code that must not depend on them, and the leak would only be discovered
 * the first time something here touched `document`.
 *
 * The input is bounded by `chunkRows`' byte budget, so this is a table lookup per
 * three bytes and not a hot path.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      BASE64_ALPHABET[n & 63]!;
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i]! << 16;
    out += BASE64_ALPHABET[(n >> 18) & 63]! + BASE64_ALPHABET[(n >> 12) & 63]! + "==";
  } else if (remaining === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      "=";
  }

  return out;
}

/**
 * Convert one D1 value to the JSON form PostgREST expects.
 *
 * D1 hands back BLOBs as `ArrayBuffer` and Postgres `bytea` over PostgREST is
 * base64 `text`, so that is the one conversion that genuinely has to happen.
 * Booleans arrive as `0`/`1` — because that is what SQLite stored when the DDL
 * said `DEFAULT false` — and must become real JSON booleans or Postgres rejects
 * them for a `boolean` column. Integers are deliberately *not* coerced: D1 already
 * returns numbers, and `Number(veryLargeInt)` would quietly round anything past
 * 2^53 where passing the original through lets Postgres reject it loudly.
 */
export function toPostgrestValue(column: ColumnPlan, value: unknown): unknown {
  if (value === null || value === undefined) return null;

  switch (column.postgresType) {
    case "boolean": {
      if (typeof value === "boolean") return value;
      return value === 1 || value === "1" || value === "true";
    }
    case "bytea": {
      if (typeof value === "string") return value; // already base64
      if (value instanceof ArrayBuffer) return toBase64(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) {
        return toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      }
      throw new Error(`column "${column.name}": cannot encode ${typeof value} as bytea`);
    }
    default:
      return value;
  }
}

/** Map a whole D1 row into the pushed JSON object. */
export function toPostgrestRow(plan: TablePlan, row: BackupRow): BackupRow {
  const out: BackupRow = {};
  for (const column of plan.columns) {
    out[column.name] = toPostgrestValue(column, row[column.name]);
  }
  return out;
}

// ── Batching ──────────────────────────────────────────────────────────────────

export interface BatchOptions {
  /** Hard cap on rows per HTTP request, whatever their size. */
  maxRows: number;
  /** Cap on the serialised body, chosen to stay inside Worker egress limits. */
  maxBytes: number;
}

/**
 * Split rows into request-sized chunks.
 *
 * PostgREST takes the body as a URL-encoded query *and* a JSON payload; both are
 * subject to the platform's own limits, and a single `search_docs` row can carry
 * a whole page of text. Size-bounded batching is therefore not an optimisation —
 * a fixed row count would work perfectly until the first large page and then fail
 * the whole run.
 *
 * A row larger than `maxBytes` is emitted alone rather than dropped: silently
 * skipping it would be the one outcome a backup must never have.
 */
export function chunkRows(rows: readonly BackupRow[], options: BatchOptions): BackupRow[][] {
  const { maxRows, maxBytes } = options;
  if (rows.length === 0) return [];

  const batches: BackupRow[][] = [];
  let current: BackupRow[] = [];
  let currentBytes = 2; // the enclosing "[]"

  for (const row of rows) {
    // +1 for the separating comma.
    const size = JSON.stringify(row).length + 1;
    if (current.length > 0 && (current.length >= maxRows || currentBytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ── Drift detection ───────────────────────────────────────────────────────────

/** One row of `PRAGMA table_info(<table>)`. */
export interface D1ColumnInfo {
  name: string;
  type: string;
}

export interface DriftProblem {
  table: string;
  kind: "missing-table" | "missing-column" | "unexpected-column" | "type-mismatch";
  detail: string;
}

/**
 * Compare the plan against what D1 actually has.
 *
 * A backup that silently stops covering a column is worse than one that refuses
 * to run: it reports success while the thing it exists to protect goes
 * unprotected. So the syncer calls this first and reports drift instead of
 * syncing. The check is one `PRAGMA` per table — SQLite-only, so it lives in the
 * Worker/CLI layer and this function stays pure.
 *
 * `type` from `PRAGMA table_info` is the *declared* type, which for these tables
 * is what the migration wrote (`text`, `integer`, `blob`, and — for the two DDLs
 * that said `DEFAULT false` — `integer`, since Drizzle emits `integer` with a
 * boolean mode). It is compared case-insensitively, and `BOOLEAN` is accepted for
 * either `integer` or `boolean` so a future explicit boolean column does not have
 * to be a special case.
 */
export function diffAgainstD1(
  plans: readonly TablePlan[],
  actual: ReadonlyMap<string, D1ColumnInfo[]>,
): DriftProblem[] {
  const problems: DriftProblem[] = [];

  for (const plan of plans) {
    const live = actual.get(plan.name);
    if (!live) {
      problems.push({
        table: plan.name,
        kind: "missing-table",
        detail: `D1 has no table "${plan.name}"`,
      });
      continue;
    }

    const liveByName = new Map(live.map((c) => [c.name, c.type.toUpperCase()]));
    for (const column of plan.columns) {
      const liveType = liveByName.get(column.name);
      if (liveType === undefined) {
        problems.push({
          table: plan.name,
          kind: "missing-column",
          detail: `D1 table "${plan.name}" has no column "${column.name}"`,
        });
        continue;
      }
      const planType = column.sqliteType;
      const acceptsInteger = planType === "BOOLEAN" && liveType === "INTEGER";
      const acceptsText = planType === "TEXT" && liveType === "VARCHAR";
      if (liveType !== planType && !acceptsInteger && !acceptsText) {
        problems.push({
          table: plan.name,
          kind: "type-mismatch",
          detail: `"${plan.name}.${column.name}" is ${liveType} in D1 but ${planType} in the backup plan`,
        });
      }
      liveByName.delete(column.name);
    }

    // Columns D1 has that the plan does not. Not fatal on its own — a virtual
    // table's shadow columns, or a column added by a migration the plan has not
    // caught up with — but exactly the signal that a new column would otherwise
    // never be backed up.
    for (const extra of liveByName.keys()) {
      problems.push({
        table: plan.name,
        kind: "unexpected-column",
        detail: `D1 table "${plan.name}" has column "${extra}" that the backup plan does not carry`,
      });
    }
  }

  return problems;
}

// ── Run defaults ──────────────────────────────────────────────────────────────

export const BACKUP_DEFAULTS = {
  /** Rows read from D1 per request. */
  readBatch: 200,
  /** Rows per PostgREST upsert. */
  pushBatch: 200,
  /** Serialised request-body ceiling, in bytes. */
  pushBytes: 262_144,
  /** Wall-clock ceiling for one run; the remainder waits for the next tick. */
  maxRuntimeMs: 20_000,
  /** Read/push pages per table per run. The next run continues from the cursor. */
  maxPagesPerTable: 10,
  /** Minimum seconds between automatic runs, whatever the cron interval is. */
  intervalSeconds: 900,
  /** Automatic runs per UTC day. A ceiling on our own Supabase traffic. */
  runsPerDay: 96,
  /** Lease held while a run is in flight, so two cron ticks cannot overlap. */
  leaseSeconds: 120,
  /** Attempts per batch before the table is left for the next run. */
  pushAttempts: 3,
} as const;

/** Bucket name for the backup's own run quota in `rate_limits`. */
export const BACKUP_QUOTA_BUCKET = "backup:global:runs";
/** Bucket name for the run lease in `rate_limits`. */
export const BACKUP_LEASE_BUCKET = "backup:global:lease";
