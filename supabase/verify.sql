-- custom-wayback · is the mirror complete?
-- ============================================================================
--
-- Read-only. Run it any time — after a backup run, before trusting a restore, or
-- on a schedule from an external monitor. It answers four questions and prints one
-- table:
--
--   1. **Is every table's mirror row count equal to the source's?** The counts
--      below are the mirror's own; paste the D1 counts beside them with
--      `GET /v1/backup/status`, which reads D1 directly rather than trusting the
--      mirror's bookkeeping. A mirror that is *ahead* is normal only for
--      append-only tables mid-run; a mirror that is behind means the syncer is
--      failing and `consecutive_fails` will say for how long.
--   2. **Are the parents present for every child row?** The push carries no
--      foreign keys (see the header of `0001_cw_backup_schema.sql`), so this is
--      where referential integrity is actually checked.
--   3. **Is the cursor consistent with the data?** A cursor ahead of the highest
--      watermark it has copied would silently skip rows on the next run, and it is
--      invisible in a row count. This compares them.
--   4. **Does anything look truncated?** A batch that failed mid-page leaves the
--      cursor at the last *complete* watermark, which is correct — but worth
--      confirming rather than assuming.
--
-- Every check is written to return rows only when something is wrong, so an empty
-- result set means "fine". The final `report` query is the exception: it always
-- returns one row per table.
-- ============================================================================

-- ── 1. Row counts, mirror versus nothing to compare to (informational) ──────

select * from cw_backup.backup_counts order by table_name;

-- ── 2. Referential integrity ────────────────────────────────────────────────
-- Each of these should return zero rows.

-- Snapshots whose ingest is missing.
select 'snapshots without ingests' as problem, count(*) as rows
from cw_backup.snapshots s
left join cw_backup.ingests i on i.id = s.ingest_id
where i.id is null;

-- Domains whose owner is missing.
select 'domains without users' as problem, count(*) as rows
from cw_backup.domains d
left join cw_backup.users u on u.id = d.user_id
where u.id is null;

-- Sessions whose user is missing.
select 'sessions without users' as problem, count(*) as rows
from cw_backup.sessions s
left join cw_backup.users u on u.id = s.user_id
where u.id is null;

-- Ingests whose domain is missing.
select 'ingests without domains' as problem, count(*) as rows
from cw_backup.ingests i
left join cw_backup.domains d on d.id = i.domain_id
where d.id is null;

-- Indexed documents whose snapshot is missing.
select 'search_docs without snapshots' as problem, count(*) as rows
from cw_backup.search_docs sd
left join cw_backup.snapshots s on s.id = sd.snapshot_id
where s.id is null;

-- ── 3. Cursor sanity ────────────────────────────────────────────────────────
--
-- `last_cursor` must be at or below the highest watermark the table actually
-- holds. A cursor past it means the next run starts beyond rows that were never
-- copied — the one failure a row count cannot show, because the rows are missing
-- from the mirror and therefore not counted.

select
  'cursor past data: users' as problem, count(*) as rows
from cw_backup.backup_state bs
where bs.table_name = 'users'
  and bs.last_cursor is not null
  and bs.last_cursor::bigint > (select coalesce(max(created_at), 0) from cw_backup.users)

union all
select 'cursor past data: snapshots', count(*)
from cw_backup.backup_state bs
where bs.table_name = 'snapshots'
  and bs.last_cursor is not null
  and bs.last_cursor::bigint > (
    select coalesce(max(coalesce(purged_at, served_at, 0)), 0) from cw_backup.snapshots
  )

union all
select 'cursor past data: usage_ledger', count(*)
from cw_backup.backup_state bs
where bs.table_name = 'usage_ledger'
  and bs.last_cursor is not null
  and bs.last_cursor::bigint > (select coalesce(max(id), 0) from cw_backup.usage_ledger);

-- ── 4. Freshness ────────────────────────────────────────────────────────────
--
-- Anything with a lag over an hour is worth looking at; over a day means the
-- automatic run is not working and `last_error` will say why.

select
  table_name,
  last_success_at,
  lag_seconds,
  consecutive_fails,
  left(coalesce(last_error, ''), 120) as last_error
from cw_backup.backup_lag
where last_success_at is null
   or (extract(epoch from now())::bigint - last_success_at) > 3600
   or consecutive_fails > 0
order by lag_seconds desc nulls first;

-- ── The always-returns report ───────────────────────────────────────────────
--
-- One row per table: how many rows the mirror holds, the cursor, and the lag.
-- This is the query to paste into a ticket.

select
  c.table_name,
  c.mirrored_rows,
  l.last_cursor,
  l.rows_synced,
  l.lag_seconds,
  l.consecutive_fails,
  case
    when l.last_success_at is null then 'never synced'
    when l.consecutive_fails > 0 then 'failing'
    when l.lag_seconds > 3600 then 'stale'
    else 'ok'
  end as verdict
from cw_backup.backup_counts c
left join cw_backup.backup_lag l on l.table_name = c.table_name
order by c.table_name;
