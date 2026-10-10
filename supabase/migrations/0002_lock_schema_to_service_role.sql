-- Close the mirror's schema to anonymous callers
-- ============================================================================
--
-- Why this migration exists at all, given 0001 already revoked table privileges
-- and enabled row-level security: **schema-level `USAGE` is checked before any
-- table privilege**, so a role without it fails at the schema and never reaches
-- RLS. In 0001 the mirror depended on an accident of Postgres defaults —
-- `cw_backup` was created by `postgres`, so no implicit `PUBLIC` usage grant
-- existed — and on the fact that PostgREST grants `USAGE` on schemas in its
-- search path. Neither is a guarantee worth resting on.
--
-- ## The failure this prevents is a misleading one
--
-- PostgREST decides the role from the *JWT in the `Authorization` header*, not
-- from `apikey`. A request that sends only `apikey` — which is the obvious thing
-- to do if you are testing by hand, and the first thing a misconfigured client
-- does — is executed as `anon`. With schema usage granted, that produced:
--
--     401  42501  permission denied for schema cw_backup
--
-- which reads like "the schema is missing or broken" and sends you looking at
-- DDL, when the actual cause is one missing request header. With usage revoked,
-- the same mistake fails at the schema boundary with the same `42501`, but
-- nothing about the database is *relied upon* to produce it: the deny is explicit
-- in this file, and `scripts/supabase-backup.mjs status` reports the exposure
-- state so the two conditions can be told apart.
--
-- ## Why `anon` keeps `public`
--
-- Only `cw_backup` is revoked here. Supabase's own tooling, the dashboard's table
-- editor and anything else in `public` are untouched — a backup feature that
-- silently broke the rest of the project would be a much worse outcome than the
-- leak it is guarding against.
--
-- ## Idempotent
--
-- `REVOKE` on a privilege that was never granted is a no-op, so re-running this
-- file costs nothing. See the header of 0001 for the general rule.
-- ============================================================================

revoke usage on schema cw_backup from anon;
revoke usage on schema cw_backup from authenticated;
revoke usage on schema cw_backup from public;

-- Belt and braces, in case a future migration grants table privileges broadly:
-- the tables and the sequences behind the mirror's identity columns.
revoke all privileges on all tables in schema cw_backup from anon;
revoke all privileges on all tables in schema cw_backup from authenticated;
revoke all privileges on all sequences in schema cw_backup from anon;
revoke all privileges on all sequences in schema cw_backup from authenticated;

-- The views are separate objects with their own ACLs, and `backup_counts` in
-- particular reads every table. `0001` granted only on tables.
revoke all privileges on all functions in schema cw_backup from anon;
revoke all privileges on all functions in schema cw_backup from authenticated;

-- Re-assert what the sync and the CLI actually need, so this file is a complete
-- statement of who may reach the mirror rather than a delta against 0001.
grant usage on schema cw_backup to service_role, authenticator;
grant all privileges on all tables in schema cw_backup to service_role;
grant all privileges on all sequences in schema cw_backup to service_role;
alter default privileges in schema cw_backup grant all privileges on tables to service_role;
alter default privileges in schema cw_backup grant all privileges on sequences to service_role;

-- ── Record the intent where an operator will see it ────────────────────────

comment on schema cw_backup is
  'Mirror of the Cloudflare D1 ledger (custom-wayback). Reachable only by service_role: anon and authenticated have no USAGE here, by design. Written by the backup sync; see packages/shared/src/backup.ts.';
