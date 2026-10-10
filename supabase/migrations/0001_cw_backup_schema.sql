-- custom-wayback · Supabase backup schema
-- ============================================================================
--
-- Second copy of the D1 ledger, applied to a Supabase Postgres project. Read this
-- together with `packages/shared/src/backup.ts`, which is the authoritative
-- description of what is mirrored and how the incremental cursor works; this file
-- is that plan expressed as DDL.
--
-- ## Applying it
--
--   node scripts/supabase-backup.mjs apply          # via the Management API
--   # or paste into the Supabase SQL editor
--
-- Every statement is idempotent, so applying twice is a no-op and applying after
-- an edit is safe. There are deliberately no `DROP` statements: a destructive
-- change belongs in a new numbered statement with a comment saying why, not in a
-- file that a re-run will execute again.
--
-- ## Why its own schema
--
-- Not `public`. Supabase's `public` schema is exposed by PostgREST and is where
-- Supabase's own tooling and any future tables of yours will land; keeping the
-- mirror in `cw_backup` means the backup cannot be reached by an anon key that
-- someone later grants a permissive policy to in `public`, and it makes the
-- intent legible in the dashboard.
--
-- ## Why there are no foreign keys
--
-- The mirror is written by an at-least-once upsert pipeline and restored in bulk,
-- and it carries the same rows as its source whether or not their parents arrived
-- first. Foreign keys here would turn an out-of-order batch into a hard failure —
-- buying referential integrity we do not need, at the cost of a write path that
-- stops working exactly when it is most needed. `restore.sql` checks parentage
-- after the load instead.
--
-- ## Why RLS is on with no policies
--
-- A backup of the ledger contains `users.password_hash` and every share token's
-- hash. Supabase exposes this schema over HTTPS to anyone holding the anon key, so
-- the tables are locked down at the database rather than relying on the key never
-- leaking: RLS enabled plus zero policies denies `anon` and `authenticated`
-- outright. Only `service_role`, which is what the Worker and the CLI use, can
-- read or write — and it bypasses RLS by design.
--
-- ## Known free-plan limit
--
-- A Supabase free project is 500 MB. `search_docs` stores extracted page text and
-- `snapshots`/`link_resolutions` grow with every crawl, so a large corpus can
-- exceed it. The syncer surfaces the failure per table instead of dying, and
-- `search_docs` is marked non-restorable in the plan precisely so it can be
-- dropped without loss — it is rebuildable by re-indexing from R2.
-- ============================================================================

create schema if not exists cw_backup;

comment on schema cw_backup is
  'Mirror of the Cloudflare D1 ledger (custom-wayback). Written only by the backup sync; see packages/shared/src/backup.ts.';

-- ── Mirror bookkeeping ──────────────────────────────────────────────────────
-- One row per mirrored table: the highest watermark copied, what happened on the
-- last attempt, and how long it has been since it succeeded. The Worker's
-- /v1/backup/status reads this, and it is the record that answers "is the second
-- copy actually current?" without trusting a log line.

create table if not exists cw_backup.backup_state (
  table_name        text primary key,
  last_cursor       text,
  rows_synced       bigint      not null default 0,
  last_run_at       bigint,
  last_success_at   bigint,
  last_error        text,
  consecutive_fails integer     not null default 0
);

comment on column cw_backup.backup_state.last_cursor is
  'Highest watermark copied so far, as text (watermarks are integers or ULIDs). The next run re-reads at or above it: delivery is at-least-once and the primary key makes the repeat idempotent.';

-- ── Ledger tables ───────────────────────────────────────────────────────────
-- Column names, order and primary keys match D1 exactly so a restore is a
-- mechanical INSERT … SELECT rather than a mapping exercise.

create table if not exists cw_backup.users (
  id            text primary key,
  email         text not null,
  password_hash text not null,
  created_at    bigint not null,
  last_login_at bigint,
  disabled      boolean not null default false
);

create table if not exists cw_backup.sessions (
  id         text primary key,
  user_id    text not null,
  issued_at  bigint not null,
  expires_at bigint not null,
  revoked_at bigint,
  user_agent text,
  ip_hash    text
);
create index if not exists sessions_user_id on cw_backup.sessions (user_id);

create table if not exists cw_backup.domains (
  id              text primary key,
  user_id         text not null,
  domain          text not null,
  host_filter     text,
  budget_json     text not null,
  tracking_status text not null default 'active',
  added_at        bigint not null,
  last_crawled_at bigint,
  coverage_json   text
);
create index if not exists domains_user on cw_backup.domains (user_id, tracking_status);
create index if not exists domains_domain on cw_backup.domains (domain);

create table if not exists cw_backup.ingests (
  id                 text primary key,
  domain_id          text not null,
  month              text not null,
  status             text not null default 'queued',
  pages_total        bigint not null default 0,
  pages_done         bigint not null default 0,
  assets_total       bigint not null default 0,
  assets_done        bigint not null default 0,
  bytes_stored       bigint not null default 0,
  budget_json        text,
  ia_429_count       bigint not null default 0,
  error_message      text,
  started_at         bigint,
  finished_at        bigint,
  queue_msg_id       text,
  stage              text,
  cursor             bigint not null default 0,
  pages_json         text,
  assets_json        text,
  asset_cursor       bigint not null default 0,
  degraded_reason    text,
  day_index_json     text,
  lease_until        bigint,
  attempts           bigint not null default 0,
  stage_attempts     bigint not null default 0,
  consecutive_429    bigint not null default 0,
  breaker_open_until bigint,
  last_throttle_at   bigint
);
create unique index if not exists ingests_domain_month on cw_backup.ingests (domain_id, month);
create index if not exists ingests_status on cw_backup.ingests (status);
create index if not exists ingests_lease on cw_backup.ingests (status, lease_until);

create table if not exists cw_backup.snapshots (
  id             text primary key,
  ingest_id      text not null,
  domain         text not null,
  url            text not null,
  day            text not null,
  ts             text not null,
  status_code    bigint not null,
  mime           text not null,
  digest         text,
  bytes          bigint,
  r2_key         text,
  page_id        text,
  resolved_day   text,
  resolved_ts    text,
  delta_days     bigint,
  served_at      bigint,
  purged_at      bigint,
  content_digest text,
  title          text
);
create index if not exists snapshots_domain_day on cw_backup.snapshots (domain, day);
create index if not exists snapshots_ingest on cw_backup.snapshots (ingest_id);
create index if not exists snapshots_purge on cw_backup.snapshots (served_at, purged_at);
create index if not exists snapshots_domain_url_day on cw_backup.snapshots (domain, url, day);

create table if not exists cw_backup.assets (
  hash          text primary key,
  mime          text not null,
  bytes         bigint not null,
  r2_key        text not null,
  first_seen_at bigint not null,
  ref_count     bigint not null default 1,
  r2_deleted_at bigint
);

create table if not exists cw_backup.link_resolutions (
  id           text primary key,
  domain       text not null,
  day          text not null,
  from_url     text not null,
  to_url       text not null,
  kind         text not null,
  resolved_day text,
  resolved_ts  text,
  delta_days   bigint
);
create index if not exists link_res_domain_day on cw_backup.link_resolutions (domain, day);
create unique index if not exists link_res_unique
  on cw_backup.link_resolutions (domain, day, from_url, to_url);

create table if not exists cw_backup.cdx_surveys (
  id         text primary key,
  domain     text not null,
  month      text not null,
  query_hash text not null,
  payload    bytea not null,
  fetched_at bigint not null
);
create unique index if not exists cdx_survey_unique
  on cw_backup.cdx_surveys (domain, month, query_hash);

create table if not exists cw_backup.usage_ledger (
  id          bigint primary key,
  domain      text,
  month       text,
  kind        text not null,
  value       bigint not null,
  recorded_at bigint not null
);
create index if not exists usage_domain_month on cw_backup.usage_ledger (domain, month);

create table if not exists cw_backup.throttle_events (
  id           bigint primary key,
  domain       text not null,
  month        text,
  ingest_id    text,
  host         text not null,
  status       bigint not null,
  wait_ms      bigint not null,
  attempt      bigint not null default 1,
  breaker_open boolean not null default false,
  kind         text not null default 'backoff',
  created_at   bigint not null
);
create index if not exists throttle_events_domain on cw_backup.throttle_events (domain, created_at);

-- Mirrored mainly because it carries the backup's own run lease, so a failover
-- does not immediately re-run every window.
create table if not exists cw_backup.rate_limits (
  bucket       text not null,
  window_start bigint not null,
  count        bigint not null default 0,
  updated_at   bigint not null,
  primary key (bucket, window_start)
);
create index if not exists rate_limits_window on cw_backup.rate_limits (window_start);

create table if not exists cw_backup.search_docs (
  snapshot_id text primary key,
  domain      text not null,
  url         text not null,
  day         text not null,
  title       text,
  bytes       bigint not null default 0,
  indexed_at  bigint not null
);
create index if not exists search_docs_domain_day on cw_backup.search_docs (domain, day);

create table if not exists cw_backup.share_links (
  id             text primary key,
  user_id        text not null,
  token_hash     text not null,
  domain         text not null,
  month          text,
  day            text,
  url            text,
  label          text,
  created_at     bigint not null,
  expires_at     bigint,
  revoked_at     bigint,
  view_count     bigint not null default 0,
  last_viewed_at bigint
);
create unique index if not exists share_links_token on cw_backup.share_links (token_hash);
create index if not exists share_links_user on cw_backup.share_links (user_id, created_at);

create table if not exists cw_backup.exports (
  id            text primary key,
  user_id       text not null,
  domain        text not null,
  month         text not null,
  r2_key        text not null,
  bytes         bigint not null default 0,
  pages         bigint not null default 0,
  assets        bigint not null default 0,
  missing       bigint not null default 0,
  status        text not null default 'building',
  error_message text,
  created_at    bigint not null,
  finished_at   bigint
);
create index if not exists exports_user_domain on cw_backup.exports (user_id, domain, month);

-- ── Grants ──────────────────────────────────────────────────────────────────
-- `service_role` is what the Worker and the CLI authenticate as. The
-- `authenticator` grant is required for PostgREST to switch into it at all — it
-- is not implied by the privileges on the tables.

grant usage on schema cw_backup to service_role, authenticator;
grant all privileges on all tables in schema cw_backup to service_role;
alter default privileges in schema cw_backup grant all privileges on tables to service_role;

-- ── Lock it down ────────────────────────────────────────────────────────────
-- See the header: RLS with no policies is a deliberate deny for every role except
-- `service_role`, which bypasses RLS entirely.

do $$
declare
  tbl text;
begin
  for tbl in
    select tablename from pg_tables where schemaname = 'cw_backup'
  loop
    execute format('alter table cw_backup.%I enable row level security', tbl);
    execute format('revoke all on cw_backup.%I from anon, authenticated', tbl);
  end loop;
end $$;

-- ── Views: what "fully backed up" means ─────────────────────────────────────
-- A single query an operator or a health check can run to answer whether the
-- second copy exists. `rows_synced` is cumulative per table, not a count of rows
-- in the mirror, so it is reported alongside the mirror's own row count.

create or replace view cw_backup.backup_lag as
select
  s.table_name,
  s.last_cursor,
  s.rows_synced,
  s.last_run_at,
  s.last_success_at,
  s.consecutive_fails,
  s.last_error,
  case
    when s.last_success_at is null then null
    else (extract(epoch from now())::bigint - s.last_success_at)
  end as lag_seconds
from cw_backup.backup_state s;

comment on view cw_backup.backup_lag is
  'Per-table freshness of the mirror. lag_seconds is what GET /v1/backup/status reports as staleness.';

create or replace view cw_backup.backup_counts as
select 'users' as table_name, count(*) as mirrored_rows from cw_backup.users
union all select 'sessions', count(*) from cw_backup.sessions
union all select 'domains', count(*) from cw_backup.domains
union all select 'ingests', count(*) from cw_backup.ingests
union all select 'snapshots', count(*) from cw_backup.snapshots
union all select 'assets', count(*) from cw_backup.assets
union all select 'link_resolutions', count(*) from cw_backup.link_resolutions
union all select 'cdx_surveys', count(*) from cw_backup.cdx_surveys
union all select 'usage_ledger', count(*) from cw_backup.usage_ledger
union all select 'throttle_events', count(*) from cw_backup.throttle_events
union all select 'rate_limits', count(*) from cw_backup.rate_limits
union all select 'search_docs', count(*) from cw_backup.search_docs
union all select 'share_links', count(*) from cw_backup.share_links
union all select 'exports', count(*) from cw_backup.exports;

comment on view cw_backup.backup_counts is
  'Row counts actually present in the mirror, to compare against D1 rather than against what the syncer claims it sent.';
