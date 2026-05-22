CREATE TABLE `admin_action_logs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`adminId` int NOT NULL,
	`adminName` varchar(128),
	`action` varchar(64) NOT NULL,
	`targetType` varchar(32),
	`targetId` varchar(64),
	`before` json,
	`after` json,
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `admin_action_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `admin_logs_admin_idx` ON `admin_action_logs` (`adminId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `admin_logs_action_idx` ON `admin_action_logs` (`action`,`createdAt`);