-- Phase 4: production ingest.
--
-- Adds the bookkeeping the queue consumer needs to be genuinely resumable and
-- genuinely polite:
--   * ingests.*_stage / queue_msg_id / lease  -> a job survives a retry, a 429
--     storm, or a consumer eviction and picks up where it stopped instead of
--     re-crawling from page 1.
--   * ingests.pages_json / assets_json        -> the frozen work plan. Written
--     once by the survey stage so a retry cannot re-select a different set of
--     captures (determinism across retries).
--   * throttle_events                         -> per-429 telemetry with the exact
--     wait, so the UI can say "archive.org is throttling us, resuming in Ns" and
--     the usage dashboard can price the backoff.
--   * rate_limits                             -> fixed-window request throttling
--     for the API itself (per user, in D1, no extra service).
--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `stage` text;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `cursor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `pages_json` text;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `assets_json` text;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `asset_cursor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `degraded_reason` text;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `day_index_json` text;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `lease_until` integer;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `consecutive_429` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `breaker_open_until` integer;--> statement-breakpoint
ALTER TABLE `ingests` ADD COLUMN `last_throttle_at` integer;--> statement-breakpoint
CREATE INDEX `ingests_lease` ON `ingests` (`status`,`lease_until`);--> statement-breakpoint
CREATE TABLE `throttle_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text NOT NULL,
	`month` text,
	`ingest_id` text,
	`host` text NOT NULL,
	`status` integer NOT NULL,
	`wait_ms` integer NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`breaker_open` integer DEFAULT false NOT NULL,
	`kind` text DEFAULT 'backoff' NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `throttle_events_domain` ON `throttle_events` (`domain`,`created_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`bucket` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`bucket`, `window_start`)
);--> statement-breakpoint
CREATE INDEX `rate_limits_window` ON `rate_limits` (`window_start`);
