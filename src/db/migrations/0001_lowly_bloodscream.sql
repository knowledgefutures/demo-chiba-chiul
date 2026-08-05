CREATE TABLE `ingest_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`writes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ingest_tokens_workspace_idx` ON `ingest_tokens` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ingest_tokens_token_hash_unique` ON `ingest_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `flush_interval_minutes` integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `auto_flush` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `last_flush_at` integer;