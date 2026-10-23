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
 *      PostgREST row requests Ã¢â‚¬â€ asserted directly, because the whole reason the
 *      five-minute cron is affordable is that this path is free.
 *
 * ## Why a fake D1 and a stubbed fetch
 *
 * Missing-locally state is where the interesting behaviour lives, and it cannot be
 * produced on demand against a real Supabase project: a lost response, a 429
 * mid-batch, a cursor that must not advance. Both fakes are *goal-oriented* Ã¢â‚¬â€ the
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

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// 1. The plan, on its own
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

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
    assert.ok(declared >= 1, `"${plan.name}" declares no placeholders at all`);
    assert.match(sql, /ORDER BY /);
    // The two forms bound the batch differently: the keyed form expresses the batch
    // as an OFFSET into the pending set, and the keyless fallback uses LIMIT.
    if (conflictTarget(plan)) {
      assert.match(
        sql,
        /ORDER BY .+? ASC LIMIT 1 OFFSET 199/,
        `"${plan.name}" should size the batch at its 200th row`,
      );
    } else {
      assert.match(sql, /LIMIT 200/);
    }
    // The cursor alias must survive the trip: the syncer reads it back to advance.
    assert.match(sql, /AS __wm/);
    assert.match(sql, /AS __more/);
    // Every supplied value is the same cursor: the boundary and the lookahead must
    // measure the same row set the range predicate selected. A numeric cursor is
    // supplied as a **number**, not the stored text — binding "42" makes
    // `watermark >= '42'` false for an integer column in SQLite, because every number
    // sorts before every string.
    assert.deepEqual([...new Set(d1ReadParams(plan, "42"))], [42]);
    // A non-numeric cursor stays text, which is the right affinity for a ULID column.
    assert.deepEqual([...new Set(d1ReadParams(plan, "01HXYZ"))], ["01HXYZ"]);
  }
});

test("the read query refuses to split a watermark value shared by many rows", () => {
  // A plain `WHERE wm >= ? ORDER BY wm LIMIT n` would return the same n rows on
  // every run, advance the cursor to the same value, and return them again Ã¢â‚¬â€ forever.
  for (const plan of BACKUP_TABLES) {
    const sql = d1ReadSql(plan, 100);
    if (!conflictTarget(plan)) {
      assert.match(sql, /LIMIT 100/, `"${plan.name}" is keyless and should fall back to LIMIT`);
      continue;
    }
    // The batch boundary is the watermark of the 100th pending row Ã¢â‚¬â€ an OFFSET
    // lookup, not a window over the watermark itself. `MIN(wm) OVER (ORDER BY wm)`
    // looks equivalent and is not: within a frame ordered by the watermark, the
    // minimum is always the current row, so the boundary collapses.
    assert.match(
      sql,
      /ORDER BY .+? ASC LIMIT 1 OFFSET 99/,
      `"${plan.name}" should bound the batch at its 100th row`,
    );
    // With fewer than 100 rows pending the OFFSET finds nothing, so the boundary
    // falls back to the largest watermark Ã¢â‚¬â€ otherwise `wm <= NULL` would be false for
    // every row and the table would stop syncing entirely.
    assert.match(sql, /COALESCE\([\s\S]*?SELECT MAX\(/, `"${plan.name}" needs a boundary fallback`);
    // Every value at or below the boundary comes back whole; and the lookahead is
    // what tells the caller there is more.
    assert.match(sql, /AND .+? <= COALESCE\(/);
    assert.match(sql, /SELECT MAX\(.+?\) FROM .+? WHERE .+? > \(SELECT/);
  }
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

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// 2. The plan versus the Postgres DDL
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

interface DdlTable {
  columns: Map<string, string>;
  primaryKey: string[];
}

/**
 * Read `supabase/migrations/*.sql` and reduce it to tables, columns and keys.
 *
 * Deliberately a parser rather than a regex sweep: the point is to compare a
 * *structure* against the plan. It understands the subset of DDL these
 * migrations use Ã¢â‚¬â€ `create table if not exists`, one column per line, a
 * per-column `primary key`, a table-level `primary key (Ã¢â‚¬Â¦)` Ã¢â‚¬â€ and ignores
 * everything else. If the DDL ever grows past that subset the parse produces an
 * empty or partial table, and the count assertion below fails rather than the
 * comparison passing vacuously.
 */
async function parseDdl(): Promise<Map<string, DdlTable>> {
  // `run-api-tests.mjs` runs `node --test` with `cwd` set to `apps/api`, and the
  // test file itself has been bundled into the OS temp directory by then Ã¢â‚¬â€ so
  // `import.meta.url` would point at the bundle, not at the repo. The working
  // directory is the only reliable anchor, and the runner guarantees it.
  const dir = resolve(process.cwd(), "..", "..", "supabase", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "no migrations found Ã¢â‚¬â€ the DDL comparison would be vacuous");

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
        `"${plan.name}.${column.name}" is in the plan but not in the DDL Ã¢â‚¬â€ the push would fail`,
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
        `"${plan.name}.${columnName}" is in the DDL but not in the plan Ã¢â‚¬â€ it would never be backed up`,
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

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// 3. Value mapping and batching
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

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

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// 4. Configuration and drift
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

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
  // The real schema, as `PRAGMA table_info` describes it Ã¢â‚¬â€ including the two
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

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// 5. The sync engine, end to end
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

/** A recorded request the stub fetch was asked to make. */
interface Recorded {
  method: string;
  url: URL;
  body: unknown;
}
/** Evaluate the watermark expressions the plan uses: a column, or COALESCE. */
function evalWatermark(expr: string, row: BackupRow): number | string | null {
  const trimmed = expr.trim();
  // Greedy `(.+)`, not lazy `(.+?)`: the expression is regularly nested inside
  // `MIN(COALESCE(a, b)) OVER ()`, where a lazy match stops at the inner `)` and
  // silently evaluates the wrong thing.
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


// â”€â”€ The runs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("an unconfigured backup refuses to run rather than reporting success", () => {
  assert.throws(
    () => new BackupSync({ DB: {} as D1Database } as never),
    /not configured/,
  );
});

test("a run with a drifted D1 stops before touching the mirror", async (t) => {
  const raw = await openSqlite(t);
  if (!raw) return;

  // Create `assets` *without* `r2_key`: a migration that added a column to the plan
  // before it reached D1 looks exactly like this, and it is the condition the drift
  // check exists to catch.
  raw.exec(`CREATE TABLE assets (
    hash TEXT PRIMARY KEY, mime TEXT, bytes INTEGER, first_seen_at INTEGER,
    ref_count INTEGER, r2_deleted_at INTEGER)`);
  const db = new SqliteD1(raw);
  const supabase = new FakeSupabase();
  const sync = new BackupSync(
    {
      DB: db.binding(),
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    } as never,
    { now: () => 1_700_000_000, fetchImpl: supabase.fetch },
  );

  const summary = await sync.run({ force: true });
  assert.equal(summary.stoppedBecause, "drift");
  assert.ok(summary.drift && summary.drift.length > 0);
  assert.ok(
    summary.drift.some((d) => d.kind === "missing-table" || d.detail.includes("r2_key")),
    JSON.stringify(summary.drift),
  );
  assert.equal(summary.rows, 0);
  // The point: nothing was written to a schema it cannot fully describe, and the
  // mirror was never even contacted.
  assert.equal(supabase.requests.length, 0);
});

test("a first run mirrors every table and records a cursor per table", async (t) => {
  const h = await sqliteHarness(t, [
    `INSERT INTO assets (hash, mime, bytes, r2_key, first_seen_at, ref_count, r2_deleted_at)
     VALUES ('h0','text/css',10,'a/h0',1000,1,1000),
            ('h1','text/css',11,'a/h1',1001,1,1001),
            ('h2','text/css',12,'a/h2',1002,1,1002),
            ('h3','text/css',13,'a/h3',1003,1,1003),
            ('h4','text/css',14,'a/h4',1004,1,1004)`,
    `INSERT INTO usage_ledger (id, domain, month, kind, value, recorded_at)
     VALUES (10,'x','2024-03','ia_fetch',1,1000),(11,'x','2024-03','ia_fetch',1,1001),(12,'x','2024-03','ia_fetch',1,1002)`,
    `INSERT INTO throttle_events (id, domain, host, status, wait_ms, created_at)
     VALUES (20,'x','web.archive.org',429,900,1000),(21,'x','web.archive.org',429,900,1001)`,
  ]);
  if (!h) return;
  const { supabase, sync, db } = h;

  const summary = await sync.run({ force: true });

  assert.equal(summary.stoppedBecause, "complete");
  assert.deepEqual(
    summary.failures,
    [],
    `per-table detail: ${JSON.stringify(summary.tables)} sql: ${JSON.stringify(db.unrecognised)}`,
  );
  // At least the seeded rows. `rate_limits` contributes one extra: the run's own lease
  // is written into that table and is therefore mirrored, which is intended — a
  // promoted mirror must not immediately re-run every window.
  assert.ok(summary.rows >= 10, `expected at least 5 + 3 + 2 rows, got ${summary.rows}`);

  // Every seeded row arrived, and nothing else did.
  assert.equal(supabase.mirror.get("assets")?.length, 5);
  assert.equal(supabase.mirror.get("usage_ledger")?.length, 3);
  assert.equal(supabase.mirror.get("throttle_events")?.length, 2);

  // A cursor was recorded for the tables that had rows, and it is the highest
  // watermark Ã¢â‚¬â€ not zero, and not the first row's value.
  const assets = supabase.state.get("assets");
  assert.ok(assets, "no backup_state row for assets");
  assert.equal(Number(assets["last_cursor"]), 1004);
  assert.equal(Number(assets["rows_synced"]), 5);
  assert.equal(assets["last_error"], null);
  assert.equal(Number(assets["consecutive_fails"]), 0);
});

test("values survive the trip: booleans as JSON booleans, blobs as base64", async (t) => {
  const h = await sqliteHarness(t, [
    `INSERT INTO users (id, email, password_hash, created_at, last_login_at, disabled)
     VALUES ('u1','a@b.c','hash',1000,NULL,0)`,
  ]);
  if (!h) return;

  await h.sync.run({ force: true, only: ["users"] });
  const pushed = h.supabase.pushedRows("users")[0]!;
  assert.ok(pushed, `nothing was pushed; state: ${JSON.stringify([...h.supabase.state.values()])}`);
  assert.equal(pushed["disabled"], false, "0 must become a JSON boolean, not stay a number");
  assert.equal(pushed["last_login_at"], null);
});

test("a bytea column is base64-encoded for PostgREST", async (t) => {
  const h = await sqliteHarness(t, [
    // `x'666f6f'` and not `'foo'`: the column has to hold an actual BLOB for this to
    // test the conversion. Seeded as TEXT, D1 and SQLite both hand back a string,
    // `toPostgrestValue` passes strings through unchanged, and the test would pass
    // while proving nothing about bytea.
    `INSERT INTO cdx_surveys (id, domain, month, query_hash, payload, fetched_at)
     VALUES ('s1','example.com','2024-03','qh',x'666f6f',1234)`,
  ]);
  if (!h) return;

  await h.sync.run({ force: true, only: ["cdx_surveys"] });
  const pushed = h.supabase.pushedRows("cdx_surveys")[0]!;
  assert.ok(pushed, "nothing was pushed");
  // `cdx_surveys.payload` is a BLOB in D1 and `bytea` in Postgres; SQLite returns the
  // bytes as an ArrayBuffer, and PostgREST wants base64.
  assert.equal(pushed["payload"], "Zm9v");
});

test("a calm second run costs no row requests at all", async (t) => {
  const h = await sqliteHarness(t, [
    `INSERT INTO assets (hash, mime, bytes, r2_key, first_seen_at, ref_count, r2_deleted_at)
     VALUES ('h0','text/css',10,'a/h0',1000,1,1000),
            ('h1','text/css',11,'a/h1',1001,1,1001)`,
  ]);
  if (!h) return;

  await h.sync.run({ force: true });
  const afterFirst = h.supabase.rowRequests.length;
  assert.ok(afterFirst > 0, "the first run should have pushed rows");

  // Nothing changed in D1, so the high-water gate must short-circuit every table
  // before it reads a single row.
  const second = await h.sync.run({ force: true });
  assert.equal(second.rows, 0);
  assert.equal(
    h.supabase.rowRequests.length,
    afterFirst,
    "a run with nothing new issued PostgREST row requests",
  );
  assert.deepEqual(second.failures, []);
});

test("incremental runs pick up only what is new and advance the cursor", async (t) => {
  // The clock has to move between runs. `acquireLease` claims a window derived from
  // `now`, so two runs at a frozen timestamp land in the same window and the second is
  // correctly refused as a concurrent run — which is the lease working, not the
  // incremental read failing. Advancing past the lease window is what a real
  // five-minute cron does on its own.
  let clock = 1_700_000_000;
  const h = await sqliteHarness(
    t,
    [
      `INSERT INTO usage_ledger (id, domain, month, kind, value, recorded_at)
       VALUES (10,'x','2024-03','ia_fetch',1,1000),(11,'x','2024-03','ia_fetch',1,1001),(12,'x','2024-03','ia_fetch',1,1002)`,
    ],
    { now: () => clock },
  );
  if (!h) return;

  await h.sync.run({ force: true });
  assert.equal(Number(h.supabase.state.get("usage_ledger")?.["last_cursor"]), 12);

  // Three more rows, later ids.
  h.raw.exec(
    `INSERT INTO usage_ledger (id, domain, month, kind, value, recorded_at)
     VALUES (20,'x','2024-03','ia_fetch',1,2000),(21,'x','2024-03','ia_fetch',1,2001),(22,'x','2024-03','ia_fetch',1,2002)`,
  );

  clock += 600;
  // `force` because the second run is immediate and the interval gate would otherwise
  // decline it — which is a separate behaviour, tested on its own.
  const second = await h.sync.run({ force: true });
  const ledgerSecond = second.tables.find((x) => x.table === "usage_ledger");
  assert.equal(
    ledgerSecond?.rows,
    // Row 12 is re-read because the first page of a run is inclusive (at-least-once),
    // and the upsert makes that harmless. Everything else must be new.
    4,
    `usage_ledger detail: ${JSON.stringify(ledgerSecond)} state: ${JSON.stringify([...h.supabase.state.values()])}`,
  );
  assert.equal(Number(h.supabase.state.get("usage_ledger")?.["last_cursor"]), 22);

  // The mirror holds all six, and the second run did not re-send the first three.
  assert.equal(h.supabase.mirror.get("usage_ledger")?.length, 6);
  assert.equal((h.supabase.mirror.get("usage_ledger") ?? []).length, 6, "the mirror must hold six distinct rows");
});

test("a whole value shared by more rows than a batch is still copied", async (t) => {
  // Every row has the same watermark, and there are more of them than fit in one
  // read. A plain `LIMIT` would return the same page forever; a boundary that sliced
  // the shared value would strand the rows outside the batch.
  //
  // `rate_limits` is the plan's natural fixture for this: its watermark is
  // `window_start` and its primary key is `(bucket, window_start)`, so seven rows can
  // share one watermark value while remaining distinct rows. (`throttle_events` cannot
  // — its watermark *is* its primary key, so a shared watermark is impossible there by
  // construction, which is exactly why it is the wrong table to test this on.)
  //
  // This is the case the batch boundary exists for, and the one an earlier
  // implementation got wrong twice: first by slicing the value, then by reporting
  // "more" when the boundary was already the last row, which re-pushed the same page
  // until the per-table page ceiling stopped it.
  const buckets = Array.from({ length: 7 }, (_, n) => `('b${n}',1000,1,1000)`);
  const h = await sqliteHarness(
    t,
    [`INSERT INTO rate_limits (bucket, window_start, count, updated_at) VALUES ${buckets.join(",")}`],
    { env: { BACKUP_READ_BATCH: "3", BACKUP_PUSH_BATCH: "3" } },
  );
  if (!h) return;

  const summary = await h.sync.run({ force: true, only: ["rate_limits"] });

  assert.deepEqual(summary.failures, []);
  // The seven seeded rows, plus the run's own lease row — which lives in this table and
  // is therefore mirrored too. What matters is that *no row is lost*: all seven seeded
  // buckets arrive even though they share one watermark value.
  assert.ok(summary.rows >= 7, `expected at least the 7 shared rows, got ${summary.rows}`);
  const mirrored = h.supabase.mirror.get("rate_limits") ?? [];
  for (let n = 0; n < 7; n++) {
    assert.ok(
      mirrored.some((r) => r["bucket"] === `b${n}`),
      `bucket b${n} was not mirrored — the shared watermark was sliced`,
    );
  }
  assert.ok(Number(h.supabase.state.get("rate_limits")?.["last_cursor"]) >= 1000, "the cursor must reach at least the shared value");

  // A second run must not grow the mirror. It re-reads the boundary value once (the
  // first page of a run is inclusive, for at-least-once) and then stops, so the repeat
  // is an upsert of rows already present rather than new rows.
  const mirroredBefore = (h.supabase.mirror.get("rate_limits") ?? []).length;
  const again = await h.sync.run({ force: true, only: ["rate_limits"] });
  assert.equal(
    (h.supabase.mirror.get("rate_limits") ?? []).length,
    mirroredBefore,
    "a no-op run added rows to the mirror",
  );
  const distinctBuckets = new Set(
    (h.supabase.mirror.get("rate_limits") ?? []).map((r) => r["bucket"]),
  );
  assert.equal(distinctBuckets.size, mirroredBefore, "the mirror holds duplicate keys");
  assert.ok(again.rows <= 7, `a no-op run should re-push at most one shared value, got ${again.rows}`);
});

test("a large table is mirrored across several pages in one run", async (t) => {
  const values = Array.from({ length: 25 }, (_, n) => `(${n + 1},'x','2024-03','ia_fetch',1,${1000 + n})`);
  const h = await sqliteHarness(
    t,
    [`INSERT INTO usage_ledger (id, domain, month, kind, value, recorded_at) VALUES ${values.join(",")}`],
    { env: { BACKUP_READ_BATCH: "10", BACKUP_PUSH_BATCH: "10" } },
  );
  if (!h) return;

  const summary = await h.sync.run({ force: true });
  assert.deepEqual(summary.failures, []);
  // 25 seeded rows, plus whatever `rate_limits` carries from this run's lease.
  assert.ok(summary.rows >= 25, `expected at least 25 rows, got ${summary.rows}`);
  const result = summary.tables.find((x) => x.table === "usage_ledger");
  assert.ok(result && result.batches >= 3, `expected 3+ batches, got ${result?.batches}`);
  assert.equal(Number(h.supabase.state.get("usage_ledger")?.["last_cursor"]), 25);
  assert.equal(h.supabase.mirror.get("usage_ledger")?.length, 25);
});

test("a failed push leaves the cursor where it started so rows are never skipped", async (t) => {
  // The clock advances between runs because the lease is a window derived from it: two
  // runs at one instant are correctly treated as concurrent, and the second would be
  // refused before reaching the push this test is about.
  let clock = 1_700_000_000;
  const h = await sqliteHarness(
    t,
    [
      `INSERT INTO usage_ledger (id, domain, month, kind, value, recorded_at)
       VALUES (10,'x','2024-03','ia_fetch',1,1000),(11,'x','2024-03','ia_fetch',1,1001),
              (12,'x','2024-03','ia_fetch',1,1002),(13,'x','2024-03','ia_fetch',1,1003)`,
    ],
    { now: () => clock },
  );
  if (!h) return;

  // First run succeeds and commits the cursor.
  await h.sync.run({ force: true });
  assert.equal(Number(h.supabase.state.get("usage_ledger")?.["last_cursor"]), 13);
  clock += 600;

  // New rows, and this time PostgREST refuses them with a non-retryable error.
  h.raw.exec(
    `INSERT INTO usage_ledger (id, domain, month, kind, value, recorded_at)
     VALUES (20,'x','2024-03','ia_fetch',1,3000),(21,'x','2024-03','ia_fetch',1,3001),
            (22,'x','2024-03','ia_fetch',1,3002),(23,'x','2024-03','ia_fetch',1,3003)`,
  );
  h.supabase.failNext.set("usage_ledger", {
    status: 400,
    body: JSON.stringify({ code: "23502", message: "null value in column violates not-null" }),
  });

  const failed = await h.sync.run({ force: true });
  assert.deepEqual(failed.failures, ["usage_ledger"]);
  const state = h.supabase.state.get("usage_ledger")!;
  assert.equal(
    Number(state["last_cursor"]),
    13,
    "the cursor moved past rows the mirror refused Ã¢â‚¬â€ they would never be retried",
  );
  assert.equal(Number(state["consecutive_fails"]), 1);
  assert.match(String(state["last_error"]), /23502/);

  // The next run reads from 13 again and succeeds.
  clock += 600;
  const recovered = await h.sync.run({ force: true, only: ["usage_ledger"] });
  assert.deepEqual(recovered.failures, []);
  // Row 13 was already mirrored, but the inclusive first page re-reads it — the
  // at-least-once contract — so the recovered run carries 13's row plus the four new
  // ones. What matters is that nothing the mirror refused was skipped.
  const recoveredLedger = recovered.tables.find((x) => x.table === "usage_ledger");
  assert.equal(recoveredLedger?.rows, 5, `recovered detail: ${JSON.stringify(recoveredLedger)}`);
  assert.equal(Number(h.supabase.state.get("usage_ledger")?.["last_cursor"]), 23);
});

test("a retryable failure is retried, and a persistent one is reported as such", async (t) => {
  const h = await sqliteHarness(t, [
    `INSERT INTO assets (hash, mime, bytes, r2_key, first_seen_at, ref_count, r2_deleted_at)
     VALUES ('h0','text/css',10,'a/h0',1000,1,1000),('h1','text/css',11,'a/h1',1001,1,1001)`,
  ]);
  if (!h) return;

  // 503 twice, then success â€” the transient case the backoff exists for.
  const attempts: number[] = [];
  const flaky: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/rest/v1/assets") && (init?.method ?? "").toUpperCase() === "POST") {
      attempts.push(attempts.length + 1);
      if (attempts.length <= 2) return new Response("upstream unavailable", { status: 503 });
    }
    return h.supabase.fetch(input, init);
  };

  // A fresh syncer with the flaky transport and no real backoff delay.
  const sync = new BackupSync(
    {
      DB: h.db.binding(),
      SUPABASE_URL: "https://t.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    } as never,
    { now: () => 1_700_000_000, fetchImpl: flaky, sleep: async () => {} },
  );

  const summary = await sync.run({ force: true, only: ["assets"] });
  assert.deepEqual(summary.failures, [], "a 503 twice should still end in success");
  assert.equal(attempts.length, 3, "expected two failures then a success");
  assert.equal(summary.rows, 2);
});

test("a bad service-role key is reported, not retried into a timeout", async (t) => {
  const h = await sqliteHarness(t, [
    `INSERT INTO assets (hash, mime, bytes, r2_key, first_seen_at, ref_count, r2_deleted_at)
     VALUES ('h0','text/css',10,'a/h0',1000,1,1000)`,
  ]);
  if (!h) return;
  h.supabase.failAll.status = 401;
  h.supabase.failAll.body = JSON.stringify({
    code: "42501",
    message: "permission denied for schema cw_backup",
  });

  const summary = await h.sync.run({ force: true, only: ["assets"] });
  assert.deepEqual(summary.failures, ["assets"]);
  const error = summary.tables.find((x) => x.table === "assets")?.error ?? "";
  assert.match(error, /401/);
  assert.match(error, /permission denied/);
  // One request, not three: a 401 is an operator problem and retrying hides it.
  assert.equal(h.supabase.pushCount("assets"), 1);
});

test("the lease stops two runs from overlapping", async (t) => {
  const h = await sqliteHarness(t, []);
  if (!h) return;

  assert.equal(
    await h.sync.acquireLease(BACKUP_DEFAULTS.leaseSeconds),
    true,
    "the first run should own the window",
  );
  assert.equal(
    await h.sync.acquireLease(BACKUP_DEFAULTS.leaseSeconds),
    false,
    "a second claim on the same window must fail",
  );

  // A fresh clock past the lease window can claim again.
  const later = new BackupSync(
    {
      DB: h.db.binding(),
      SUPABASE_URL: "https://t.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    } as never,
    {
      now: () => 1_700_000_000 + BACKUP_DEFAULTS.leaseSeconds + 1,
      fetchImpl: new FakeSupabase().fetch,
    },
  );
  assert.equal(await later.acquireLease(BACKUP_DEFAULTS.leaseSeconds), true);
});

test("an interval that has not elapsed stops the run before any row is read", async (t) => {
  const h = await sqliteHarness(
    t,
    [
      `INSERT INTO assets (hash, mime, bytes, r2_key, first_seen_at, ref_count, r2_deleted_at)
       VALUES ('h0','text/css',10,'a/h0',1000,1,1000)`,
    ],
    { env: { BACKUP_INTERVAL_SECONDS: "900" } },
  );
  if (!h) return;

  // Nothing has ever succeeded, so the first run is due.
  const first = await h.sync.run({ force: true });
  assert.ok(first.rows > 0, `the first run should have synced; got ${JSON.stringify(first)}`);

  // A second automatic run immediately afterwards is not.
  const second = await h.sync.run();
  assert.equal(second.rows, 0);
  assert.ok(
    second.stoppedBecause === "quota" || second.stoppedBecause === "lease",
    `unexpected stop reason: ${second.stoppedBecause}`,
  );
  assert.equal(second.tables.length, 0, "the interval gate should short-circuit before reading");
});

test("status reports what is pending, counted from D1 rather than trusted", async (t) => {
  const h = await sqliteHarness(t, [
    `INSERT INTO usage_ledger (id, domain, month, kind, value, recorded_at) VALUES
     (10,'x','2024-03','ia_fetch',1,1000),(11,'x','2024-03','ia_fetch',1,1001),
     (12,'x','2024-03','ia_fetch',1,1002),(13,'x','2024-03','ia_fetch',1,1003),
     (14,'x','2024-03','ia_fetch',1,1004)`,
  ]);
  if (!h) return;
  const { sync, raw } = h;

  // Before any run: everything is pending, because no cursor exists.
  const cold = await sync.status();
  assert.equal(cold.configured, true);
  assert.equal(cold.reachable, true);
  const ledgerCold = cold.tables.find((x) => x.table === "usage_ledger");
  assert.equal(ledgerCold?.pendingRows, 5);
  assert.equal(ledgerCold?.lastSuccessAt, null);
  assert.equal(ledgerCold?.lagSeconds, null);
  assert.equal(cold.health, "behind", "a table that has never synced is not healthy");

  await sync.run({ force: true, only: ["usage_ledger"] });

  const warm = await sync.status();
  const ledgerWarm = warm.tables.find((x) => x.table === "usage_ledger");
  assert.equal(ledgerWarm?.pendingRows, 0);
  assert.equal(ledgerWarm?.consecutiveFails, 0);
  assert.ok(ledgerWarm && ledgerWarm.lastSuccessAt !== null);

  // New rows show up as pending, with no run needed to notice them.
  raw.exec(
    `INSERT INTO usage_ledger (id, domain, month, kind, value, recorded_at)
     VALUES (20,'x','2024-03','ia_fetch',1,4000),(21,'x','2024-03','ia_fetch',1,4001),(22,'x','2024-03','ia_fetch',1,4002)`,
  );
  const after = await sync.status();
  assert.equal(after.tables.find((x) => x.table === "usage_ledger")?.pendingRows, 3);
});

test("status reports an unreachable mirror instead of throwing", async (t) => {
  const h = await sqliteHarness(t, [
    `INSERT INTO assets (hash, mime, bytes, r2_key, first_seen_at, ref_count, r2_deleted_at)
     VALUES ('h0','text/css',10,'a/h0',1000,1,1000)`,
  ]);
  if (!h) return;

  const sync = new BackupSync(
    {
      DB: h.db.binding(),
      SUPABASE_URL: "https://t.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    } as never,
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

test("status flags drift without failing", async (t) => {
  const raw = await openSqlite(t);
  if (!raw) return;

  // `assets` without `mime`: the plan knows a column D1 does not have.
  raw.exec(`CREATE TABLE assets (
    hash TEXT PRIMARY KEY, bytes INTEGER, r2_key TEXT, first_seen_at INTEGER,
    ref_count INTEGER, r2_deleted_at INTEGER)`);
  const db = new SqliteD1(raw);
  const sync = new BackupSync(
    {
      DB: db.binding(),
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    } as never,
    { now: () => 1_700_000_000, fetchImpl: new FakeSupabase().fetch },
  );

  const status = await sync.status();
  assert.equal(status.health, "drift");
  assert.ok(
    status.drift.some((d) => d.detail.includes("mime") || d.kind === "missing-table"),
    JSON.stringify(status.drift),
  );
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// 6. The generated SQL against real SQLite
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//
// Everything above runs against a hand-written fake, which by construction agrees
// with whatever the code does. These two run the *generated statements* through a
// real SQLite engine, so window functions, `COALESCE` in a `WHERE`, and the batch
// boundary are all evaluated by the same parser D1 uses. That is the only way to
// catch a query that is well-formed TypeScript and wrong SQL.
//
// The case that matters is a watermark shared by more rows than one batch:
//
//   * a plain `LIMIT` would return the same rows every run and never advance;
//   * an over-eager boundary would slice the shared value, and the rows outside the
//     batch would be skipped forever once the cursor moved past them.

test("the generated read query advances a cursor over rows that share a watermark", async (t) => {
  const raw = await openSqlite(t);
  if (!raw) return;

  sqliteTables(raw);

  // `rate_limits` is the plan's clearest case: its watermark is `window_start`, five
  // rows share one window, and its key is composite.
  const shared = 1_000;
  for (let i = 0; i < 5; i++) {
    raw.exec(
      `INSERT INTO rate_limits (bucket, window_start, count, updated_at) VALUES ('b${i}', ${shared}, 1, ${shared})`,
    );
  }
  raw.exec(
    `INSERT INTO rate_limits (bucket, window_start, count, updated_at) VALUES ('later', ${shared + 60}, 1, ${shared + 60})`,
  );

  const plan = BACKUP_TABLES.find((p) => p.name === "rate_limits")!;
  const batchSize = 3;

  // Walk the cursor the way `BackupSync` does: read a batch, take the highest `__wm`
  // it carried as the next cursor, stop when the statement says there is no more.
  //
  // `strict` after the first pass, because that is what the syncer does and what makes
  // the walk terminate: the boundary value is re-read inclusively only once per run, and
  // re-reading it on every pass is the livelock (`> ` vs `>=`) this test exists to catch.
  const seen = new Set<string>();
  let cursor = "0";

  for (let pass = 0; pass < 20; pass++) {
    const rows = raw
      .prepare(d1ReadSql(plan, batchSize, { strict: pass > 0 }))
      .all(...d1ReadParams(plan, cursor)) as BackupRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      // A row must never arrive twice across passes: that would mean the boundary
      // sliced a value and the cursor went backwards over it.
      assert.ok(!seen.has(String(row["bucket"])), `"${row["bucket"]}" was read in two batches`);
      seen.add(String(row["bucket"]));
    }

    const last = rows[rows.length - 1]!;
    cursor = String(last["__wm"]);
    if (last["__more"] == null) break;
  }

  assert.equal(
    seen.size,
    6,
    `saw ${[...seen].join(", ")} Ã¢â‚¬â€ a cursor walk must reach every row exactly once`,
  );
});

test("a value shared by more rows than a batch is taken whole, never sliced", async (t) => {
  const raw = await openSqlite(t);
  if (!raw) return;

  sqliteTables(raw);
  for (let i = 0; i < 4; i++) {
    raw.exec(
      `INSERT INTO rate_limits (bucket, window_start, count, updated_at) VALUES ('b${i}', 1000, 1, 1000)`,
    );
  }

  const plan = BACKUP_TABLES.find((p) => p.name === "rate_limits")!;
  // A batch of 2 against 4 rows that all share one watermark.
  const rows = raw
    .prepare(d1ReadSql(plan, 2))
    .all(...d1ReadParams(plan, "0")) as BackupRow[];

  assert.equal(
    rows.length,
    4,
    "a shared watermark value must be returned whole Ã¢â‚¬â€ slicing it would strand the extra rows",
  );
  assert.ok(
    rows.every((r) => Number(r["__wm"]) === 1000),
    "every returned row should carry the shared watermark as its cursor value",
  );
  // Nothing follows the boundary, so the statement says so and the walk stops rather
  // than asking again forever.
  assert.equal(
    rows[rows.length - 1]!["__more"],
    null,
    "four rows at one watermark, a batch of two: there is nothing after them",
  );
});

test("the batch says there is more, so a full batch is not mistaken for the end", async (t) => {
  const raw = await openSqlite(t);
  if (!raw) return;

  sqliteTables(raw);
  for (let i = 0; i < 4; i++) {
    raw.exec(
      `INSERT INTO rate_limits (bucket, window_start, count, updated_at) VALUES ('b${i}', ${2000 + i}, 1, 1)`,
    );
  }

  const plan = BACKUP_TABLES.find((p) => p.name === "rate_limits")!;
  // One batch of 2 out of 4 distinct values: exactly full, and there is more.
  const first = raw.prepare(d1ReadSql(plan, 2)).all(...d1ReadParams(plan, "0")) as BackupRow[];
  assert.equal(first.length, 2);
  assert.notEqual(
    first[first.length - 1]!["__more"],
    null,
    "a capped batch must report that more rows follow Ã¢â‚¬â€ a row count cannot tell the difference",
  );

  // The second batch continues strictly above the boundary, which is what makes the
  // walk terminate, and reports the end.
  const second = raw
    .prepare(d1ReadSql(plan, 2, { strict: true }))
    .all(...d1ReadParams(plan, String(first[first.length - 1]!["__wm"]))) as BackupRow[];
  assert.equal(second.length, 2);
  assert.equal(second[second.length - 1]!["__more"], null);
  assert.notEqual(second[0]!["bucket"], first[0]!["bucket"], "the second batch must be new rows");
});

/** Open an in-memory SQLite database, skipping the test when the module is absent. */
async function openSqlite(t: { skip(reason: string): void }): Promise<SqliteDb | null> {
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => SqliteDb;
    };
    return new DatabaseSync(":memory:");
  } catch {
    t.skip("node:sqlite is not available in this Node build");
    return null;
  }
}

/**
 * The minimal `node:sqlite` surface these tests use.
 *
 * Declared structurally rather than imported, because `node:sqlite` is behind a flag
 * on some Node 22 releases and a hard import would fail the whole bundle rather than
 * skipping the handful of tests that need it.
 */
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
}

/**
 * The plan's tables, created in real SQLite.
 *
 * Shared by the SQL-level tests and the end-to-end ones, so both are exercising the
 * same schema: the plan is the single source of truth for what a D1 table looks like,
 * down to which columns are the primary key.
 */
function sqliteTables(db: SqliteDb): void {
  for (const plan of BACKUP_TABLES) {
    const columns = plan.columns.map((c) => {
      const type = c.sqliteType === "INTEGER" || c.sqliteType === "BOOLEAN" ? "INTEGER" : "TEXT";
      return `${c.name} ${type}`;
    });
    const keys = plan.columns.filter((c) => c.key).map((c) => c.name);
    const keyClause = keys.length > 0 ? `, PRIMARY KEY (${keys.join(", ")})` : "";
    db.exec(`CREATE TABLE ${plan.name} (${columns.join(", ")}${keyClause})`);
  }
}

/**
 * A `D1Database` backed by real SQLite.
 *
 * This is what the end-to-end tests run against, and it is a deliberate choice over a
 * hand-written fake. A fake encodes *my belief* about what the generated SQL means,
 * and the belief is exactly what needs testing Ã¢â‚¬â€ the batch boundary for a shared
 * watermark was wrong three times, and each wrong version passed a fake that agreed
 * with it. Real SQLite does not agree with anything; it evaluates the statement.
 *
 * D1's `all()` returns `{ results }` and `first()` a row or null, which is all the
 * syncer uses. Parameters are passed straight through, so a placeholder left unbound
 * fails here exactly as it would in production.
 */
class SqliteD1 {
  readonly unrecognised: string[] = [];

  constructor(private readonly db: SqliteDb) {}

  binding(): D1Database {
    const self = this;
    return {
      prepare(sql: string) {
        let params: unknown[] = [];
        const stmt = {
          bind(...values: unknown[]) {
            params = values;
            return stmt;
          },
          async all<T>(): Promise<{ results: T[] }> {
            try {
              return { results: self.db.prepare(sql).all(...params) as T[] };
            } catch (err) {
              self.unrecognised.push(`${sql.slice(0, 120)} :: ${(err as Error).message}`);
              throw err;
            }
          },
          async first<T>(): Promise<T | null> {
            try {
              return ((self.db.prepare(sql).all(...params)[0] as T) ?? null);
            } catch (err) {
              self.unrecognised.push(`${sql.slice(0, 120)} :: ${(err as Error).message}`);
              throw err;
            }
          },
          async run(): Promise<{ success: true; meta: { changes: number } }> {
            return { success: true, meta: { changes: 0 } };
          },
        };
        return stmt as unknown as D1PreparedStatement;
      },
    } as unknown as D1Database;
  }
}

/**
 * A full harness over real SQLite: seed rows with plain SQL, run the syncer, assert
 * against the mirror.
 *
 * Every request the syncer makes goes to the stub Supabase, so a test can also assert
 * how many round trips a run cost Ã¢â‚¬â€ which is the whole reason the high-water gate
 * exists.
 */
async function sqliteHarness(
  t: { skip(reason: string): void },
  seed: string[],
  options: { env?: Record<string, string>; now?: () => number } = {},
): Promise<{ raw: SqliteDb; db: SqliteD1; supabase: FakeSupabase; sync: BackupSync } | null> {
  const raw = await openSqlite(t);
  if (!raw) return null;

  sqliteTables(raw);
  for (const statement of seed) raw.exec(statement);

  const db = new SqliteD1(raw);
  const supabase = new FakeSupabase();
  const env: Record<string, unknown> = {
    DB: db.binding(),
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_SCHEMA: "cw_backup",
    ...(options.env ?? {}),
  };
  const sync = new BackupSync(env as never, {
    now: options.now ?? (() => 1_700_000_000),
    fetchImpl: supabase.fetch,
  });
  return { raw, db, supabase, sync };
}

