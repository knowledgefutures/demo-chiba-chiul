CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`slug` text NOT NULL,
	`layout` text NOT NULL,
	`version` text,
	`ark` text,
	`record_count` integer DEFAULT 0 NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collections_workspace_idx` ON `collections` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_workspace_id_slug_unique` ON `collections` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE TABLE `commit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`collection_slug` text NOT NULL,
	`semver` text,
	`records_uploaded` integer DEFAULT 0 NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`persona_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_value` text,
	`detail` text NOT NULL,
	`see_private` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `grants_workspace_idx` ON `grants` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `grants_persona_idx` ON `grants` (`persona_id`);--> statement-breakpoint
CREATE TABLE `hydration_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`collection_slug` text,
	`outcome` text NOT NULL,
	`records_read` integer DEFAULT 0 NOT NULL,
	`sessions_built` integer DEFAULT 0 NOT NULL,
	`detail` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hydration_log_workspace_idx` ON `hydration_log` (`workspace_id`,`at`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`source_label` text,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `personas_workspace_idx` ON `personas` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `personas_workspace_id_label_unique` ON `personas` (`workspace_id`,`label`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`underlay_url` text NOT NULL,
	`org_slug` text NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`status_detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
