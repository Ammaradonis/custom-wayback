-- Mirror snapshots.source (D1 migration 0005_precrawl_source.sql)
-- ============================================================================
--
-- 'local' marks a page the local crawler published into R2 (`crawl-local publish`);
-- NULL is the cloud crawl. The purge never deletes a 'local' page, so a restore that
-- dropped the column would make every pre-crawled page purgeable again.
--
-- 0001 declares the column for a fresh mirror; this adds it to one created before.
alter table cw_backup.snapshots add column if not exists source text;
