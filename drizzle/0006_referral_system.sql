-- 0006: Referral / Invitation System
-- Add referral code to users table and create referral relationships table

-- 1. Add referralCode column to users table (unique 6-char code, auto-generated)
ALTER TABLE `users` ADD `referralCode` varchar(8) UNIQUE;--> statement-breakpoint

-- 2. Add referrerId column to users table (who invited this user)
ALTER TABLE `users` ADD `referrerId` int;--> statement-breakpoint

-- 3. Add index on referrerId for fast lookup of a user's downline
CREATE INDEX `users_referrer_idx` ON `users` (`referrerId`);--> statement-breakpoint

-- 4. Create referral_rewards table for tracking commission payouts (future use)
CREATE TABLE `referral_rewards` (
  `id` bigint AUTO_INCREMENT PRIMARY KEY,
  `userId` int NOT NULL COMMENT 'The referrer who earns the reward',
  `fromUserId` int NOT NULL COMMENT 'The referred user whose trade generated the reward',
  `tradeId` bigint NOT NULL COMMENT 'The trade that generated this reward',
  `symbol` varchar(32) NOT NULL,
  `rewardAsset` varchar(16) NOT NULL COMMENT 'Asset of the reward (e.g. USDT)',
  `rewardAmount` decimal(36, 18) NOT NULL DEFAULT '0',
  `level` int NOT NULL DEFAULT 1 COMMENT 'Referral level (1=direct, 2=indirect, etc.)',
  `status` enum('pending','paid','canceled') NOT NULL DEFAULT 'pending',
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `referral_rewards_user_idx` (`userId`),
  INDEX `referral_rewards_from_user_idx` (`fromUserId`),
  INDEX `referral_rewards_trade_idx` (`tradeId`)
);
