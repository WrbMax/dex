CREATE TABLE `user_notifications` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`type` varchar(32) NOT NULL,
	`title` varchar(128) NOT NULL,
	`body` text NOT NULL,
	`refTable` varchar(32),
	`refId` bigint,
	`isRead` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `user_notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `user_notifications` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `notifications_unread_idx` ON `user_notifications` (`userId`,`isRead`);