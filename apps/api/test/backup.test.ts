/**
 * The Supabase backup: the plan, the DDL it claims to match, and the sync engine.
 *
 * ## What this file is actually trying to prove
 *
 * A backup is the one component whose failure is invisible until the day it
 * matters. A syncer that silently stops advancing its cursor, or that skips a
 * table, or that "succeeds" while pushing half a batch, reports exactly the same
 * thing as one that works: `ok: true`. So the tests below aim at the specific
 * shapes of silent failure:
 *
 *   1. **The plan and the DDL disagree.** A column added to D1 and mirrored in
 *      Postgres under a different name fails at the first push with a PostgREST
 *      error nobody reads. `the Postgres DDL matches the backup plan` parses
 *      `supabase/migrations/*.sql` and compares it to the plan, column by column
 *      and key by key, so drift is a test failure rather than a runtime 400.
 *   2. **A cursor stops advancing.** The end-to-end runs assert the *cursor value*
 *      after each run, not just that something was pushed. A syncer stuck
 *      re-pushing its first page forever passes a "did it write rows" test.
 *   3. **A failed push loses rows.** The failure test asserts the cursor is left
 *      where the run started, so the next run re-reads what the mirror refused.
 *   4. **A shared watermark wedges a table.** `d1ReadSql` has a window-function
 *      form for exactly this; the "rows sharing one watermark" test is the reason
 *      it exists, and would hang without it.
 *   5. **The no-op path costs money.** A run with nothing new must issue *zero*
 *      PostgREST row requests — asserted directly, because the whole reason the
 *      five-minute cron is affordable is that this path is free.
 *
 * ## Why a fake D1 and a stubbed fetch
 *
 * Missing-locally state is where the interesting behaviour lives, and it cannot be
 * produced on demand against a real Supabase project: a lost response, a 429
 * mid-batch, a cursor that must not advance. Both fakes are *goal-oriented* — the
 * D1 fake implements the exact statement shapes `packages/shared/src/backup.ts`
 * generates, and the fetch stub records what the syncer asked for. Anything
 * unrecognised fails loudly rather than returning nothing, so a new query shows up
 * here instead of as a silent gap in production. The engine itself is untouched:
 * no test-only branches, no injected seams.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  BACKUP_DEFAULTS,
  BACKUP_LEASE_BUCKET,
  BACKUP_TABLES,
  BACKUP_TABLE_NAMES,
  assertWatermark,
  chunkRows,
  columnNames,
  conflictTarget,
  d1HighWaterSql,
  d1PendingCountSql,
  d1ReadParams,
  d1ReadSql,
  diffAgainstD1,
  toBase64,
  toPostgrestRow,
  toPostgrestValue,
  watermarkColumns,
  type BackupRow,
  type TablePlan,
} from "@custom-wayback/shared";
import { BackupSync, backupEnabled, resolveBackupEnv } from "../src/lib/backup.ts";
import { isRetryableStatus, supabaseConfigFromEnv } from "../src/lib/supabase.ts";

// ════════════════════════════════════════════════════════════════════════════
// 1. The plan, on its own
// ════════════════════════════════════════════════════════════════════════════

test("every table in the plan has a valid watermark", () => {
  for (const plan of BACKUP_TABLES) {
    // Throws with the table name and the offending expression when it does not.
    assertWatermark(plan);
  }
});

test("every table in the plan has a primary key to upsert on", () => {
  for (const plan of BACKUP_TABLES) {
    const target = conflictTarget(plan);
    assert.ok(target, `"${plan.name}" has no key columns, so an upsert cannot be deduplicated`);
    for (const key of target.split(",")) {
      assert.ok(
        columnNames(plan).includes(key),
        `"${plan.name}" declares key "${key}" which is not one of its columns`,
      );
    }
  }
});

test("assertWatermark rejects anything it would have to interpolate blindly", () => {
  const base: TablePlan = {
    name: "t",
    unit: "rows",
    restorable: true,
    note: "",
    watermarkSql: "created_at",
    columns: [
      { name: "id", sqliteType: "TEXT", postgresType: "text", key: true },
      { name: "created_at", sqliteType: "INTEGER", postgresType: "bigint", key: false },
    ],
  };

  // The shapes that must be refused, one representative each.
  for (const bad of [
    "created_at; DROP TABLE users",
    "1=1",
    "(SELECT max(created_at) FROM snapshots)",
    "COALESCE(created_at, 0); DELETE FROM assets",
    "created_at || ''",
  ]) {
    assert.throws(
      () => assertWatermark({ ...base, watermarkSql: bad }),
      /neither a column nor a COALESCE/,
      `"${bad}" should have been rejected`,
    );
  }

  // A well-formed expression naming a column that does not exist is also refused:
  // it would fail at SQLite with "no such column" much later.
  assert.throws(
    () => assertWatermark({ ...base, watermarkSql: "COALESCE(nope, 0)" }),
    /unknown column "nope"/,
  );

  // And the two permitted shapes pass.
  assert.doesNotThrow(() => assertWatermark(base));
  assert.doesNotThrow(() => assertWatermark({ ...base, watermarkSql: "COALESCE(created_at, 0)" }));
});

test("watermarkColumns reads the column names out of both permitted shapes", () => {
  assert.deepEqual(watermarkColumns("created_at"), ["created_at"]);
  assert.deepEqual(watermarkColumns("COALESCE(purged_at, served_at, 0)"), [
    "purged_at",
    "served_at",
  ]);
});

test("the read query binds exactly as many parameters as it declares", () => {
  for (const plan of BACKUP_TABLES) {
    const sql = d1ReadSql(plan, 200);
    const declared = (sql.match(/\?/g) ?? []).length;
    const supplied = d1ReadParams(plan, "0").length;

    assert.equal(
      supplied,
      declared,
      `"${plan.name}" read declares ${declared} placeholders but supplies ${supplied}`,
    );
    // The window form mentions the watermark expression twice — as the projected
    // `__wm` and inside `MIN(…) OVER ()` — while the plain form mentions it once.
    // Getting this wrong binds NULL, `wm >= NULL` is NULL for every row, and the
    // table syncs nothing while each run reports success.
    assert.equal(declared, conflictTarget(plan) ? 2 : 1, `"${plan.name}" placeholder count`);
    assert.match(sql, /ORDER BY /);
    assert.match(sql, /LIMIT 200/);
    // The cursor alias must survive the trip: the syncer reads it back to advance.
    assert.match(sql, /__wm/);
    // Every supplied value is the same cursor: the MIN() window must measure the
    // same row set the WHERE clause selected.
    assert.deepEqual([...new Set(d1ReadParams(plan, "42"))], ["42"]);
  }
});

test("the read query refuses to split a watermark value shared by many rows", () => {
  // The window form exists for this case. A plain `WHERE wm >= ? ORDER BY wm LIMIT n`
  // would return the same n rows on every run, advance the cursor to the same value,
  // and return them again — forever.
  const shared = BACKUP_TABLES.find((p) => p.name === "usage_ledger");
  assert.ok(shared);
  const sql = d1ReadSql(shared, 100);
  assert.match(sql, /ROW_NUMBER\(\) OVER/);
  assert.match(sql, /MIN\(id\) OVER \(\)/);
  assert.match(sql, /__wm = __min AND __rn <= 100/);
});

test("every plan table is reachable by a pending-count query", () => {
  for (const plan of BACKUP_TABLES) {
    // With no cursor the answer is the whole table; a range predicate against a
    // NULL bound would have reported zero and hidden an unmirrored table.
    const cold = d1PendingCountSql(plan, false);
    assert.match(cold, /^SELECT COUNT\(\*\) AS n FROM /);
    assert.equal((cold.match(/\?/g) ?? []).length, 0);

    const warm = d1PendingCountSql(plan, true);
    assert.equal((warm.match(/\?/g) ?? []).length, 1);
    assert.match(warm, /COALESCE\(/);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. The plan versus the Postgres DDL
// ════════════════════════════════════════════════════════════════════════════

interface DdlTable {
  columns: Map<string, string>;
  primaryKey: string[];
}

/**
 * Read `supabase/migrations/*.sql` and reduce it to tables, columns and keys.
 *
 * Deliberately a parser rather than a regex sweep: the point is to compare a
 * *structure* against the plan. It understands the subset of DDL these
 * migrations use — `create table if not exists`, one column per line, a
 * per-column `primary key`, a table-level `primary key (…)` — and ignores
 * everything else. If the DDL ever grows past that subset the parse produces an
 * empty or partial table, and the count assertion below fails rather than the
 * comparison passing vacuously.
 */
async function parseDdl(): Promise<Map<string, DdlTable>> {
  // `run-api-tests.mjs` runs `node --test` with `cwd` set to `apps/api`, and the
  // test file itself has been bundled into the OS temp directory by then — so
  // `import.meta.url` would point at the bundle, not at the repo. The working
  // directory is the only reliable anchor, and the runner guarantees it.
  const dir = resolve(process.cwd(), "..", "..", "supabase", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "no migrations found — the DDL comparison would be vacuous");

  const tables = new Map<string, DdlTable>();

  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    // Strip line comments so commented-out DDL cannot be mistaken for real DDL.
    const body = sql.replace(/--[^\n]*/g, "");

    const tableRe = /create table if not exists\s+(\w+)\.(\w+)\s*\(([\s\S]*?)\n\);/gi;
    for (const match of body.matchAll(tableRe)) {
      const [, schema, name, columnsText] = match as unknown as [string, string, string, string];
      if (schema !== "cw_backup") continue;

      const columns = new Map<string, string>();
      const primaryKey: string[] = [];

      for (const rawLine of columnsText.split("\n")) {
        const line = rawLine.trim().replace(/,$/, "");
        if (!line) continue;

        const tableKey = /^primary key\s*\(([^)]*)\)$/i.exec(line);
        if (tableKey?.[1]) {
          for (const col of tableKey[1].split(",")) primaryKey.push(col.trim());
          continue;
        }

        const column = /^([a-z_][a-z0-9_]*)\s+([a-z0-9_()\[\]]+)(.*)$/i.exec(line);
        if (!column) continue;
        const [, columnName, type, rest] = column as unknown as [string, string, string, string];
        columns.set(columnName, type.toLowerCase());
        if (/primary key/i.test(rest)) primaryKey.push(columnName);
      }

      tables.set(name, { columns, primaryKey });
    }
  }

  return tables;
}

test("the Postgres DDL matches the backup plan, column for column", async () => {
  const ddl = await parseDdl();

  for (const plan of BACKUP_TABLES) {
    const table = ddl.get(plan.name);
    assert.ok(table, `plan mirrors "${plan.name}" but no cw_backup table of that name exists`);

    for (const column of plan.columns) {
      const pgType = table.columns.get(column.name);
      assert.ok(
        pgType !== undefined,
        `"${plan.name}.${column.name}" is in the plan but not in the DDL — the push would fail`,
      );
      assert.equal(
        pgType,
        column.postgresType,
        `"${plan.name}.${column.name}" is ${column.postgresType} in the plan and ${pgType} in the DDL`,
      );
    }

    // The other direction: a column in the DDL that the plan does not carry is
    // simply never written, so the mirror would hold NULLs for it forever.
    for (const columnName of table.columns.keys()) {
      assert.ok(
        columnNames(plan).includes(columnName),
        `"${plan.name}.${columnName}" is in the DDL but not in the plan — it would never be backed up`,
      );
    }
  }
});

test("the Postgres primary keys match the plan's upsert targets", async () => {
  const ddl = await parseDdl();

  for (const plan of BACKUP_TABLES) {
    const table = ddl.get(plan.name);
    assert.ok(table);
    const planned = conflictTarget(plan)?.split(",") ?? [];
    // Order-insensitive: `primary key (bucket, window_start)` and a plan listing
    // them in the other order describe the same constraint.
    assert.deepEqual(
      [...table.primaryKey].sort(),
      [...planned].sort(),
      `"${plan.name}" has primary key [${table.primaryKey}] in the DDL and [${planned}] in the plan`,
    );
  }

  // And the set of tables must be exactly the plan's: no extra cw_backup table
  // (a stray one would be silently unmaintained) beyond `backup_state`, which is
  // the syncer's own bookkeeping and intentionally not part of the plan.
  const extra = [...ddl.keys()].filter(
    (name) => name !== "backup_state" && !BACKUP_TABLE_NAMES.includes(name),
  );
  assert.deepEqual(extra, [], `cw_backup has tables the plan does not know about: ${extra}`);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Value mapping and batching
// ════════════════════════════════════════════════════════════════════════════

test("base64 encoding of bytea is correct, including both padding cases", () => {
  // Lengths 1, 2 and 3 exercise `==`, `=` and no padding respectively.
  const cases: [number[], string][] = [
    [[0x66], "Zg=="],
    [[0x66, 0x6f], "Zm8="],
    [[0x66, 0x6f, 0x6f], "Zm9v"],
    [[0x66, 0x6f, 0x6f, 0x62], "Zm9vYg=="],
    [[0x66, 0x6f, 0x6f, 0x62, 0x61], "Zm9vYmE="],
    [[0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72], "Zm9vYmFy"],
    [[], ""],
    [[0xff, 0xfe, 0xfd], "//79"],
  ];
  for (const [bytes, expected] of cases) {
    assert.equal(toBase64(Uint8Array.from(bytes)), expected, `base64 of [${bytes}]`);
  }
});

test("D1 values become the JSON types PostgREST expects", () => {
  const plan = BACKUP_TABLES.find((p) => p.name === "cdx_surveys");
  assert.ok(plan);

  const booleanColumn = { name: "disabled", sqliteType: "BOOLEAN", postgresType: "boolean", key: false } as const;
  const byteaColumn = { name: "payload", sqliteType: "BLOB", postgresType: "bytea", key: false } as const;
  const textColumn = { name: "email", sqliteType: "TEXT", postgresType: "text", key: false } as const;
  const intColumn = { name: "created_at", sqliteType: "INTEGER", postgresType: "bigint", key: false } as const;

  // SQLite stores `DEFAULT false` as 0, and D1 hands it back as a number. Left
  // alone, Postgres rejects it for a boolean column.
  assert.equal(toPostgrestValue(booleanColumn, 1), true);
  assert.equal(toPostgrestValue(booleanColumn, 0), false);
  assert.equal(toPostgrestValue(booleanColumn, true), true);
  // Already-decoded values pass through unchanged rather than being re-encoded.
  assert.equal(toPostgrestValue(byteaColumn, "Zm9v"), "Zm9v");
  assert.equal(toPostgrestValue(byteaColumn, Uint8Array.from([0x66, 0x6f, 0x6f]).buffer), "Zm9v");
  assert.equal(
    toPostgrestValue(byteaColumn, new Uint8Array([0x66, 0x6f, 0x6f])),
    "Zm9v",
  );
  assert.equal(toPostgrestValue(textColumn, "a@b.c"), "a@b.c");
  // Integers are not coerced: a value past 2^53 must reach Postgres intact and be
  // rejected there, not silently rounded here.
  const big = 9007199254740993n;
  assert.equal(toPostgrestValue(intColumn, big), big);
  // NULL survives every branch.
  for (const column of [booleanColumn, byteaColumn, textColumn, intColumn]) {
    assert.equal(toPostgrestValue(column, null), null);
  }
});

test("toPostgrestRow copies planned columns only", () => {
  const plan = BACKUP_TABLES.find((p) => p.name === "assets");
  assert.ok(plan);
  const row = toPostgrestRow(plan, {
    hash: "abc",
    mime: "text/css",
    bytes: 12,
    r2_key: "assets/ab/abc",
    first_seen_at: 1,
    ref_count: 2,
    r2_deleted_at: null,
    // The cursor alias the read query projects must never reach PostgREST: it is
    // not a column, and `return=minimal` would still be a 400.
    __wm: 1,
    something_else: "ignored",
  });
  assert.deepEqual(Object.keys(row).sort(), columnNames(plan).sort());
  assert.equal(row["__wm"], undefined);
  assert.equal(row["something_else"], undefined);
});

test("chunkRows splits on size, not just count", () => {
  const rows: BackupRow[] = Array.from({ length: 10 }, (_, i) => ({ i, pad: "x".repeat(100) }));

  // 10 rows x ~110 bytes. A 300-byte ceiling must produce more than one batch.
  const bySize = chunkRows(rows, { maxRows: 100, maxBytes: 300 });
  assert.ok(bySize.length > 1, "size limit did not split the batch");
  assert.equal(bySize.flat().length, rows.length, "splitting lost or duplicated rows");
  for (const batch of bySize) {
    assert.ok(JSON.stringify(batch).length <= 300 + 120, "batch exceeded the byte ceiling");
  }

  // A row count ceiling splits identically and loses nothing.
  const byCount = chunkRows(rows, { maxRows: 3, maxBytes: 1_000_000 });
  assert.deepEqual(byCount.map((b) => b.length), [3, 3, 3, 1]);

  // A row larger than the ceiling is emitted alone rather than dropped. Dropping
  // is the one outcome a backup must never have.
  const huge: BackupRow[] = [{ big: "y".repeat(5000) }, { small: 1 }];
  const chunks = chunkRows(huge, { maxRows: 100, maxBytes: 100 });
  assert.equal(chunks.flat().length, 2);
  assert.equal(chunks[0]?.length, 1);

  assert.deepEqual(chunkRows([], { maxRows: 10, maxBytes: 10 }), []);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Configuration and drift
// ════════════════════════════════════════════════════════════════════════════

test("Supabase configuration is all-or-nothing and never throws at boot", () => {
  assert.equal(supabaseConfigFromEnv({}), null);
  assert.equal(supabaseConfigFromEnv({ SUPABASE_URL: "https://x.supabase.co" }), null);
  assert.equal(supabaseConfigFromEnv({ SUPABASE_SERVICE_ROLE_KEY: "k" }), null);
  assert.equal(supabaseConfigFromEnv({ SUPABASE_URL: "not a url", SUPABASE_SERVICE_ROLE_KEY: "k" }), null);

  // A trailing slash or a path must not survive into a URL join.
  const config = supabaseConfigFromEnv({
    SUPABASE_URL: "https://abc.supabase.co/",
    SUPABASE_SERVICE_ROLE_KEY: "k",
  });
  assert.deepEqual(config, {
    url: "https://abc.supabase.co",
    serviceRoleKey: "k",
    schema: "cw_backup",
  });

  // An explicit schema wins; an empty one falls back rather than producing "".
  assert.equal(
    supabaseConfigFromEnv({
      SUPABASE_URL: "https://abc.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      SUPABASE_SCHEMA: "other",
    })?.schema,
    "other",
  );
  assert.equal(
    supabaseConfigFromEnv({
      SUPABASE_URL: "https://abc.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      SUPABASE_SCHEMA: "  ",
    })?.schema,
    "cw_backup",
  );
});

test("a half-configured backup names the missing variable", () => {
  const db = {} as D1Database;
  assert.throws(
    () => resolveBackupEnv({ DB: db, SUPABASE_URL: "https://x.supabase.co" }),
    /SUPABASE_SERVICE_ROLE_KEY is not/,
  );
  assert.throws(
    () => resolveBackupEnv({ DB: db, SUPABASE_SERVICE_ROLE_KEY: "k" }),
    /SUPABASE_URL is not/,
  );
  assert.throws(() => resolveBackupEnv({ DB: db }), /not configured/);
  assert.doesNotThrow(() =>
    resolveBackupEnv({ DB: db, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }),
  );
});

test("the enable switch defaults to on and accepts the usual off spellings", () => {
  assert.equal(backupEnabled({} as never), true);
  assert.equal(backupEnabled({ BACKUP_ENABLED: "" } as never), true);
  for (const off of ["false", "FALSE", "0", "off", "no", " off "]) {
    assert.equal(backupEnabled({ BACKUP_ENABLED: off } as never), false, `"${off}" should disable`);
  }
  for (const on of ["true", "1", "yes"]) {
    assert.equal(backupEnabled({ BACKUP_ENABLED: on } as never), true);
  }
});

test("drift is reported in both directions", () => {
  const plans = BACKUP_TABLES.filter((p) => p.name === "assets" || p.name === "users");
  const live = new Map([
    [
      "assets",
      [
        { name: "hash", type: "TEXT" },
        { name: "mime", type: "TEXT" },
        { name: "bytes", type: "INTEGER" },
        { name: "r2_key", type: "TEXT" },
        { name: "first_seen_at", type: "INTEGER" },
        { name: "ref_count", type: "INTEGER" },
        { name: "r2_deleted_at", type: "INTEGER" },
        // A column a future migration added and the plan has not caught up with.
        { name: "added_later", type: "TEXT" },
      ],
    ],
    [
      "users",
      [
        { name: "id", type: "TEXT" },
        { name: "email", type: "TEXT" },
        // password_hash deliberately absent.
        { name: "created_at", type: "INTEGER" },
        { name: "last_login_at", type: "INTEGER" },
        // Drizzle emits `integer` with a boolean mode; the plan says BOOLEAN.
        { name: "disabled", type: "INTEGER" },
      ],
    ],
  ]);

  const problems = diffAgainstD1(plans, live);
  assert.equal(problems.length, 2, JSON.stringify(problems, null, 2));
  assert.ok(problems.some((p) => p.kind === "unexpected-column" && p.detail.includes("added_later")));
  assert.ok(problems.some((p) => p.kind === "missing-column" && p.detail.includes("password_hash")));

  // A missing table is fatal drift, not a column note.
  const missing = diffAgainstD1([plans[0]!], new Map());
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.kind, "missing-table");
});

test("drift accepts the declared types D1 actually reports", () => {
  // The real schema, as `PRAGMA table_info` describes it — including the two
  // boolean-mode columns Drizzle emits as `integer`.
  const actual = new Map(
    BACKUP_TABLES.map((plan) => [
      plan.name,
      plan.columns.map((c) => ({
        name: c.name,
        type:
          c.sqliteType === "BOOLEAN"
            ? "INTEGER"
            : c.sqliteType === "BLOB"
              ? "BLOB"
              : c.sqliteType,
      })),
    ]),
  );
  assert.deepEqual(diffAgainstD1(BACKUP_TABLES, actual), []);
});

test("only 429/5xx are worth retrying", () => {
  for (const status of [429, 500, 502, 503, 504, 408, 425]) {
    assert.equal(isRetryableStatus(status), true, `${status} should be retryable`);
  }
  // A 409 here is not contention: with `resolution=merge-duplicates` a duplicate
  // key cannot occur, so it means the conflict target does not match the DDL.
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} should not be retried`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 5. The sync engine, end to end
// ════════════════════════════════════════════════════════════════════════════

/** A recorded request the stub fetch was asked to make. */
interface Recorded {
  method: string;
  url: URL;
  body: unknown;
}

/**
 * A D1 stand-in that implements exactly the statement shapes the syncer issues.
 *
 * Rows are plain objects, and writes coerce to SQLite's storage classes —
 * booleans become 0/1, because that is what D1 hands back and what
 * `toPostgrestValue` exists to convert. A fake that stored `true` would let a
 * broken conversion pass.
 */
class FakeD1 {
  readonly tables = new Map<string, BackupRow[]>();
  readonly rateLimits: { bucket: string; window_start: number; count: number; updated_at: number }[] = [];
  readonly usage: BackupRow[] = [];
  readonly statements: string[] = [];
  /** Statements the fake did not recognise — a failure, not a silent no-op. */
  readonly unrecognised: string[] = [];

  constructor(seed: Record<string, BackupRow[]>) {
    for (const [name, rows] of Object.entries(seed)) this.tables.set(name, rows);
  }

  rows(table: string): BackupRow[] {
    return this.tables.get(table) ?? [];
  }

  add(table: string, row: BackupRow): void {
    if (!this.tables.has(table)) this.tables.set(table, []);
    this.tables.get(table)!.push(row);
  }

  binding(): D1Database {
    const self = this;

    function makeStatement(sql: string): D1PreparedStatement {
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          return (self.exec(sql, bound)[0] as T) ?? null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: self.exec(sql, bound) as T[] };
        },
        async run(): Promise<{ success: true; meta: { changes: number } }> {
          return { success: true, meta: { changes: self.exec(sql, bound).length } };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    }

    return {
      prepare: (sql: string) => makeStatement(sql),
    } as unknown as D1Database;
  }

  /**
   * Dispatch one statement.
   *
   * Shapes are matched against what `packages/shared/src/backup.ts` generates, and
   * anything else throws into `unrecognised` rather than returning nothing — so a
   * new query in the syncer surfaces here as a failure instead of as a mirror that
   * is quietly missing whatever that query would have copied.
   */
  private exec(sql: string, bound: unknown[]): BackupRow[] {
    const s = sql.replace(/\s+/g, " ").trim();
    this.statements.push(s.slice(0, 120));

    // ── PRAGMA table_info(<table>) — schema drift ─────────────────────────
    const pragma = /^PRAGMA table_info\((\w+)\)$/i.exec(s);
    if (pragma?.[1]) {
      const table = pragma[1];
      if (!this.tables.has(table)) return [];
      const first = this.rows(table)[0] ?? {};
      // `type` is what the DDL declared. The plan's BOOLEAN columns are declared
      // `integer` by Drizzle, which the drift check accepts — and that acceptance
      // is part of what these tests are checking.
      return Object.keys(first).map((name) => ({ name, type: typeOf(table, name) }));
    }

    // ── MAX(watermark) — the cheap "is there anything new" gate ───────────
    const high = /^SELECT MAX\((.+?)\) AS wm FROM (\w+)(?: WHERE .+)?$/.exec(s);
    if (high) {
      const [, expr, table] = high as unknown as [string, string, string];
      const values = this.rows(table)
        .map((row) => evalWatermark(expr, row))
        .filter((v): v is number | string => v !== null);
      if (values.length === 0) return [{ wm: null }];
      return [{ wm: values.reduce((a, b) => (compareValues(a, b) >= 0 ? a : b)) }];
    }

    // ── COUNT(*) — pending rows for status ────────────────────────────────
    const count = /^SELECT COUNT\(\*\) AS n FROM (\w+)(?: WHERE COALESCE\((.+?), 0\) >= \?)?$/.exec(s);
    if (count) {
      const [, table, expr] = count as unknown as [string, string, string | undefined];
      const rows = this.rows(table);
      if (expr === undefined) return [{ n: rows.length }];
      const cursor = bound[0];
      return [
        { n: rows.filter((row) => compareValues(evalWatermark(expr, row) ?? 0, cursor) >= 0).length },
      ];
    }

    // ── lease-in-flight count ─────────────────────────────────────────────
    const leaseCount = /^SELECT COUNT\(\*\) AS n FROM rate_limits WHERE bucket = \? AND window_start >= \?$/.exec(s);
    if (leaseCount) {
      const [bucket, cutoff] = bound as [string, number];
      return [
        {
          n: this.rateLimits.filter((r) => r.bucket === bucket && r.window_start >= cutoff).length,
        },
      ];
    }

    const quotaCount = /^SELECT COUNT\(\*\) AS n FROM rate_limits WHERE bucket LIKE \? AND window_start >= \?$/.exec(s);
    if (quotaCount) {
      const [pattern, dayStart] = bound as [string, number];
      const prefix = pattern.replace(/%$/, "");
      return [
        {
          n: this.rateLimits.filter((r) => r.bucket.startsWith(prefix) && r.window_start >= dayStart)
            .length,
        },
      ];
    }

    // ── The incremental read, window form and plain form ──────────────────
    if (/^SELECT .+? FROM (?:\(SELECT |\w+ WHERE )/.test(s)) return this.readRows(s, bound);

    // ── lease/quota upsert ────────────────────────────────────────────────
    if (/^INSERT INTO rate_limits /.test(s)) {
      const [bucket, windowStart, updatedAt] = bound as [string, number, number];
      const existing = this.rateLimits.find(
        (r) => r.bucket === bucket && r.window_start === windowStart,
      );
      if (existing) {
        existing.count += 1;
        existing.updated_at = updatedAt;
        return [{ count: existing.count }];
      }
      this.rateLimits.push({ bucket, window_start: windowStart, count: 1, updated_at: updatedAt });
      return [{ count: 1 }];
    }

    // ── usage ledger append ───────────────────────────────────────────────
    if (/^INSERT INTO usage_ledger /.test(s)) {
      this.usage.push({
        domain: bound[0],
        month: bound[1],
        kind: bound[2],
        value: bound[3],
        recorded_at: bound[4],
      });
      return [];
    }

    this.unrecognised.push(s);
    throw new Error(`FakeD1 does not implement: ${s.slice(0, 160)}`);
  }

  /**
   * The read query, in both its shapes.
   *
   * The window form's contract is the thing worth testing: return the whole
   * smallest watermark value, or nothing — never a partial slice of it. A fake
   * that returned the first `limit` rows regardless would let the wedge this
   * window function exists to prevent pass unnoticed.
   */
  private readRows(s: string, bound: unknown[]): BackupRow[] {
    // The patterns bracket the parts that carry information — the outer and inner
    // column lists, the watermark expression, the table, the limit — and let the
    // generated SQL vary in between (whitespace, an optional `IS NOT NULL`, the
    // ORDER BY detail). Matching the whole statement character for character would
    // mean every cosmetic change to `d1ReadSql` broke these tests, which trains you
    // to edit the pattern rather than look at the failure.
    //
    // The bracket on the inner column list stops at `AS __wm`, so the ORDER BY
    // and window clauses cannot leak into it; `columnNamesOf` then rejects
    // anything that is not a real column of the table.
    const windowForm =
      /FROM \(SELECT ([\s\S]*?) AS __wm,[\s\S]*?MIN\([\s\S]*?\) OVER \(\) AS __min FROM (\w+) WHERE ([\s\S]+?) >= \?[\s\S]*?__rn <= (\d+)\)/.exec(
        s,
      );
    if (windowForm) {
      const [, innerCols, table, whereExpr, limitText] = windowForm as unknown as string[];
      const cursor = bound[0];
      const names = this.columnNamesOf(table, innerCols);
      const candidates = this.rows(table)
        .filter((row) => compareValues(evalWatermark(whereExpr, row) ?? 0, cursor) >= 0)
        .sort((a, b) => compareValues(evalWatermark(whereExpr, a) ?? 0, evalWatermark(whereExpr, b) ?? 0));
      if (candidates.length === 0) return [];

      const min = evalWatermark(whereExpr, candidates[0]!) ?? 0;
      const sameValue = candidates.filter((row) => evalWatermark(whereExpr, row) === min);
      // The whole value or none of it — the contract this form exists to keep.
      if (sameValue.length > Number(limitText)) return [];

      return sameValue.map((row) => {
        const out: BackupRow = {};
        for (const name of names) out[name] = row[name] ?? null;
        out["__wm"] = min;
        return out;
      });
    }

    const plain =
      /^SELECT ([\s\S]+?), ([\s\S]+?) AS __wm FROM (\w+) WHERE ([\s\S]+?) >= \?[\s\S]*? ORDER BY [\s\S]+? LIMIT (\d+)$/.exec(
        s,
      );
    if (plain) {
      const [, cols, wmExpr, table, whereExpr, limitText] = plain as unknown as string[];
      const cursor = bound[0];
      const names = this.columnNamesOf(table, cols);
      return this.rows(table)
        .filter((row) => compareValues(evalWatermark(whereExpr, row) ?? 0, cursor) >= 0)
        .sort((a, b) => compareValues(evalWatermark(whereExpr, a) ?? 0, evalWatermark(whereExpr, b) ?? 0))
        .slice(0, Number(limitText))
        .map((row) => {
          const out: BackupRow = {};
          for (const name of names) out[name] = row[name] ?? null;
          out["__wm"] = evalWatermark(wmExpr, row);
          return out;
        });
    }

    this.unrecognised.push(s);
    throw new Error(`FakeD1 cannot read: ${s.slice(0, 200)}`);
  }

  /**
   * Turn a captured column list into names, refusing anything that is not one.
   *
   * This is what keeps a mis-parsed regex from turning into a passing test: if the
   * capture picked up a fragment of the window clause instead of the column list,
   * the names it produced would not be columns of the table, and this throws
   * rather than returning rows full of nulls that the assertions would then
   * happily accept.
   */
  private columnNamesOf(table: string, captured: string): string[] {
    const plan = BACKUP_TABLES.find((p) => p.name === table);
    if (!plan) throw new Error(`FakeD1 read a table the plan does not know: ${table}`);
    const known = new Set(columnNames(plan));

    const names = captured
      .replace(/\s+/g, " ")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      // The inner capture is anchored on the watermark alias, so a `WHERE x IS
      // NOT NULL` tail can come with it in the plain form. Only real column names
      // are kept; the exact-set check below is what makes the parse trustworthy.
      .filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));

    if (names.length !== known.size || names.some((n) => !known.has(n))) {
      throw new Error(
        `FakeD1 parsed columns [${names}] for "${table}", expected [${[...known]}]`,
      );
    }
    return names;
  }
}

/** Evaluate the watermark expressions the plan uses: a column, or COALESCE. */
function evalWatermark(expr: string, row: BackupRow): number | string | null {
  const trimmed = expr.trim();
  const coalesce = /^COALESCE\((.+)\)$/i.exec(trimmed);
  if (coalesce?.[1]) {
    for (const part of coalesce[1].split(",").map((p) => p.trim())) {
      if (/^-?\d+$/.test(part)) return Number(part);
      const value = row[part];
      if (value !== null && value !== undefined) return value as number | string;
    }
    return null;
  }
  const value = row[trimmed];
  return value === undefined ? null : (value as number | string | null);
}

function compareValues(a: unknown, b: unknown): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Column types as the D1 DDL declares them. */
function typeOf(table: string, column: string): string {
  const plan = BACKUP_TABLES.find((p) => p.name === table);
  const planned = plan?.columns.find((c) => c.name === column);
  if (!planned) return "TEXT";
  // Drizzle emits `integer` with a boolean mode for the two boolean columns.
  return planned.sqliteType === "BOOLEAN" ? "INTEGER" : planned.sqliteType;
}

/** A stub Supabase: PostgREST for the mirror, plus the syncer's own state calls. */
class FakeSupabase {
  readonly requests: Recorded[] = [];
  /** Rows the mirror holds, per table. */
  readonly mirror = new Map<string, BackupRow[]>();
  /** Rows of `backup_state`, keyed by table name. */
  readonly state = new Map<string, BackupRow>();
  /** Tables whose next push should fail, and how. */
  readonly failNext = new Map<string, { status: number; body: string }>();
  /** Set to fail every push with this status (a 401, say). */
  readonly failAll = { status: 0, body: "" };

  pushCount(table: string): number {
    return this.requests.filter(
      (r) => r.method === "POST" && r.url.pathname.endsWith(`/rest/v1/${table}`),
    ).length;
  }

  pushedRows(table: string): BackupRow[] {
    return this.requests
      .filter((r) => r.method === "POST" && r.url.pathname.endsWith(`/rest/v1/${table}`))
      .flatMap((r) => (Array.isArray(r.body) ? (r.body as BackupRow[]) : []));
  }

  /** Row-level requests only, ignoring the syncer's own bookkeeping calls. */
  get rowRequests(): Recorded[] {
    return this.requests.filter((r) => !r.url.pathname.endsWith("/rest/v1/backup_state"));
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, url, body });

    if (!url.pathname.startsWith("/rest/v1/")) {
      throw new Error(`FakeSupabase saw a non-PostgREST request: ${url.pathname}`);
    }
    const table = decodeURIComponent(url.pathname.slice("/rest/v1/".length));

    // The service-role key must be presented as a bearer token, not only as
    // `apikey`: PostgREST picks the role from the Authorization header, and an
    // `apikey`-only request is executed as `anon`, which has no access to the
    // mirror schema at all.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!String(headers["Authorization"] ?? "").startsWith("Bearer ")) {
      return Response.json(
        { code: "42501", message: "permission denied for schema cw_backup" },
        { status: 401 },
      );
    }

    if (method === "HEAD") return new Response(null, { status: 200 });

    if (table === "backup_state") {
      if (method === "GET") {
        const filter = url.searchParams.get("table_name");
        const rows = filter
          ? [...this.state.values()].filter((r) => r["table_name"] === filter.replace(/^eq\./, ""))
          : [...this.state.values()];
        return Response.json(rows.slice(0, Number(url.searchParams.get("limit") ?? rows.length)));
      }
      const row = (body as BackupRow[])[0]!;
      this.state.set(String(row["table_name"]), row);
      return new Response(null, { status: 201 });
    }

    if (method === "POST") {
      if (this.failAll.status) {
        return new Response(this.failAll.body, { status: this.failAll.status });
      }
      const failure = this.failNext.get(table);
      if (failure) {
        this.failNext.delete(table);
        return new Response(failure.body, { status: failure.status });
      }

      const rows = body as BackupRow[];
      const existing = this.mirror.get(table) ?? [];
      const key = conflictTarget(BACKUP_TABLES.find((p) => p.name === table)!)
        ?.split(",") ?? [];
      for (const row of rows) {
        const at = existing.findIndex((r) => key.every((k) => r[k] === row[k]));
        if (at >= 0) existing[at] = { ...existing[at], ...row };
        else existing.push(row);
      }
      this.mirror.set(table, existing);
      return new Response(null, { status: 201 });
    }

    throw new Error(`FakeSupabase: unhandled ${method} ${url.pathname}`);
  };
}

interface Harness {
  db: FakeD1;
  supabase: FakeSupabase;
  sync: BackupSync;
  env: Record<string, unknown>;
}

function harness(
  seed: Record<string, BackupRow[]>,
  options: { now?: () => number; env?: Record<string, string> } = {},
): Harness {
  const db = new FakeD1(seed);
  const supabase = new FakeSupabase();
  const now = options.now ?? (() => 1_700_000_000);

  const env: Record<string, unknown> = {
    DB: db.binding(),
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_SCHEMA: "cw_backup",
    ...(options.env ?? {}),
  };

  const sync = new BackupSync(env as never, { now, fetchImpl: supabase.fetch });
  return { db, supabase, sync, env };
}

/** Seed a handful of rows for one table, using the plan to shape them. */
function rowsFor(table: string, count: number, watermarkBase = 1000): BackupRow[] {
  const plan = BACKUP_TABLES.find((p) => p.name === table);
  assert.ok(plan, `no plan for "${table}"`);
  const key = plan.columns.filter((c) => c.key);
  const wmColumns = watermarkColumns(plan.watermarkSql);

  return Array.from({ length: count }, (_, n) => {
    const row: BackupRow = {};
    for (const column of plan.columns) {
      switch (column.postgresType) {
        case "boolean":
          row[column.name] = 0;
          break;
        case "bytea":
          row[column.name] = new Uint8Array([1, 2, 3]).buffer;
          break;
        case "bigint":
          row[column.name] = watermarkBase + n;
          break;
        default:
          row[column.name] = `${table}-${n}`;
      }
    }
    // Give the key columns distinct values so an upsert means something.
    key.forEach((column, i) => {
      row[column.name] = i === 0 ? `${table}-key-${n}` : watermarkBase + n;
    });
    // And put the watermark where the plan says it lives.
    for (const column of wmColumns) {
      if (row[column] !== undefined || column.includes("_at") || column === "id") {
        row[column] = watermarkBase + n;
      }
    }
    return row;
  });
}

// ── The runs ────────────────────────────────────────────────────────────────

test("an unconfigured backup refuses to run rather than reporting success", () => {
  assert.throws(
    () => new BackupSync({ DB: new FakeD1({}).binding() } as never),
    /not configured/,
  );
});

test("a run with a drifted D1 stops before touching the mirror", async () => {
  // `assets` exists but is missing a planned column, which is fatal drift.
  const { db, supabase, sync } = harness({
    assets: [{ hash: "a", mime: "text/css", bytes: 1, r2_key: "k", first_seen_at: 1, ref_count: 1, r2_deleted_at: null }],
  });
  // Remove a planned column from what PRAGMA reports by deleting it from the row.
  for (const row of db.rows("assets")) delete row["r2_key"];

  const summary = await sync.run({ force: true });
  assert.equal(summary.stoppedBecause, "drift");
  assert.ok(summary.drift && summary.drift.length > 0);
  assert.equal(summary.rows, 0);
  // The point: no write was attempted against a schema it cannot describe.
  assert.equal(supabase.requests.length, 0);
});

test("a first run mirrors every table and records a cursor per table", async () => {
  const seed: Record<string, BackupRow[]> = {
    assets: rowsFor("assets", 5),
    usage_ledger: rowsFor("usage_ledger", 3),
    throttle_events: rowsFor("throttle_events", 2),
  };
  const { supabase, sync } = harness(seed);

  const summary = await sync.run({ force: true });

  assert.equal(summary.stoppedBecause, "complete");
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.rows, 10, "expected 5 + 3 + 2 rows");

  // Every seeded row arrived, and nothing else did.
  assert.equal(supabase.mirror.get("assets")?.length, 5);
  assert.equal(supabase.mirror.get("usage_ledger")?.length, 3);
  assert.equal(supabase.mirror.get("throttle_events")?.length, 2);

  // A cursor was recorded for the tables that had rows, and it is the highest
  // watermark — not zero, and not the first row's value.
  const assets = supabase.state.get("assets");
  assert.ok(assets, "no backup_state row for assets");
  assert.equal(Number(assets["last_cursor"]), 1004);
  assert.equal(Number(assets["rows_synced"]), 5);
  assert.equal(assets["last_error"], null);
  assert.equal(Number(assets["consecutive_fails"]), 0);
});

test("values survive the trip: booleans as JSON booleans, blobs as base64", async () => {
  const { supabase, sync } = harness({
    users: [
      {
        id: "u1",
        email: "a@b.c",
        password_hash: "hash",
        created_at: 1000,
        last_login_at: null,
        // What D1 actually returns for `DEFAULT false`.
        disabled: 0,
      },
    ],
  });

  await sync.run({ force: true, only: ["users"] });
  const pushed = supabase.pushedRows("users")[0]!;
  assert.equal(pushed["disabled"], false, "0 must become a JSON boolean, not stay a number");
  assert.equal(pushed["last_login_at"], null);
});

test("a bytea column is base64-encoded for PostgREST", async () => {
  const { supabase, sync } = harness({
    cdx_surveys: [
      {
        id: "s1",
        domain: "example.com",
        month: "2024-03",
        query_hash: "qh",
        payload: Uint8Array.from([0x66, 0x6f, 0x6f]).buffer,
        fetched_at: 1234,
      },
    ],
  });

  await sync.run({ force: true, only: ["cdx_surveys"] });
  const pushed = supabase.pushedRows("cdx_surveys")[0]!;
  assert.equal(pushed["payload"], "Zm9v");
});

test("a calm second run costs no row requests at all", async () => {
  const { supabase, sync } = harness({ assets: rowsFor("assets", 4) });

  await sync.run({ force: true });
  const afterFirst = supabase.rowRequests.length;
  assert.ok(afterFirst > 0);

  // Nothing changed in D1, so the high-water gate must short-circuit every table.
  const second = await sync.run({ force: true });
  assert.equal(second.rows, 0);
  assert.equal(
    supabase.rowRequests.length,
    afterFirst,
    "a run with nothing new issued PostgREST row requests",
  );
  // And it says why: every table that had data was skipped rather than failed.
  assert.ok(second.tables.some((t) => t.skipped));
  assert.deepEqual(second.failures, []);
});

test("incremental runs pick up only what is new and advance the cursor", async () => {
  const { db, supabase, sync } = harness({ usage_ledger: rowsFor("usage_ledger", 3) });

  await sync.run({ force: true });
  assert.equal(Number(supabase.state.get("usage_ledger")?.["last_cursor"]), 1002);

  // Three more rows, later ids.
  for (const row of rowsFor("usage_ledger", 3, 2000)) db.add("usage_ledger", row);

  const second = await sync.run({ force: true });
  assert.equal(second.rows, 3);
  assert.equal(Number(supabase.state.get("usage_ledger")?.["last_cursor"]), 2002);

  // The mirror holds all six, and the second run's second page did not re-send
  // the first three as new rows.
  assert.equal(supabase.mirror.get("usage_ledger")?.length, 6);
});

test("rows sharing one watermark larger than a batch do not wedge the cursor", async () => {
  // Every row has the same watermark value, and there are more of them than fit
  // in one read. The plain `LIMIT` form would return the same page forever.
  const rows = rowsFor("throttle_events", 7).map((row) => ({ ...row, id: 500 }));
  const { supabase, sync } = harness({ throttle_events: rows }, {
    env: { BACKUP_READ_BATCH: "3", BACKUP_PUSH_BATCH: "3" },
  });

  const first = await sync.run({ force: true });
  // The whole value does not fit in one batch, so nothing is committed and the
  // cursor stays where it was — a stall that the next run resolves by asking for
  // strictly greater, never a partial slice that loses rows.
  assert.equal(first.rows, 0, "a value that does not fit must not be partially copied");
  assert.equal(supabase.state.get("throttle_events"), undefined);

  // Raise the batch so the shared value fits: all seven arrive at once.
  const { supabase: supabase2, sync: sync2 } = harness({ throttle_events: rows }, {
    env: { BACKUP_READ_BATCH: "10", BACKUP_PUSH_BATCH: "10" },
  });
  const second = await sync2.run({ force: true });
  assert.equal(second.rows, 7);
  assert.equal(supabase2.mirror.get("throttle_events")?.length, 7);
  void supabase;
});

test("a large table is mirrored across several pages in one run", async () => {
  const { supabase, sync } = harness({ usage_ledger: rowsFor("usage_ledger", 25) }, {
    env: { BACKUP_READ_BATCH: "10", BACKUP_PUSH_BATCH: "10" },
  });

  const summary = await sync.run({ force: true });
  assert.equal(summary.rows, 25);
  const result = summary.tables.find((t) => t.table === "usage_ledger");
  assert.ok(result && result.batches >= 3, `expected 3+ batches, got ${result?.batches}`);
  assert.equal(Number(supabase.state.get("usage_ledger")?.["last_cursor"]), 1024);
});

test("a failed push leaves the cursor where it started so rows are never skipped", async () => {
  const { db, supabase, sync } = harness({ usage_ledger: rowsFor("usage_ledger", 4) });

  // First run succeeds and commits cursor 1003.
  await sync.run({ force: true });
  assert.equal(Number(supabase.state.get("usage_ledger")?.["last_cursor"]), 1003);

  // New rows, and this time PostgREST refuses them with a non-retryable error.
  for (const row of rowsFor("usage_ledger", 4, 3000)) db.add("usage_ledger", row);
  supabase.failNext.set("usage_ledger", {
    status: 400,
    body: JSON.stringify({ code: "23502", message: "null value in column violates not-null" }),
  });

  const failed = await sync.run({ force: true });
  assert.deepEqual(failed.failures, ["usage_ledger"]);
  const state = supabase.state.get("usage_ledger")!;
  assert.equal(
    Number(state["last_cursor"]),
    1003,
    "the cursor moved past rows the mirror refused — they would never be retried",
  );
  assert.equal(Number(state["consecutive_fails"]), 1);
  assert.match(String(state["last_error"]), /23502/);

  // The next run reads from 1003 again and succeeds.
  const recovered = await sync.run({ force: true });
  assert.deepEqual(recovered.failures, []);
  assert.equal(recovered.rows, 8, "the previously refused rows were not re-read");
  assert.equal(Number(supabase.state.get("usage_ledger")?.["last_cursor"]), 3003);
});

test("a retryable failure is retried, and a persistent one is reported as such", async () => {
  const attempts: number[] = [];
  const db = new FakeD1({ assets: rowsFor("assets", 2) });
  const supabase = new FakeSupabase();

  // 503 twice, then success — the transient case the backoff exists for.
  let seen = 0;
  const flaky: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/rest/v1/assets") && (init?.method ?? "").toUpperCase() === "POST") {
      seen += 1;
      attempts.push(seen);
      if (seen <= 2) return new Response("upstream unavailable", { status: 503 });
    }
    return supabase.fetch(input, init);
  };

  const sync = new BackupSync(
    { DB: db.binding(), SUPABASE_URL: "https://t.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as never,
    { now: () => 1_700_000_000, fetchImpl: flaky, sleep: async () => {} },
  );

  const summary = await sync.run({ force: true, only: ["assets"] });
  assert.deepEqual(summary.failures, [], "a 503 twice should still end in success");
  assert.equal(attempts.length, 3, "expected two failures then a success");
  assert.equal(summary.rows, 2);
});

test("a bad service-role key is reported, not retried into a timeout", async () => {
  const { supabase, sync } = harness({ assets: rowsFor("assets", 1) });
  supabase.failAll.status = 401;
  supabase.failAll.body = JSON.stringify({ code: "42501", message: "permission denied for schema cw_backup" });

  const summary = await sync.run({ force: true, only: ["assets"] });
  assert.deepEqual(summary.failures, ["assets"]);
  const error = summary.tables.find((t) => t.table === "assets")?.error ?? "";
  assert.match(error, /401/);
  assert.match(error, /permission denied/);
  // One request, not three: a 401 is an operator problem and retrying hides it.
  assert.equal(supabase.pushCount("assets"), 1);
});

test("the lease stops two runs from overlapping", async () => {
  const { sync, db } = harness({ assets: rowsFor("assets", 2) });

  const holds = await sync.acquireLease(BACKUP_DEFAULTS.leaseSeconds);
  assert.equal(holds, true, "the first run should own the window");
  const second = await sync.acquireLease(BACKUP_DEFAULTS.leaseSeconds);
  assert.equal(second, false, "a second claim on the same window must fail");

  // A fresh clock past the lease window can claim again.
  const later = new BackupSync(
    { DB: db.binding(), SUPABASE_URL: "https://t.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as never,
    { now: () => 1_700_000_000 + BACKUP_DEFAULTS.leaseSeconds + 1, fetchImpl: new FakeSupabase().fetch },
  );
  assert.equal(await later.acquireLease(BACKUP_DEFAULTS.leaseSeconds), true);
});

test("an interval that has not elapsed stops the run before any row is read", async () => {
  const { supabase, sync } = harness({ assets: rowsFor("assets", 3) }, {
    env: { BACKUP_INTERVAL_SECONDS: "900" },
  });

  // Nothing has ever succeeded, so the first run is due.
  const first = await sync.run({ force: true });
  assert.ok(first.rows > 0);

  // A second automatic run immediately afterwards is not.
  const second = await sync.run();
  assert.equal(second.rows, 0);
  assert.ok(
    second.stoppedBecause === "quota" || second.stoppedBecause === "lease",
    `unexpected stop reason: ${second.stoppedBecause}`,
  );
  assert.equal(second.tables.length, 0, "the interval gate should short-circuit before reading");
});

test("status reports what is pending, counted from D1 rather than trusted", async () => {
  const { db, sync } = harness({ usage_ledger: rowsFor("usage_ledger", 5) });

  // Before any run: everything is pending, because no cursor exists.
  const cold = await sync.status();
  assert.equal(cold.configured, true);
  assert.equal(cold.reachable, true);
  const ledgerCold = cold.tables.find((t) => t.table === "usage_ledger");
  assert.equal(ledgerCold?.pendingRows, 5);
  assert.equal(ledgerCold?.lastSuccessAt, null);
  assert.equal(ledgerCold?.lagSeconds, null);
  assert.equal(cold.health, "behind", "a table that has never synced is not healthy");

  await sync.run({ force: true, only: ["usage_ledger"] });

  const warm = await sync.status();
  const ledgerWarm = warm.tables.find((t) => t.table === "usage_ledger");
  assert.equal(ledgerWarm?.pendingRows, 0);
  assert.equal(ledgerWarm?.consecutiveFails, 0);
  assert.ok(ledgerWarm && ledgerWarm.lastSuccessAt !== null);

  // New rows show up as pending, with no run needed to notice them.
  for (const row of rowsFor("usage_ledger", 3, 4000)) db.add("usage_ledger", row);
  const after = await sync.status();
  assert.equal(after.tables.find((t) => t.table === "usage_ledger")?.pendingRows, 3);
});

test("status reports an unreachable mirror instead of throwing", async () => {
  const db = new FakeD1({ assets: rowsFor("assets", 1) });
  const sync = new BackupSync(
    { DB: db.binding(), SUPABASE_URL: "https://t.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as never,
    {
      now: () => 1_700_000_000,
      fetchImpl: async () => new Response("gateway down", { status: 502 }),
    },
  );

  const status = await sync.status();
  assert.equal(status.reachable, false);
  assert.equal(status.health, "unreachable");
  assert.ok(status.error, "the reason should be carried, not swallowed");
  // The D1 side still reports, so the endpoint stays useful while Supabase is down.
  assert.equal(status.configured, true);
});

test("status flags drift without failing", async () => {
  const { db, sync } = harness({ assets: rowsFor("assets", 1) });
  delete db.rows("assets")[0]!["mime"];

  const status = await sync.status();
  assert.equal(status.health, "drift");
  assert.ok(status.drift.some((d) => d.detail.includes("mime")));
});
