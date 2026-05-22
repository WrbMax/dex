import {
  bigint,
  boolean,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/* -------------------------------------------------------------------------- */
/* Users & Auth                                                               */
/* -------------------------------------------------------------------------- */

export const users = mysqlTable(
  "users",
  {
    id: int("id").autoincrement().primaryKey(),
    openId: varchar("openId", { length: 64 }).notNull().unique(),
    name: text("name"),
    email: varchar("email", { length: 320 }),
    loginMethod: varchar("loginMethod", { length: 64 }),
    role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),

    /** EIP-55 checksum wallet address bound at registration. Permanent. */
    primaryWalletAddress: varchar("primaryWalletAddress", { length: 64 }),
    /** Chain used when the address was first bound. */
    registerChain: mysqlEnum("registerChain", ["erc20", "trc20", "bep20", "polygon", "arbitrum", "optimism", "solana", "bitcoin"]),
    walletBoundAt: timestamp("walletBoundAt"),
    isBanned: boolean("isBanned").default(false).notNull(),
    banReason: text("banReason"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
    /** Unique 6-char referral code generated at registration */
    referralCode: varchar("referralCode", { length: 8 }).unique(),
    /** ID of the user who referred this user (null if none) */
    referrerId: int("referrerId"),
  },
  (t) => ({
    walletIdx: index("users_wallet_idx").on(t.primaryWalletAddress),
    referrerIdx: index("users_referrer_idx").on(t.referrerId),
  })
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Sub accounts & Asset balances                                              */
/* -------------------------------------------------------------------------- */

export const subAccounts = mysqlTable(
  "sub_accounts",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    isDefault: boolean("isDefault").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("sub_accounts_user_idx").on(t.userId),
  })
);

export type SubAccount = typeof subAccounts.$inferSelect;

export const assetAccounts = mysqlTable(
  "asset_accounts",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    subAccountId: int("subAccountId").notNull(),
    asset: varchar("asset", { length: 16 }).notNull(), // e.g. USDT, BTC
    /** Total balance = available + locked */
    available: decimal("available", { precision: 36, scale: 18 }).default("0").notNull(),
    locked: decimal("locked", { precision: 36, scale: 18 }).default("0").notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("asset_accounts_uniq").on(t.subAccountId, t.asset),
    userIdx: index("asset_accounts_user_idx").on(t.userId),
  })
);

export type AssetAccount = typeof assetAccounts.$inferSelect;

/* -------------------------------------------------------------------------- */
/* Deposit addresses & deposits                                               */
/* -------------------------------------------------------------------------- */

export const depositAddresses = mysqlTable(
  "deposit_addresses",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    chain: mysqlEnum("chain", ["erc20", "trc20", "bep20", "polygon", "arbitrum", "optimism", "solana", "bitcoin"]).notNull(),
    address: varchar("address", { length: 64 }).notNull(),
    /** HD derivation path for offline signer reference. */
    derivationPath: varchar("derivationPath", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    userChainUniq: uniqueIndex("deposit_user_chain_uniq").on(t.userId, t.chain),
    addressUniq: uniqueIndex("deposit_address_uniq").on(t.address),
  })
);

export const deposits = mysqlTable(
  "deposits",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    subAccountId: int("subAccountId").notNull(),
    chain: mysqlEnum("chain", ["erc20", "trc20", "bep20", "polygon", "arbitrum", "optimism", "solana", "bitcoin"]).notNull(),
    asset: varchar("asset", { length: 16 }).notNull(),
    amount: decimal("amount", { precision: 36, scale: 18 }).notNull(),
    txHash: varchar("txHash", { length: 80 }).notNull(),
    fromAddress: varchar("fromAddress", { length: 64 }).notNull(),
    toAddress: varchar("toAddress", { length: 64 }).notNull(),
    confirmations: int("confirmations").default(0).notNull(),
    status: mysqlEnum("status", ["pending", "confirmed", "credited"]).default("pending").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    creditedAt: timestamp("creditedAt"),
  },
  (t) => ({
    userIdx: index("deposits_user_idx").on(t.userId),
    txUniq: uniqueIndex("deposits_tx_uniq").on(t.txHash, t.chain),
  })
);

/* -------------------------------------------------------------------------- */
/* Withdrawals                                                                */
/* -------------------------------------------------------------------------- */

export const withdrawals = mysqlTable(
  "withdrawals",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    subAccountId: int("subAccountId").notNull(),
    chain: mysqlEnum("chain", ["erc20", "trc20", "bep20", "polygon", "arbitrum", "optimism", "solana", "bitcoin"]).notNull(),
    asset: varchar("asset", { length: 16 }).notNull(),
    amount: decimal("amount", { precision: 36, scale: 18 }).notNull(),
    feeAmount: decimal("feeAmount", { precision: 36, scale: 18 }).default("0").notNull(),
    /** Destination address supplied at withdrawal submit time. */
    toAddress: varchar("toAddress", { length: 64 }).notNull(),
    status: mysqlEnum("status", [
      "pending",
      "reviewing",
      "approved",
      "broadcasting",
      "confirmed",
      "rejected",
      "failed",
    ])
      .default("pending")
      .notNull(),
    rejectReason: text("rejectReason"),
    txHash: varchar("txHash", { length: 80 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    userIdx: index("withdrawals_user_idx").on(t.userId),
    statusIdx: index("withdrawals_status_idx").on(t.status),
  })
);

/* -------------------------------------------------------------------------- */
/* Transfers (between sub-accounts / assets)                                  */
/* -------------------------------------------------------------------------- */

export const transfers = mysqlTable(
  "transfers",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    fromSubAccountId: int("fromSubAccountId").notNull(),
    toSubAccountId: int("toSubAccountId").notNull(),
    asset: varchar("asset", { length: 16 }).notNull(),
    amount: decimal("amount", { precision: 36, scale: 18 }).notNull(),
    note: varchar("note", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("transfers_user_idx").on(t.userId),
  })
);

/* -------------------------------------------------------------------------- */
/* Markets (trading pairs)                                                    */
/* -------------------------------------------------------------------------- */

export const markets = mysqlTable(
  "markets",
  {
    id: int("id").autoincrement().primaryKey(),
    symbol: varchar("symbol", { length: 32 }).notNull().unique(), // e.g. BTCUSDT
    base: varchar("base", { length: 16 }).notNull(),
    quote: varchar("quote", { length: 16 }).notNull(),
    priceTick: decimal("priceTick", { precision: 36, scale: 18 }).notNull(),
    amountStep: decimal("amountStep", { precision: 36, scale: 18 }).notNull(),
    minNotional: decimal("minNotional", { precision: 36, scale: 18 }).default("1").notNull(),
    pricePrecision: int("pricePrecision").notNull(),
    amountPrecision: int("amountPrecision").notNull(),
    takerFee: decimal("takerFee", { precision: 8, scale: 6 }).default("0.001").notNull(), // 0.1%
    makerFee: decimal("makerFee", { precision: 8, scale: 6 }).default("0.0008").notNull(), // 0.08%
    /** Market-making mode per trading pair.
     *  - binance_mirror: platform is the counterparty and mirrors Binance liquidity/price.
     *  - orderbook: pure internal order-book matching; external market makers provide liquidity via API.
     */
    marketMode: mysqlEnum("marketMode", ["binance_mirror", "orderbook"]).default("binance_mirror").notNull(),
    /** Upstream market symbol used by the mirror/liquidity source, normally same as symbol. */
    externalSymbol: varchar("externalSymbol", { length: 32 }),
    marketDataSource: mysqlEnum("marketDataSource", ["binance", "internal", "manual"]).default("binance").notNull(),
    /** Reference exchange and pricing rules for automatic market making. */
    refExchange: mysqlEnum("refExchange", ["binance", "okx", "bybit", "manual"]).default("binance").notNull(),
    priceRatio: decimal("priceRatio", { precision: 36, scale: 18 }).default("1").notNull(),
    priceOffset: decimal("priceOffset", { precision: 36, scale: 18 }).default("0").notNull(),
    spreadPct: decimal("spreadPct", { precision: 8, scale: 6 }).default("0.002").notNull(),
    maxDepthLevels: int("maxDepthLevels").default(15).notNull(),
    updateIntervalSec: int("updateIntervalSec").default(3).notNull(),
    maxPriceJumpPct: decimal("maxPriceJumpPct", { precision: 8, scale: 6 }).default("0.05").notNull(),
    klineFollowMode: mysqlEnum("klineFollowMode", ["scaled", "synthetic"]).default("scaled").notNull(),
    allowRealTrade: boolean("allowRealTrade").default(true).notNull(),
    allowMarketOrder: boolean("allowMarketOrder").default(true).notNull(),
    allowLimitOrder: boolean("allowLimitOrder").default(true).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    logoUrl: varchar("logoUrl", { length: 512 }),
    description: text("description"),
    websiteUrl: varchar("websiteUrl", { length: 512 }),
    whitepaperUrl: varchar("whitepaperUrl", { length: 512 }),
    explorerUrl: varchar("explorerUrl", { length: 512 }),
    contractAddress: varchar("contractAddress", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  }
);

/* -------------------------------------------------------------------------- */
/* Orders & Trades                                                            */
/* -------------------------------------------------------------------------- */

export const orders = mysqlTable(
  "orders",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    clientOrderId: varchar("clientOrderId", { length: 64 }),
    userId: int("userId").notNull(),
    subAccountId: int("subAccountId").notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    side: mysqlEnum("side", ["buy", "sell"]).notNull(),
    type: mysqlEnum("type", ["limit", "market"]).notNull(),
    price: decimal("price", { precision: 36, scale: 18 }), // nullable for market
    quantity: decimal("quantity", { precision: 36, scale: 18 }).notNull(),
    filledQty: decimal("filledQty", { precision: 36, scale: 18 }).default("0").notNull(),
    quoteFilled: decimal("quoteFilled", { precision: 36, scale: 18 }).default("0").notNull(),
    avgPrice: decimal("avgPrice", { precision: 36, scale: 18 }).default("0").notNull(),
    status: mysqlEnum("status", [
      "new",
      "partial",
      "filled",
      "canceled",
      "rejected",
    ])
      .default("new")
      .notNull(),
    source: mysqlEnum("source", ["web", "api"]).default("web").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    userIdx: index("orders_user_idx").on(t.userId, t.status),
    symbolIdx: index("orders_symbol_idx").on(t.symbol, t.status),
    clientOrderUserUnique: uniqueIndex("orders_user_client_order_uidx").on(t.userId, t.clientOrderId),
  })
);

export const trades = mysqlTable(
  "trades",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    price: decimal("price", { precision: 36, scale: 18 }).notNull(),
    quantity: decimal("quantity", { precision: 36, scale: 18 }).notNull(),
    quoteQty: decimal("quoteQty", { precision: 36, scale: 18 }).notNull(),
    buyerOrderId: bigint("buyerOrderId", { mode: "number" }).notNull(),
    sellerOrderId: bigint("sellerOrderId", { mode: "number" }).notNull(),
    buyerUserId: int("buyerUserId").notNull(),
    sellerUserId: int("sellerUserId").notNull(),
    buyerIsMaker: boolean("buyerIsMaker").notNull(),
    buyerFee: decimal("buyerFee", { precision: 36, scale: 18 }).notNull(),
    sellerFee: decimal("sellerFee", { precision: 36, scale: 18 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    symbolIdx: index("trades_symbol_idx").on(t.symbol, t.createdAt),
  })
);

/* -------------------------------------------------------------------------- */
/* Ledger entries (double-entry style)                                        */
/* -------------------------------------------------------------------------- */

export const ledgerEntries = mysqlTable(
  "ledger_entries",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    subAccountId: int("subAccountId").notNull(),
    asset: varchar("asset", { length: 16 }).notNull(),
    /**
     * Positive = credit, negative = debit (applied to `available`).
     * Use `lockedDelta` for freeze/unfreeze.
     */
    delta: decimal("delta", { precision: 36, scale: 18 }).notNull(),
    lockedDelta: decimal("lockedDelta", { precision: 36, scale: 18 }).default("0").notNull(),
    reason: mysqlEnum("reason", [
      "deposit",
      "withdraw_freeze",
      "withdraw_complete",
      "withdraw_revert",
      "transfer_out",
      "transfer_in",
      "order_freeze",
      "order_unfreeze",
      "trade_fill",
      "trade_fee",
      "hedge_adjust",
      "admin_adjust",
    ]).notNull(),
    refTable: varchar("refTable", { length: 32 }),
    refId: bigint("refId", { mode: "number" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("ledger_user_idx").on(t.userId, t.createdAt),
    refIdx: index("ledger_ref_idx").on(t.refTable, t.refId),
  })
);

/* -------------------------------------------------------------------------- */
/* System settings (hedge switch, risk limits)                                */
/* -------------------------------------------------------------------------- */

export const systemSettings = mysqlTable("system_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: json("value").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/* -------------------------------------------------------------------------- */
/* API keys for external SDKs (HMAC style)                                    */
/* -------------------------------------------------------------------------- */

export const apiKeys = mysqlTable(
  "api_keys",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    label: varchar("label", { length: 64 }).notNull(),
    publicKey: varchar("publicKey", { length: 64 }).notNull().unique(),
    secretHash: varchar("secretHash", { length: 128 }).notNull(),
    permissions: json("permissions").notNull(), // { read: bool, trade: bool, withdraw: bool }
    ipWhitelist: json("ipWhitelist"),
    lastUsedAt: timestamp("lastUsedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"),
  },
  (t) => ({
    userIdx: index("api_keys_user_idx").on(t.userId),
  })
);

/* -------------------------------------------------------------------------- */
/* Admin action audit log                                                     */
/* -------------------------------------------------------------------------- */
export const adminActionLogs = mysqlTable(
  "admin_action_logs",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    adminId: int("adminId").notNull(),
    adminName: varchar("adminName", { length: 128 }),
    action: varchar("action", { length: 64 }).notNull(), // e.g. ban_user, adjust_balance, approve_withdrawal
    targetType: varchar("targetType", { length: 32 }), // user | order | withdrawal | market
    targetId: varchar("targetId", { length: 64 }), // target entity id
    before: json("before"), // snapshot before change
    after: json("after"),  // snapshot after change
    note: text("note"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    adminIdx: index("admin_logs_admin_idx").on(t.adminId, t.createdAt),
    actionIdx: index("admin_logs_action_idx").on(t.action, t.createdAt),
  })
);
export type AdminActionLog = typeof adminActionLogs.$inferSelect;

/* -------------------------------------------------------------------------- */
/* User Notifications                                                         */
/* -------------------------------------------------------------------------- */

export const userNotifications = mysqlTable(
  "user_notifications",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    type: varchar("type", { length: 32 }).notNull(), // e.g. "order_filled", "order_canceled"
    title: varchar("title", { length: 128 }).notNull(),
    body: text("body").notNull(),
    refTable: varchar("refTable", { length: 32 }), // e.g. "orders", "trades"
    refId: bigint("refId", { mode: "number" }),
    isRead: boolean("isRead").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("notifications_user_idx").on(t.userId, t.createdAt),
    unreadIdx: index("notifications_unread_idx").on(t.userId, t.isRead),
  })
);

export type UserNotification = typeof userNotifications.$inferSelect;

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                 */
/* -------------------------------------------------------------------------- */

export type Market = typeof markets.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
export type Deposit = typeof deposits.$inferSelect;
export type Transfer = typeof transfers.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type DepositAddress = typeof depositAddresses.$inferSelect;

/* -------------------------------------------------------------------------- */
/* Referral Rewards                                                           */
/* -------------------------------------------------------------------------- */
export const referralRewards = mysqlTable(
  "referral_rewards",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    /** The referrer who earns the reward */
    userId: int("userId").notNull(),
    /** The referred user whose trade generated the reward */
    fromUserId: int("fromUserId").notNull(),
    /** The trade that generated this reward */
    tradeId: bigint("tradeId", { mode: "number" }).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    /** Asset of the reward (e.g. USDT) */
    rewardAsset: varchar("rewardAsset", { length: 16 }).notNull(),
    rewardAmount: decimal("rewardAmount", { precision: 36, scale: 18 }).default("0").notNull(),
    /** Referral level (1=direct, 2=indirect, etc.) */
    level: int("level").default(1).notNull(),
    status: mysqlEnum("status", ["pending", "paid", "canceled"]).default("pending").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("referral_rewards_user_idx").on(t.userId),
    fromUserIdx: index("referral_rewards_from_user_idx").on(t.fromUserId),
    tradeIdx: index("referral_rewards_trade_idx").on(t.tradeId),
  })
);
export type ReferralReward = typeof referralRewards.$inferSelect;
