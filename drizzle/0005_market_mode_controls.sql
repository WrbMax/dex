ALTER TABLE `markets` ADD `marketMode` enum('binance_mirror','orderbook') NOT NULL DEFAULT 'binance_mirror';--> statement-breakpoint
ALTER TABLE `markets` ADD `externalSymbol` varchar(32);--> statement-breakpoint
ALTER TABLE `markets` ADD `marketDataSource` enum('binance','internal','manual') NOT NULL DEFAULT 'binance';--> statement-breakpoint
ALTER TABLE `markets` ADD `allowMarketOrder` boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE `markets` ADD `allowLimitOrder` boolean NOT NULL DEFAULT true;--> statement-breakpoint
UPDATE `markets` SET `externalSymbol` = `symbol` WHERE `externalSymbol` IS NULL;
