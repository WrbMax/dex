/**
 * tRPC router for the exchange: markets, trading, accounts, deposits/withdrawals,
 * transfers, admin mode switch.
 */

import { referralRouter } from "./referral";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import {
  bindPrimaryWalletAddress,
  getAccountProfile,
} from "../exchange/accounts/service";
import {
  ensureDefaultSubAccount,
  getUserBalances,
} from "../exchange/accounts/ledger";
import {
  getOrCreateDepositAddress,
  listUserDepositAddresses,
  listUserDeposits,
  simulateIncoming,
} from "../exchange/deposits/service";
import {
  approveWithdrawal,
  listPendingWithdrawals,
  listUserWithdrawals,
  rejectWithdrawal,
  submitWithdrawal,
} from "../exchange/withdrawals/service";
import {
  createSubAccount,
  listUserSubAccounts,
  listUserTransfers,
  transferBetweenSubAccounts,
} from "../exchange/transfers/service";
import {
  allMarketsCached,
  ensureMarketsLoaded,
  getMarket,
} from "../exchange/markets/registry";
import { getMatchingEngine } from "../exchange/matching/engine";
import { getMarketDataHub } from "../exchange/marketdata/hub";
import { getBinanceDepth } from "../exchange/marketdata/depth_mirror";
import { syntheticDepthAround, transformDepthLevels, transformReferencePrice, transformTickerLike } from "../exchange/marketdata/market_config";
import { getBinance24hrTicker, getBinanceRecentTrades, getBinanceKlines, toHubTickerShape, toHubTradeShape } from "../exchange/marketdata/binance_rest";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { orders as ordersTable, trades as tradesTable } from "../../drizzle/schema";
import {
  getPlatformMode,
  recentHedgeLog,
  recordHedgeIntent,
  setPlatformMode,
} from "../exchange/hedge/service";
import {
  createApiKey,
  listUserApiKeys,
  revokeApiKey,
} from "../exchange/apikeys/service";
import {
  getUserNotifications,
  getUnreadCount,
  markNotificationsRead,
} from "../exchange/notifications/service";
import { SUPPORTED_CHAINS } from "@shared/wallet";

const chainSchema = z.enum(SUPPORTED_CHAINS);
const evmWalletBindChainSchema = z.enum(["erc20", "bep20"]);

/** Validates a positive decimal string like "12.345" */
const posDecSchema = z.string().min(1).max(80).regex(/^\d+(?:\.\d+)?$/, "Must be a positive decimal number");
const symbolSchema = z.string().min(1).max(32).regex(/^[A-Z0-9_:-]+$/i, "Invalid symbol");
const clientOrderIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/, "Invalid clientOrderId");

function adminOnly(role: string | undefined) {
  if (role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "admin required" });
  }
}

export const exchangeRouter = router({
  /* -------------------- referral system -------------------- */
  referral: referralRouter,
  /* -------------------- markets & data -------------------- */
  listMarkets: publicProcedure.query(async () => {
    await ensureMarketsLoaded();
    const hub = getMarketDataHub();
    const markets = allMarketsCached();
    const tickers = new Map(hub.listTickers().map((t) => [t.symbol, t]));
    return Promise.all(markets.map(async (m) => {
      let t = tickers.get(m.symbol);
      if (!t && m.marketMode === "binance_mirror" && m.marketDataSource === "binance") {
        const upstreamSymbol = (m.externalSymbol || m.symbol).toUpperCase();
        const binanceTicker = await getBinance24hrTicker(upstreamSymbol).catch(() => null);
        if (binanceTicker) {
          const fallbackTicker = transformTickerLike(toHubTickerShape(binanceTicker), m);
          t = { ...fallbackTicker, sparkline: fallbackTicker.sparkline.map((v) => Number(v)) };
        }
      }
      return {
        symbol: m.symbol,
        base: m.base,
        quote: m.quote,
        priceTick: m.priceTick,
        amountStep: m.amountStep,
        pricePrecision: m.pricePrecision,
        amountPrecision: m.amountPrecision,
        takerFee: m.takerFee,
        makerFee: m.makerFee,
        minNotional: m.minNotional,
        marketMode: m.marketMode,
        marketDataSource: m.marketDataSource,
        externalSymbol: m.externalSymbol ?? m.symbol,
        refExchange: m.refExchange ?? "binance",
        priceRatio: m.priceRatio ?? "1",
        priceOffset: m.priceOffset ?? "0",
        spreadPct: m.spreadPct ?? "0.002",
        maxDepthLevels: m.maxDepthLevels ?? 15,
        updateIntervalSec: m.updateIntervalSec ?? 3,
        maxPriceJumpPct: m.maxPriceJumpPct ?? "0.05",
        klineFollowMode: m.klineFollowMode ?? "scaled",
        allowRealTrade: m.allowRealTrade ?? true,
        allowMarketOrder: m.allowMarketOrder,
        allowLimitOrder: m.allowLimitOrder,
        isActive: m.isActive,
        logoUrl: m.logoUrl ?? null,
        description: m.description ?? null,
        websiteUrl: m.websiteUrl ?? null,
        whitepaperUrl: m.whitepaperUrl ?? null,
        explorerUrl: m.explorerUrl ?? null,
        contractAddress: m.contractAddress ?? null,
        lastPrice: t?.lastPrice ?? "0",
        change24h: t?.change24h ?? "0",
        changePct24h: t?.changePct24h ?? "0",
        high24h: t?.high24h ?? "0",
        low24h: t?.low24h ?? "0",
        volume24h: t?.volume24h ?? "0",
        quoteVolume24h: t?.quoteVolume24h ?? "0",
        sparkline: t?.sparkline ?? [],
      };
    }));
  }),

  ticker: publicProcedure
    .input(z.object({ symbol: symbolSchema }))
    .query(async ({ input }) => {
      await ensureMarketsLoaded();
      const market = getMarket(input.symbol);
      const upstreamSymbol = (market?.externalSymbol || input.symbol).toUpperCase();
      if (market?.marketMode === "binance_mirror" && market.marketDataSource === "binance") {
        const binanceTicker = await getBinance24hrTicker(upstreamSymbol).catch(() => null);
        if (binanceTicker) return transformTickerLike(toHubTickerShape(binanceTicker), market);
      }
      const hub = getMarketDataHub();
      return hub.getTicker(input.symbol) ?? null;
    }),

  recentTrades: publicProcedure
    .input(z.object({ symbol: symbolSchema, limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ input }) => {
      await ensureMarketsLoaded();
      const market = getMarket(input.symbol);
      const upstreamSymbol = (market?.externalSymbol || input.symbol).toUpperCase();
      if (market?.marketMode === "binance_mirror" && market.marketDataSource === "binance") {
        const rows = await getBinanceRecentTrades(upstreamSymbol, input.limit).catch(() => null);
        if (rows) return rows.map((t) => ({ ...toHubTradeShape(t, input.symbol), price: transformReferencePrice(String(t.price), market) })).reverse();
      }
      const hub = getMarketDataHub();
      return hub.getRecentTrades(input.symbol).slice(0, input.limit);
    }),

  klines: publicProcedure
    .input(z.object({
      symbol: symbolSchema,
      interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]).default("1m"),
      limit: z.number().int().min(1).max(500).default(120),
    }))
    .query(async ({ input }) => {
      await ensureMarketsLoaded();
      const market = getMarket(input.symbol);
      const upstreamSymbol = (market?.externalSymbol || input.symbol).toUpperCase();
      if (market?.marketMode === "binance_mirror" && market.marketDataSource === "binance" && market.klineFollowMode !== "synthetic") {
        const rows = await getBinanceKlines(upstreamSymbol, input.interval, input.limit).catch(() => null);
        if (rows) return rows.map((k) => ({
          symbol: input.symbol,
          openTime: k[0],
          open: transformReferencePrice(k[1], market),
          high: transformReferencePrice(k[2], market),
          low: transformReferencePrice(k[3], market),
          close: transformReferencePrice(k[4], market),
          volume: k[5],
          interval: input.interval,
        }));
      }
      const hub = getMarketDataHub();
      return hub.getKlines(input.symbol).slice(-input.limit);
    }),

  orderBook: publicProcedure
    .input(z.object({ symbol: symbolSchema, depth: z.number().int().min(1).max(50).default(15) }))
    .query(async ({ input }) => {
      try {
        await ensureMarketsLoaded();
        const market = getMarket(input.symbol);
        if (!market || !market.isActive) return { bids: [] as [string, string][], asks: [] as [string, string][] };
        const eng = await getMatchingEngine();
        const internal = eng.depth(input.symbol, input.depth);
        // Binance-mirror public market pages must keep ticker, trades and book on the same
        // upstream Binance snapshot family. Merging internal synthetic/user liquidity here
        // makes the visible best bid/ask diverge from Binance and from the latest trade.
        if (market.marketMode !== "binance_mirror") return internal;
        const upstreamSymbol = market.externalSymbol || input.symbol;
        const configuredDepth = Math.min(input.depth, market.maxDepthLevels ?? input.depth);
        const mirror = await getBinanceDepth(upstreamSymbol, configuredDepth).catch(
          () => null
        );
        const localLastPrice = getMarketDataHub().getTicker(input.symbol)?.lastPrice;
        const referenceTicker = localLastPrice ? null : await getBinance24hrTicker(upstreamSymbol).catch(() => null);
        const lastPrice = localLastPrice ?? (referenceTicker?.lastPrice ? transformReferencePrice(referenceTicker.lastPrice, market) : undefined);
        if (!mirror) return syntheticDepthAround(lastPrice ?? "1", market, configuredDepth);
        return {
          bids: transformDepthLevels(mirror.bids, market, lastPrice),
          asks: transformDepthLevels(mirror.asks, market, lastPrice),
        };
      } catch (err) {
        // Gracefully degrade on DB connection errors (ECONNRESET, etc.)
        // Return empty book rather than 500 so the frontend can show a skeleton
        console.warn('[orderBook] query failed, returning empty book:', (err as Error).message);
        return { bids: [] as [string, string][], asks: [] as [string, string][] };
      }
    }),

  /* -------------------- account -------------------- */
  bindWallet: protectedProcedure
    .input(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chain: evmWalletBindChainSchema }))
    .mutation(async ({ ctx, input }) => {
      const user = await bindPrimaryWalletAddress(ctx.user.id, input.address, input.chain);
      return { ok: true, address: user.primaryWalletAddress };
    }),

  profile: protectedProcedure.query(async ({ ctx }) => {
    await ensureDefaultSubAccount(ctx.user.id);
    return getAccountProfile(ctx.user.id);
  }),

  balances: protectedProcedure.query(async ({ ctx }) => {
    await ensureDefaultSubAccount(ctx.user.id);
    return getUserBalances(ctx.user.id);
  }),

  /* -------------------- deposits -------------------- */
  depositAddresses: protectedProcedure.query(async ({ ctx }) => {
    for (const supportedChain of SUPPORTED_CHAINS) {
      await getOrCreateDepositAddress(ctx.user.id, supportedChain);
    }
    return listUserDepositAddresses(ctx.user.id);
  }),

  depositHistory: protectedProcedure.query(({ ctx }) =>
    listUserDeposits(ctx.user.id)
  ),

  simulateDeposit: protectedProcedure
    .input(z.object({ chain: chainSchema, asset: symbolSchema, amount: posDecSchema }))
    .mutation(async ({ ctx, input }) => {
      // P0 security: only admin can simulate deposits
      adminOnly(ctx.user.role);
      // Cap simulated deposit at 1,000,000 units per call to prevent abuse
      const amt = Number(input.amount);
      if (!isFinite(amt) || amt <= 0) throw new Error("Amount must be positive");
      if (amt > 1_000_000) throw new Error("Simulated deposit capped at 1,000,000 units");
      return simulateIncoming(ctx.user.id, input.chain, input.asset, input.amount);
    }),

  /* -------------------- withdrawals -------------------- */
  submitWithdrawal: protectedProcedure
    .input(z.object({
      chain: chainSchema,
      asset: symbolSchema,
      amount: posDecSchema,
      toAddress: z.string().min(1).max(64),
    }))
    .mutation(async ({ ctx, input }) => {
      return submitWithdrawal({
        userId: ctx.user.id,
        chain: input.chain,
        asset: input.asset,
        amount: input.amount,
        toAddress: input.toAddress,
      });
    }),

  withdrawHistory: protectedProcedure.query(({ ctx }) =>
    listUserWithdrawals(ctx.user.id)
  ),

  /* -------------------- transfers -------------------- */
  subAccounts: protectedProcedure.query(({ ctx }) =>
    listUserSubAccounts(ctx.user.id)
  ),
  createSubAccount: protectedProcedure
    .input(z.object({ name: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) => createSubAccount(ctx.user.id, input.name)),
  transfer: protectedProcedure
    .input(
      z.object({
        fromSubAccountId: z.number().int(),
        toSubAccountId: z.number().int(),
        asset: z.string(),
        amount: z.string(),
        note: z.string().optional(),
      })
    )
    .mutation(({ ctx, input }) =>
      transferBetweenSubAccounts({ userId: ctx.user.id, ...input })
    ),
  transferHistory: protectedProcedure.query(({ ctx }) =>
    listUserTransfers(ctx.user.id)
  ),

  /* -------------------- trading -------------------- */
  submitOrder: protectedProcedure
    .input(
      z.object({
        symbol: symbolSchema,
        side: z.enum(["buy", "sell"]),
        type: z.enum(["limit", "market"]),
        price: posDecSchema.optional(),
        quantity: posDecSchema,
        clientOrderId: clientOrderIdSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await ensureMarketsLoaded();
      const market = getMarket(input.symbol);
      if (!market || !market.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "交易对不存在或已下架" });
      if (market.allowRealTrade === false) throw new TRPCError({ code: "BAD_REQUEST", message: "该交易对当前仅展示行情，暂不允许真实成交" });
      if (input.type === "market" && !market.allowMarketOrder) throw new TRPCError({ code: "BAD_REQUEST", message: "该交易对已关闭市价单" });
      if (input.type === "limit" && !market.allowLimitOrder) throw new TRPCError({ code: "BAD_REQUEST", message: "该交易对已关闭限价单" });
      const subId = await ensureDefaultSubAccount(ctx.user.id);
      const eng = await getMatchingEngine();
      const result = await eng.submitOrder({
        userId: ctx.user.id,
        subAccountId: subId,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        price: input.price,
        quantity: input.quantity,
        source: "web",
        clientOrderId: input.clientOrderId,
      });
      // fire-and-forget hedge
      const hedgeFills = result.fills as Array<{ quantity: string | number | bigint; price: string | number | bigint }>;
      if (hedgeFills.length > 0) {
        const totalQty = hedgeFills.reduce((a, f) => a + Number(f.quantity), 0).toString();
        const avgPx = result.order?.avgPrice ?? hedgeFills[0].price.toString();
        void recordHedgeIntent({
          symbol: input.symbol,
          side: input.side,
          quantity: totalQty,
          price: String(avgPx),
          userOrderId: result.order!.id,
        }).catch(() => undefined);
      }
      return result.order;
    }),

  cancelOrder: protectedProcedure
    .input(z.object({ orderId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const eng = await getMatchingEngine();
      return eng.cancelOrder(ctx.user.id, input.orderId);
    }),

  openOrders: protectedProcedure
    .input(z.object({ symbol: symbolSchema.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      // FIX B004: Filter status at the SQL level BEFORE applying LIMIT.
      // The old code queried the latest 200 rows of ALL statuses and then
      // filtered in memory — if a user had >200 historical orders, older
      // open orders could be silently dropped from the result.
      const { or } = await import("drizzle-orm");
      const conds = [
        eq(ordersTable.userId, ctx.user.id),
        or(eq(ordersTable.status, "new"), eq(ordersTable.status, "partial")),
      ];
      if (input?.symbol) conds.push(eq(ordersTable.symbol, input.symbol));
      return db
        .select()
        .from(ordersTable)
        .where(and(...conds))
        .orderBy(desc(ordersTable.createdAt))
        .limit(500); // raise cap since we now filter in SQL
    }),

  orderHistory: protectedProcedure
    .input(
      z
        .object({ symbol: symbolSchema.optional(), limit: z.number().int().min(1).max(500).default(100) })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const conds = [eq(ordersTable.userId, ctx.user.id)];
      if (input?.symbol) conds.push(eq(ordersTable.symbol, input.symbol));
      return db
        .select()
        .from(ordersTable)
        .where(and(...conds))
        .orderBy(desc(ordersTable.createdAt))
        .limit(input?.limit ?? 100);
    }),

  myTrades: protectedProcedure
    .input(z.object({ symbol: symbolSchema.optional(), limit: z.number().int().min(1).max(500).default(100) }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      // Apply symbol filter at DB level to ensure pagination accuracy
      // (previously applied in-memory AFTER limit, causing trades to be missed)
      const userCondition = sql`(${tradesTable.buyerUserId} = ${ctx.user.id} OR ${tradesTable.sellerUserId} = ${ctx.user.id})`;
      const whereClause = input?.symbol
        ? and(userCondition, eq(tradesTable.symbol, input.symbol))
        : userCondition;
      const rows = await db
        .select()
        .from(tradesTable)
        .where(whereClause)
        .orderBy(desc(tradesTable.createdAt))
        .limit(input?.limit ?? 100);
      return rows;
    }),

  /* -------------------- notifications -------------------- */
  getNotifications: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).optional())
    .query(({ ctx, input }) => getUserNotifications(ctx.user.id, input?.limit ?? 30)),

  unreadNotificationCount: protectedProcedure
    .query(({ ctx }) => getUnreadCount(ctx.user.id)),

  markNotificationsRead: protectedProcedure
    .input(z.object({ ids: z.array(z.number().int()).optional() }).optional())
    .mutation(({ ctx, input }) => markNotificationsRead(ctx.user.id, input?.ids)),

  /* -------------------- admin -------------------- */
  getPlatformMode: publicProcedure.query(async () => ({
    mode: await getPlatformMode(),
  })),
  setPlatformMode: protectedProcedure
    .input(z.object({ mode: z.enum(["internal_only", "hedged"]) }))
    .mutation(async ({ ctx, input }) => {
      adminOnly(ctx.user.role);
      await setPlatformMode(input.mode);
      return { ok: true, mode: input.mode };
    }),
  hedgeLog: protectedProcedure.query(async ({ ctx }) => {
    adminOnly(ctx.user.role);
    return recentHedgeLog();
  }),
  marketSources: protectedProcedure.query(async ({ ctx }) => {
    adminOnly(ctx.user.role);
    const hub = getMarketDataHub();
    const h = hub.sourceHealth();
    return {
      binance: h.binance,
      okx: h.okx,
      hyperliquid: h.hyperliquid,
      distinctSourcesSeen: h.distinctSourcesSeen.slice(0, 30),
    };
  }),

  pendingWithdrawals: protectedProcedure.query(async ({ ctx }) => {
    adminOnly(ctx.user.role);
    return listPendingWithdrawals();
  }),
  apiKeys: protectedProcedure.query(({ ctx }) => listUserApiKeys(ctx.user.id)),
  createApiKey: protectedProcedure
    .input(
      z.object({
        label: z.string().min(1).max(64),
        permissions: z
          .object({
            read: z.boolean().default(true),
            trade: z.boolean().default(true),
            withdraw: z.boolean().default(false),
          })
          .default({ read: true, trade: true, withdraw: false }),
        ipWhitelist: z.array(z.string().min(1).max(64)).max(20).default([]),
      })
    )
    .mutation(({ ctx, input }) =>
      createApiKey(ctx.user.id, input.label, input.permissions, input.ipWhitelist)
    ),
  revokeApiKey: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(({ ctx, input }) => revokeApiKey(ctx.user.id, input.id)),

  reviewWithdrawal: protectedProcedure
    .input(
      z.object({
        id: z.number().int(),
        decision: z.enum(["approve", "reject"]),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      adminOnly(ctx.user.role);
      if (input.decision === "approve") {
        await approveWithdrawal(input.id);
      } else {
        await rejectWithdrawal(input.id, input.reason ?? "admin rejected");
      }
      return { ok: true };
    }),
});

