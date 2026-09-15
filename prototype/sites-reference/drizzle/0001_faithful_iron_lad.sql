CREATE TABLE `brands` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brands_name_unique` ON `brands` (`name`);--> statement-breakpoint
CREATE TABLE `vehicles` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`customer_id` text NOT NULL,
	`chassis` text NOT NULL,
	`engine` text NOT NULL,
	`brand_id` text NOT NULL,
	`fuel` text NOT NULL,
	`cc` text NOT NULL,
	`weight` text NOT NULL,
	`color` text NOT NULL,
	`body` text NOT NULL,
	`registration_province` text NOT NULL,
	`owner_province` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vehicles_chassis_unique` ON `vehicles` (`chassis`);