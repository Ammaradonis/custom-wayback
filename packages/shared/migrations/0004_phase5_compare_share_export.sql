-- Phase 5: month-to-month comparison, share links, and export bookkeeping.
--
-- WHY A CONTENT DIGEST RATHER THAN THE HTML
-- "Diff two months" needs to answer which pages changed before it can answer how
-- they changed. Reading every page out of R2 for both months costs one read per
-- page per month and fails outright for anything the post-serve purge deleted.
-- So each crawl records a digest of the bytes it stored. Detecting THAT a page
-- changed is then two indexed reads and no R2 traffic, and the expensive detail
-- diff happens only for pages already known to differ. The digest is of the
-- rewritten HTML, so it answers whether the reader would see a difference.
--
-- WHY SHARE LINKS ARE A HASHED CAPABILITY
-- A share link is not an account and not a bypass of the app's access control: it
-- reuses the ordinary viewer route, which is protected by whatever protects the
-- app. What it adds is a stable, revocable reference to a snapshot, so a link
-- kept in notes survives a re-crawl and dies the moment it is revoked. Tokens are
-- stored hashed, because resolution only ever looks a token up, and a leaked
-- database should not hand out working links.
--
-- WHY EXPORTS ARE INDEXED IN D1
-- The bytes go to R2, far too large for a SQLite row, so this table is the index:
-- what was exported, how big it was, and whether the artifact is still there.
-- Without it an export is an anonymous object in the bucket that nobody can find
-- or delete.
--
-- NOTE FOR MAINTAINERS
-- This file must contain no sql comment whose text begins with two dashes
-- followed by a greater-than sign. D1 splits a migration on a statement
-- breakpoint marker of exactly that shape, so such a comment truncates the
-- preceding statement and the migration fails with "incomplete input". Longer
-- design notes therefore live in docs and in the application code, not here.
ALTER TABLE `snapshots` ADD COLUMN `content_digest` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD COLUMN `title` text;--> statement-breakpoint
CREATE INDEX `snapshots_domain_url_day` ON `snapshots` (`domain`,`url`,`day`);--> statement-breakpoint
CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`domain` text NOT NULL,
	`month` text,
	`day` text,
	`url` text,
	`label` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`view_count` integer NOT NULL DEFAULT 0,
	`last_viewed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_token` ON `share_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_links_user` ON `share_links` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`domain` text NOT NULL,
	`month` text NOT NULL,
	`r2_key` text NOT NULL,
	`bytes` integer NOT NULL DEFAULT 0,
	`pages` integer NOT NULL DEFAULT 0,
	`assets` integer NOT NULL DEFAULT 0,
	`missing` integer NOT NULL DEFAULT 0,
	`status` text NOT NULL DEFAULT 'building',
	`error_message` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `exports_user_domain` ON `exports` (`user_id`,`domain`,`month`);
