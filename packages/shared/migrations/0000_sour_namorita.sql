CREATE TABLE `assets` (
	`hash` text PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`r2_key` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`ref_count` integer DEFAULT 1 NOT NULL,
	`r2_deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `cdx_surveys` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`month` text NOT NULL,
	`query_hash` text NOT NULL,
	`payload` blob NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cdx_survey_unique` ON `cdx_surveys` (`domain`,`month`,`query_hash`);--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`domain` text NOT NULL,
	`host_filter` text,
	`budget_json` text NOT NULL,
	`tracking_status` text DEFAULT 'active' NOT NULL,
	`added_at` integer NOT NULL,
	`last_crawled_at` integer,
	`coverage_json` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ingests` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`month` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`pages_total` integer DEFAULT 0 NOT NULL,
	`pages_done` integer DEFAULT 0 NOT NULL,
	`assets_total` integer DEFAULT 0 NOT NULL,
	`assets_done` integer DEFAULT 0 NOT NULL,
	`bytes_stored` integer DEFAULT 0 NOT NULL,
	`budget_json` text,
	`ia_429_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`queue_msg_id` text,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingests_domain_month` ON `ingests` (`domain_id`,`month`);--> statement-breakpoint
CREATE INDEX `ingests_status` ON `ingests` (`status`);--> statement-breakpoint
CREATE TABLE `link_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`day` text NOT NULL,
	`from_url` text NOT NULL,
	`to_url` text NOT NULL,
	`kind` text NOT NULL,
	`resolved_day` text,
	`resolved_ts` text,
	`delta_days` integer
);
--> statement-breakpoint
CREATE INDEX `link_res_domain_day` ON `link_resolutions` (`domain`,`day`);--> statement-breakpoint
CREATE UNIQUE INDEX `link_res_unique` ON `link_resolutions` (`domain`,`day`,`from_url`,`to_url`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`user_agent` text,
	`ip_hash` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`ingest_id` text NOT NULL,
	`domain` text NOT NULL,
	`url` text NOT NULL,
	`day` text NOT NULL,
	`ts` text NOT NULL,
	`status_code` integer NOT NULL,
	`mime` text NOT NULL,
	`digest` text,
	`bytes` integer,
	`r2_key` text,
	`page_id` text,
	`resolved_day` text,
	`resolved_ts` text,
	`delta_days` integer,
	`served_at` integer,
	`purged_at` integer,
	FOREIGN KEY (`ingest_id`) REFERENCES `ingests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_domain_day` ON `snapshots` (`domain`,`day`);--> statement-breakpoint
CREATE INDEX `snapshots_ingest` ON `snapshots` (`ingest_id`);--> statement-breakpoint
CREATE INDEX `snapshots_purge` ON `snapshots` (`served_at`,`purged_at`);--> statement-breakpoint
CREATE TABLE `usage_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text,
	`month` text,
	`kind` text NOT NULL,
	`value` integer NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_domain_month` ON `usage_ledger` (`domain`,`month`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	`disabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);