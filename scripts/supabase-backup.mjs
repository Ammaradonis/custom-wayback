#!/usr/bin/env node
/**
 * Supabase backup management: provision, migrate, configure, inspect, restore.
 *
 * This is the **management plane** for the mirror. It is deliberately separate
 * from the **data plane**, which lives in the Worker (`apps/api/src/lib/backup.ts`)
 * and runs on the cron trigger. The split is not tidiness — it is a security
 * boundary:
 *
 *   * This script needs a **personal access token** (`sbp_…`), which can create
 *     and destroy projects. It runs on your machine, by hand.
 *   * The Worker needs only the project **service-role key**, which reaches one
 *     schema. It runs unattended, on a schedule.
 *
 * Nothing here is imported by the Worker, so a personal access token can never be
 * bundled into a deployment.
 *
 * ## Token handling
 *
 * The token is read from, in order: `--token`, `$SUPABASE_ACCESS_TOKEN`, or the
 * `SUPABASE_ACCESS_TOKEN=` line of a dotenv file (`--env-file`, default
 * `env.txt`). It is **never** printed, logged, or included in an error message, and
 * no command echoes a key. Output is limited to lengths and `ref`s so that a
 * pasted transcript is safe to share.
 *
 * ## Commands
 *
 *   status                 what exists, and is the mirror reachable
 *   create                 create the project (idempotent — reports an existing one)
 *   apply                  apply supabase/migrations/*.sql in order
 *   expose                 add the mirror schema to PostgREST's schema list
 *   env                    print the .dev.vars lines to paste (secrets included)
 *   verify                 run supabase/verify.sql against the live mirror
 *   projects               list projects in the organisation
 *   sql <file>             run one SQL file
 *
 * Usage:
 *   node scripts/supabase-backup.mjs status
 *   node scripts/supabase-backup.mjs apply --project-ref=<ref>
 *   node scripts/supabase-backup.mjs env --project-ref=<ref>
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const API = "https://api.supabase.com";

/** Project name used when creating. Matches the D1 database's purpose. */
const PROJECT_NAME = "custom-wayback";
const DEFAULT_REGION = "eu-central-1";
/** The mirrored schema. Must match `SUPABASE_SCHEMA` and the DDL. */
const MIRROR_SCHEMA = "cw_backup";

// ── Arguments ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, ...rest] = arg.slice(2).split("=");
      args.flags[key] = rest.length > 0 ? rest.join("=") : "true";
    } else {
      args._.push(arg);
    }
  }
  return args;
}

const argv = parseArgs(process.argv.slice(2));
const command = argv._[0] ?? "help";
const flag = (name, fallback) => argv.flags[name] ?? fallback;

// ── Output ────────────────────────────────────────────────────────────────────

const color = process.stdout.isTTY
  ? { red: (s) => `\u001b[31m${s}\u001b[0m`, green: (s) => `\u001b[32m${s}\u001b[0m`,
      yellow: (s) => `\u001b[33m${s}\u001b[0m`, dim: (s) => `\u001b[2m${s}\u001b[0m`,
      bold: (s) => `\u001b[1m${s}\u001b[0m` }
  : { red: (s) => s, green: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s };

let failures = 0;

function pass(message) {
  console.log(`  ${color.green("OK")}    ${message}`);
}
function fail(message) {
  failures += 1;
  console.log(`  ${color.red("FAIL")}  ${message}`);
}
function warn(message) {
  console.log(`  ${color.yellow("WARN")}  ${message}`);
}
function info(message) {
  console.log(`  ${color.dim("·")}     ${message}`);
}
function heading(title) {
  console.log(`\n${color.bold(title)}`);
}

// ── Token ─────────────────────────────────────────────────────────────────────

/**
 * Read the personal access token without ever putting it in a log.
 *
 * A missing token is the single most likely failure here, so the error names every
 * place it looked rather than just the first.
 */
async function readToken() {
  const inline = flag("token");
  if (inline && inline !== "true") return inline;

  const fromEnv = process.env["SUPABASE_ACCESS_TOKEN"];
  if (fromEnv) return fromEnv.trim();

  const envFile = resolve(ROOT, flag("env-file", "env.txt"));
  if (existsSync(envFile)) {
    const text = await readFile(envFile, "utf8");
    // Anchored to the start of a line and tolerant of quotes, the same way the
    // shell that wrote the file would be.
    const match = /^\s*SUPABASE_ACCESS_TOKEN\s*=\s*(.+?)\s*$/m.exec(text);
    if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, "");
  }

  throw new Error(
    [
      "No SUPABASE_ACCESS_TOKEN found. Looked in:",
      "  --token=<value>",
      "  $SUPABASE_ACCESS_TOKEN",
      `  ${envFile} (SUPABASE_ACCESS_TOKEN=…)`,
      "",
      "Create one at https://supabase.com/dashboard/account/tokens and keep it out of git.",
    ].join("\n"),
  );
}

// ── Management API ────────────────────────────────────────────────────────────

let token = null;

async function api(path, { method = "GET", body } = {}) {
  token ??= await readToken();
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    // The response body can echo a project URL but never the token; the token is
    // only ever in the request header. Still, this is the one place a credential
    // could leak, so the message is built from the parsed `message` field only.
    const detail =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String(parsed.message)
        : String(parsed ?? "").slice(0, 300);
    const error = new Error(`Supabase API ${method} ${path} → ${response.status}: ${detail}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

/** Run SQL against the project through the Management API. */
async function runSql(projectRef, query) {
  return api(`/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    body: { query },
  });
}

// ── Project resolution ────────────────────────────────────────────────────────

let cachedProjects = null;

async function listProjects() {
  cachedProjects ??= (await api("/v1/projects")) ?? [];
  return cachedProjects;
}

/**
 * Work out which project to act on.
 *
 * Resolution order is explicit-ref, then `.dev.vars`, then the project named
 * `custom-wayback`, then "the only one". The `.dev.vars` step matters: after
 * `env` has been run once, every later command should need no arguments, and a
 * second project created by mistake would otherwise be picked up silently.
 */
async function resolveProject() {
  const explicit = flag("project-ref");
  const projects = await listProjects();

  if (explicit && explicit !== "true") {
    const found = projects.find((p) => p.id === explicit);
    if (!found) throw new Error(`No project with ref ${explicit} in this organisation.`);
    return found;
  }

  const fromDevVars = await readDevVarsUrl();
  if (fromDevVars) {
    const found = projects.find((p) => p.id === fromDevVars);
    if (found) return found;
  }

  const named = projects.find((p) => p.name === PROJECT_NAME);
  if (named) return named;

  if (projects.length === 1) return projects[0];

  throw new Error(
    projects.length === 0
      ? "No projects in this organisation. Run `create` first."
      : `Several projects exist and none is named "${PROJECT_NAME}". Pass --project-ref=<ref>.`,
  );
}

/** Pull the project ref out of `apps/api/.dev.vars`, if it is there. */
async function readDevVarsUrl() {
  const path = join(ROOT, "apps", "api", ".dev.vars");
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  const match = /^\s*SUPABASE_URL\s*=\s*https:\/\/([a-z0-9]+)\.supabase\.co/m.exec(text);
  return match?.[1] ?? null;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdProjects() {
  heading("Projects");
  const projects = await listProjects();
  if (projects.length === 0) {
    info("none — run `create`");
    return;
  }
  for (const p of projects) {
    console.log(`  ${p.id}  ${p.name}  ${p.region}  ${p.status}`);
  }
}

async function cmdStatus() {
  await cmdProjects();

  const projects = await listProjects();
  if (projects.length === 0) {
    warn("No project yet. Run: node scripts/supabase-backup.mjs create");
    return;
  }

  const project = await resolveProject();
  heading(`Project ${project.id}`);
  info(`name      ${project.name}`);
  info(`region    ${project.region}`);
  info(`status    ${project.status}`);
  info(`postgres  ${project.database?.version ?? "unknown"}`);

  heading("Mirror schema");
  const present = await runSql(
    project.id,
    `select exists (select 1 from information_schema.schemata where schema_name = '${MIRROR_SCHEMA}') as present;`,
  );
  const hasSchema = Boolean(present?.[0]?.present);

  if (!hasSchema) {
    fail(`schema "${MIRROR_SCHEMA}" does not exist — run: apply`);
    return;
  }
  pass(`schema "${MIRROR_SCHEMA}" exists`);

  const counts = await runSql(
    project.id,
    `select * from ${MIRROR_SCHEMA}.backup_counts order by table_name;`,
  );
  const tracked = await runSql(
    project.id,
    `select table_name, last_cursor, last_success_at, consecutive_fails
       from ${MIRROR_SCHEMA}.backup_state order by table_name;`,
  );

  info(`${counts?.length ?? 0} mirrored table(s), ${tracked?.length ?? 0} with recorded state`);
  for (const row of counts ?? []) {
    const state = (tracked ?? []).find((t) => t.table_name === row.table_name);
    const lag =
      state?.last_success_at == null
        ? color.yellow("never synced")
        : `${Math.max(0, Math.floor(Date.now() / 1000) - Number(state.last_success_at))}s ago`;
    console.log(
      `    ${String(row.table_name).padEnd(18)} ${String(row.mirrored_rows).padStart(8)} rows   ${lag}`,
    );
  }

  heading("PostgREST exposure");
  const exposed = await api(`/v1/projects/${project.id}/postgrest`);
  const schemas = exposed?.db_schema ?? "";
  if (schemas.split(",").includes(MIRROR_SCHEMA)) {
    pass(`"${MIRROR_SCHEMA}" is in db_schema (${schemas})`);
  } else {
    fail(`"${MIRROR_SCHEMA}" is not in db_schema (currently "${schemas}") — run: expose`);
  }

  heading("Run-state");
  if (project.status === "ACTIVE_HEALTHY") {
    pass("project is ACTIVE_HEALTHY and will accept writes");
  } else {
    fail(`project status is ${project.status} — a paused project cannot be backed up`);
    info("a free project pauses after 7 days with no API activity; the cron run is the activity that prevents it");
  }
}

async function cmdCreate() {
  const projects = await listProjects();
  const existing = projects.find((p) => p.name === PROJECT_NAME);
  if (existing) {
    pass(`project already exists: ${existing.id} (${existing.region}, ${existing.status})`);
    info("nothing to do; `apply` will bring the schema up to date");
    return;
  }

  const orgs = await api("/v1/organizations");
  const org = orgs?.[0];
  if (!org) throw new Error("No organisation on this account; create one in the dashboard first.");

  const region = flag("region", DEFAULT_REGION);
  heading(`Creating "${PROJECT_NAME}" in ${region}`);
  info(`organisation ${org.id}`);

  // Generated here and never printed. A project's database password is only shown
  // once at creation, and nothing in this integration needs it — the Worker talks
  // PostgREST and this script talks the Management API — so the value is discarded
  // after the request rather than stored anywhere it could leak from.
  const dbPass = generatePassword(40);

  const created = await api("/v1/projects", {
    method: "POST",
    body: {
      name: PROJECT_NAME,
      organization_id: org.id,
      region,
      db_pass: dbPass,
      plan: flag("plan", "free"),
    },
  });

  pass(`created ${created.id} (${created.region}, ${created.status})`);
  heading("Next");
  console.log(`  node scripts/supabase-backup.mjs apply  --project-ref=${created.id}`);
  console.log(`  node scripts/supabase-backup.mjs expose --project-ref=${created.id}`);
  console.log(`  node scripts/supabase-backup.mjs env    --project-ref=${created.id}`);
}

function generatePassword(length) {
  // `crypto.getRandomValues` is a Web Crypto global in Node 22, so this needs no
  // import and works identically if the script is ever run elsewhere.
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

async function cmdApply() {
  const project = await resolveProject();

  const names = await readdir(MIGRATIONS_DIR);
  const files = names.filter((n) => n.endsWith(".sql")).sort();

  heading(`Applying migrations to ${project.id}`);
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    try {
      await runSql(project.id, sql);
      pass(file);
    } catch (err) {
      fail(`${file}: ${err.message}`);
      throw err;
    }
  }

  heading("Verifying");
  const counts = await runSql(
    project.id,
    `select count(*)::int as n from information_schema.tables where table_schema = '${MIRROR_SCHEMA}';`,
  );
  pass(`${counts?.[0]?.n ?? 0} table(s) in "${MIRROR_SCHEMA}"`);
}

/**
 * Add the mirror schema to PostgREST's `db_schema`.
 *
 * Without this, every push answers `404 PGRST205: Could not find the table
 * 'cw_backup.users' in the schema cache` — an error that reads like a missing
 * table and is really a missing configuration line.
 *
 * `public` is preserved rather than replaced: Supabase's own tooling and anything
 * else you add later expects to find it, and dropping it would be a side effect of
 * a backup feature.
 */
async function cmdExpose() {
  const project = await resolveProject();
  const current = await api(`/v1/projects/${project.id}/postgrest`);
  const schemas = String(current?.db_schema ?? "public")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  heading(`Exposing "${MIRROR_SCHEMA}" on ${project.id}`);
  info(`db_schema is currently "${schemas.join(",")}"`);

  if (schemas.includes(MIRROR_SCHEMA)) {
    pass("already exposed");
    return;
  }

  const next = [...schemas, MIRROR_SCHEMA].join(",");
  await api(`/v1/projects/${project.id}/postgrest`, {
    method: "PATCH",
    body: { db_schema: next },
  });
  pass(`db_schema is now "${next}"`);
  warn("PostgREST reloads its schema cache within a few seconds; a push right now may 404 once");
}

/**
 * Print the two lines to paste into `apps/api/.dev.vars`.
 *
 * This is the only command that prints a secret, and it prints one the operator
 * already owns and is about to paste into a git-ignored file. The **personal access
 * token is still never printed** — only the project's own service-role key, which
 * reaches one schema and cannot manage the account.
 */
async function cmdEnv() {
  const project = await resolveProject();

  heading(`Environment for ${project.id}`);
  const keys = await api(`/v1/projects/${project.id}/api-keys?reveal=true`);
  const serviceRole = keys?.find((k) => k.name === "service_role");
  const anon = keys?.find((k) => k.name === "anon");
  const publishable = keys?.find((k) => k.type === "publishable");
  const secret = keys?.find((k) => k.type === "secret");

  if (!serviceRole?.api_key) throw new Error("no service_role key returned; check the token's scopes");

  info(`service_role key length ${serviceRole.api_key.length} (legacy JWT)`);
  if (anon?.api_key) info(`anon key length ${anon.api_key.length}`);
  if (publishable?.api_key) info(`publishable key length ${publishable.api_key.length}`);
  if (secret?.api_key) info(`secret key length ${secret.api_key.length}`);

  console.log(`\n${color.bold("Add to apps/api/.dev.vars:")}\n`);
  console.log(`SUPABASE_URL=https://${project.id}.supabase.co`);
  console.log(`SUPABASE_SERVICE_ROLE_KEY=${serviceRole.api_key}`);
  console.log(`SUPABASE_SCHEMA=${MIRROR_SCHEMA}`);
  console.log("\nBACKUP_ENABLED=true");
  console.log("BACKUP_INTERVAL_SECONDS=900");

  console.log(`\n${color.bold("Then, for the deployment (never in git):")}\n`);
  console.log(`  cd apps/api`);
  console.log(`  npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`);
  console.log(`\n  ${color.dim("SUPABASE_URL is a [vars] entry in wrangler.toml, not a secret.")}`);
}

async function cmdVerify() {
  const project = await resolveProject();
  const sql = await readFile(join(ROOT, "supabase", "verify.sql"), "utf8");

  heading(`Verifying the mirror on ${project.id}`);
  const results = await runSql(project.id, sql);
  // The Management API returns the last statement's rows only, so this reports
  // what it can and points at the file for the rest. `psql -f` runs all of them.
  console.log(JSON.stringify(results, null, 2));
  info("run `psql \"$SUPABASE_DB_URL\" -f supabase/verify.sql` for every check");
}

async function cmdSql() {
  const file = argv._[1];
  if (!file) throw new Error("usage: sql <path-to-.sql>");
  const project = await resolveProject();
  const sql = await readFile(resolve(ROOT, file), "utf8");
  heading(`Running ${file} on ${project.id}`);
  const results = await runSql(project.id, sql);
  console.log(JSON.stringify(results, null, 2));
}

function cmdHelp() {
  console.log(`
Supabase backup management for custom-wayback.

  node scripts/supabase-backup.mjs <command> [--project-ref=<ref>]

Commands
  status      what exists, whether the schema is applied and exposed, and freshness
  create      create the project (idempotent)
  apply       apply supabase/migrations/*.sql in filename order
  expose      add "${MIRROR_SCHEMA}" to PostgREST's db_schema
  env         print the .dev.vars lines and the wrangler secret command
  verify      run supabase/verify.sql against the live mirror
  projects    list projects in the organisation
  sql <file>  run one SQL file

Options
  --project-ref=<ref>   act on this project instead of resolving by name
  --region=<region>     region for \`create\` (default ${DEFAULT_REGION})
  --token=<sbp_…>       personal access token (prefer $SUPABASE_ACCESS_TOKEN)
  --env-file=<path>     dotenv file to read the token from (default env.txt)

The personal access token is never printed. \`env\` prints only the project's
service-role key, which reaches one schema and cannot manage the account.
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const commands = {
  status: cmdStatus,
  create: cmdCreate,
  apply: cmdApply,
  expose: cmdExpose,
  env: cmdEnv,
  verify: cmdVerify,
  sql: cmdSql,
  projects: cmdProjects,
  help: cmdHelp,
};

try {
  const run = commands[command];
  if (!run) {
    console.error(`Unknown command "${command}".\n`);
    cmdHelp();
    process.exit(2);
  }
  await run();
  if (failures > 0) {
    console.log(`\n${color.red(`${failures} check(s) failed`)}`);
    process.exit(1);
  }
  console.log("");
} catch (err) {
  // Only the message. Never a stack with a request object in it — a header could
  // be in scope, and this output is the thing most likely to be pasted somewhere.
  console.error(`\n${color.red("error")}  ${err.message}\n`);
  process.exit(1);
}
