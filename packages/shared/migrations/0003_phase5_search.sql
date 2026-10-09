-- Phase 5: cross-domain full-text search over crawled snapshots.
--
-- "When did they change the price page?" is the question this table exists to
-- answer (plan.md §15). It is a marketing-research tool, so search has to work
-- across every snapshot you have ever crawled, not just the month on screen.
--
-- ## Why the text is indexed at ingest and not read from R2
--
-- Search must not depend on R2. The post-serve purge job deletes page blobs by
-- design (`apps/api/src/lib/r2.ts`), so a search that read bodies out of R2 would
-- quietly lose results for every page you had already visited — the archive
-- appearing to shrink as you use it. The text is therefore extracted once, during
-- ingest, while the bytes are in hand, and stored here permanently.
--
-- ## Why this is not an `external content` FTS5 table
--
-- The usual pattern is `content='snapshots'` so FTS5 reads columns back from the
-- base table instead of duplicating them. That works when the indexed text lives
-- in a column of that table. Here the whole point is to *not* keep the full page
-- text in `snapshots` (it would bloat every ledger query), so the text is stored
-- in the FTS table itself. The trade is ~1x page text in storage for a search
-- that cannot be broken by the purge job. `packages/shared/src/constants.ts` and
-- the usage ledger both count that cost.
--
-- ## Query shape
--
-- Search is always scoped to the domains a user owns, by joining `snapshots` (see
-- `apps/api/src/lib/search.ts`), so this table needs no owner column of its own:
-- ownership is a property of the domain, and duplicating it here would be a second
-- source of truth that could disagree.
--> statement-breakpoint
CREATE VIRTUAL TABLE `snapshot_fts` USING fts5(
  doc_id UNINDEXED,
  url,
  title,
  text,
  domain UNINDEXED,
  day UNINDEXED,
  ts UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);--> statement-breakpoint
-- One indexable row per stored page. Keyed on the snapshot primary key so a
-- re-ingest replaces rather than duplicates.
--
-- The join between this table and `snapshot_fts` goes through `doc_id`, which
-- holds the snapshot's text primary key explicitly. It deliberately does *not*
-- use FTS5's implicit integer `rowid`: joining an integer rowid to a text
-- snapshot_id compares values of different types, which in SQLite silently
-- matches nothing rather than raising — a search that always returns zero results
-- and looks like "you have not crawled this yet".
CREATE TABLE `search_docs` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`url` text NOT NULL,
	`day` text NOT NULL,
	`title` text,
	`bytes` integer NOT NULL DEFAULT 0,
	`indexed_at` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `search_docs_domain_day` ON `search_docs` (`domain`, `day`);
