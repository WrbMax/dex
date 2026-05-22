CREATE TABLE `api_keys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`label` varchar(64) NOT NULL,
	`publicKey` varchar(64) NOT NULL,
	`secretHash` varchar(128) NOT NULL,
	`permissions` json NOT NULL,
	`ipWhitelist` json,
	`lastUsedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_keys_publicKey_unique` UNIQUE(`publicKey`)
);
--> statement-breakpoint
CREATE TABLE `asset_accounts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`subAccountId` int NOT NULL,
	`asset` varchar(16) NOT NULL,
	`available` decimal(36,18) NOT NULL DEFAULT '0',
	`locked` decimal(36,18) NOT NULL DEFAULT '0',
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `asset_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `asset_accounts_uniq` UNIQUE(`subAccountId`,`asset`)
);
--> statement-breakpoint
CREATE TABLE `deposit_addresses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`chain` enum('erc20','bep20') NOT NULL,
	`address` varchar(64) NOT NULL,
	`derivationPath` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deposit_addresses_id` PRIMARY KEY(`id`),
	CONSTRAINT `deposit_user_chain_uniq` UNIQUE(`userId`,`chain`),
	CONSTRAINT `deposit_address_uniq` UNIQUE(`address`)
);
--> statement-breakpoint
CREATE TABLE `deposits` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`subAccountId` int NOT NULL,
	`chain` enum('erc20','bep20') NOT NULL,
	`asset` varchar(16) NOT NULL,
	`amount` decimal(36,18) NOT NULL,
	`txHash` varchar(80) NOT NULL,
	`fromAddress` varchar(64) NOT NULL,
	`toAddress` varchar(64) NOT NULL,
	`confirmations` int NOT NULL DEFAULT 0,
	`status` enum('pending','confirmed','credited') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`creditedAt` timestamp,
	CONSTRAINT `deposits_id` PRIMARY KEY(`id`),
	CONSTRAINT `deposits_tx_uniq` UNIQUE(`txHash`,`chain`)
);
--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`subAccountId` int NOT NULL,
	`asset` varchar(16) NOT NULL,
	`delta` decimal(36,18) NOT NULL,
	`lockedDelta` decimal(36,18) NOT NULL DEFAULT '0',
	`reason` enum('deposit','withdraw_freeze','withdraw_complete','withdraw_revert','transfer_out','transfer_in','order_freeze','order_unfreeze','trade_fill','trade_fee','hedge_adjust','admin_adjust') NOT NULL,
	`refTable` varchar(32),
	`refId` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ledger_entries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `markets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`base` varchar(16) NOT NULL,
	`quote` varchar(16) NOT NULL,
	`priceTick` decimal(36,18) NOT NULL,
	`amountStep` decimal(36,18) NOT NULL,
	`minNotional` decimal(36,18) NOT NULL DEFAULT '1',
	`pricePrecision` int NOT NULL,
	`amountPrecision` int NOT NULL,
	`takerFee` decimal(8,6) NOT NULL DEFAULT '0.001',
	`makerFee` decimal(8,6) NOT NULL DEFAULT '0.0008',
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `markets_id` PRIMARY KEY(`id`),
	CONSTRAINT `markets_symbol_unique` UNIQUE(`symbol`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`clientOrderId` varchar(64),
	`userId` int NOT NULL,
	`subAccountId` int NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`side` enum('buy','sell') NOT NULL,
	`type` enum('limit','market') NOT NULL,
	`price` decimal(36,18),
	`quantity` decimal(36,18) NOT NULL,
	`filledQty` decimal(36,18) NOT NULL DEFAULT '0',
	`quoteFilled` decimal(36,18) NOT NULL DEFAULT '0',
	`avgPrice` decimal(36,18) NOT NULL DEFAULT '0',
	`status` enum('new','partial','filled','canceled','rejected') NOT NULL DEFAULT 'new',
	`source` enum('web','api') NOT NULL DEFAULT 'web',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `orders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sub_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(64) NOT NULL,
	`isDefault` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sub_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `system_settings` (
	`key` varchar(64) NOT NULL,
	`value` json NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `system_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`price` decimal(36,18) NOT NULL,
	`quantity` decimal(36,18) NOT NULL,
	`quoteQty` decimal(36,18) NOT NULL,
	`buyerOrderId` bigint NOT NULL,
	`sellerOrderId` bigint NOT NULL,
	`buyerUserId` int NOT NULL,
	`sellerUserId` int NOT NULL,
	`buyerIsMaker` boolean NOT NULL,
	`buyerFee` decimal(36,18) NOT NULL,
	`sellerFee` decimal(36,18) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `trades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transfers` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`fromSubAccountId` int NOT NULL,
	`toSubAccountId` int NOT NULL,
	`asset` varchar(16) NOT NULL,
	`amount` decimal(36,18) NOT NULL,
	`note` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `transfers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `withdrawals` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`subAccountId` int NOT NULL,
	`chain` enum('erc20','bep20') NOT NULL,
	`asset` varchar(16) NOT NULL,
	`amount` decimal(36,18) NOT NULL,
	`feeAmount` decimal(36,18) NOT NULL DEFAULT '0',
	`toAddress` varchar(64) NOT NULL,
	`status` enum('pending','reviewing','approved','broadcasting','confirmed','rejected','failed') NOT NULL DEFAULT 'pending',
	`rejectReason` text,
	`txHash` varchar(80),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `withdrawals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `primaryWalletAddress` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `registerChain` enum('erc20','bep20');--> statement-breakpoint
ALTER TABLE `users` ADD `walletBoundAt` timestamp;--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`userId`);--> statement-breakpoint
CREATE INDEX `asset_accounts_user_idx` ON `asset_accounts` (`userId`);--> statement-breakpoint
CREATE INDEX `deposits_user_idx` ON `deposits` (`userId`);--> statement-breakpoint
CREATE INDEX `ledger_user_idx` ON `ledger_entries` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ledger_ref_idx` ON `ledger_entries` (`refTable`,`refId`);--> statement-breakpoint
CREATE INDEX `orders_user_idx` ON `orders` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `orders_symbol_idx` ON `orders` (`symbol`,`status`);--> statement-breakpoint
CREATE INDEX `sub_accounts_user_idx` ON `sub_accounts` (`userId`);--> statement-breakpoint
CREATE INDEX `trades_symbol_idx` ON `trades` (`symbol`,`createdAt`);--> statement-breakpoint
CREATE INDEX `transfers_user_idx` ON `transfers` (`userId`);--> statement-breakpoint
CREATE INDEX `withdrawals_user_idx` ON `withdrawals` (`userId`);--> statement-breakpoint
CREATE INDEX `withdrawals_status_idx` ON `withdrawals` (`status`);--> statement-breakpoint
CREATE INDEX `users_wallet_idx` ON `users` (`primaryWalletAddress`);