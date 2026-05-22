/**
 * Admin tRPC router — all procedures require admin role.
 * Covers: platform stats, user management, order management,
 * deposit/withdrawal management, fee settings, market config.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  users,
  subAccounts,
  assetAccounts,
  orders as ordersTable,
  trades as tradesTable,
  deposits as depositsTable,
  withdrawals as withdrawalsTable,
  markets as marketsTable,
  ledgerEntries,
  adminActionLogs,
  transfers as transfersTable,
  apiKeys,
} from "../../drizzle/schema";
import {
  and,
  desc,
  eq,
  gte,
  lte,
  like,
  or,
  sql,
  count,
  sum,
  asc,
  ne,
  between,
  isNull,
  inArray,
} from "drizzle-orm";
import { applyLedgerChange } from "../exchange/accounts/ledger";
import { ensureDefaultSubAccount } from "../exchange/accounts/ledger";
import { getMatchingEngine } from "../exchange/matching/engine";
import { parseDec, formatDec } from "../exchange/utils/bigdec";
import {
  approveWithdrawal,
  rejectWithdrawal,
  listPendingWithdrawals,
} from "../exchange/withdrawals/service";
import {
  getPlatformMode,
  setPlatformMode,
  recentHedgeLog,
} from "../exchange/hedge/service";
import { listAdminApiKeys, revokeAnyApiKey } from "../exchange/apikeys/service";
import { getMarketDataHub } from "../exchange/marketdata/hub";
import { refreshMarketCache } from "../exchange/markets/registry";
import { SUPPORTED_CHAINS } from "@shared/wallet";

/** Write an audit log entry for every admin action */
async function auditLog(
  adminId: number,
  adminName: string | null | undefined,
  action: string,
  targetType: string | null,
  targetId: string | null,
  before: unknown,
  after: unknown,
  note?: string
) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(adminActionLogs).values({
      adminId,
      adminName: adminName ?? "admin",
      action,
      targetType,
      targetId,
      before: before as any,
      after: after as any,
      note: note ?? null,
    });
  } catch (e) {
    console.error("[auditLog] failed:", e);
  }
}

/** Middleware: reject non-admin callers */
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "管理员权限不足" });
  }
  return next({ ctx });
});

const SYMBOL_RE = /^[A-Z0-9]{3,32}$/;
const ASSET_RE = /^[A-Z0-9]{2,16}$/;
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;

const positiveDecimal = z.string().regex(DECIMAL_RE, "必须是非负数字").refine((v) => Number(v) > 0, "必须大于 0");
const feeDecimal = z.string().regex(DECIMAL_RE, "必须是非负数字").refine((v) => Number(v) >= 0 && Number(v) <= 0.1, "费率应在 0 到 0.1 之间");
const marketSymbolInput = z.string().trim().transform((v) => v.toUpperCase()).refine((v) => SYMBOL_RE.test(v), "交易对格式不正确");
const assetSymbolInput = z.string().trim().transform((v) => v.toUpperCase()).refine((v) => ASSET_RE.test(v), "币种格式不正确");
const optionalUrl = z.string().trim().url("请输入有效 URL").max(512).optional().or(z.literal(""));
const optionalText = z.string().trim().max(5000).optional().or(z.literal(""));
const optionalContractAddress = z.string().trim().max(128).optional().or(z.literal(""));
const refExchangeInput = z.enum(["binance", "okx", "bybit", "manual"]);
const klineFollowModeInput = z.enum(["scaled", "synthetic"]);
const nonNegativeDecimal = z.string().regex(DECIMAL_RE, "必须是非负数字");
const ratioDecimal = positiveDecimal.refine((v) => Number(v) <= 1000000, "价格倍率过大");
const spreadDecimal = nonNegativeDecimal.refine((v) => Number(v) >= 0 && Number(v) <= 0.2, "买卖价差应在 0 到 0.2 之间");
const jumpDecimal = nonNegativeDecimal.refine((v) => Number(v) >= 0 && Number(v) <= 1, "最大价格跳变应在 0 到 1 之间");
function emptyToNull(value: string | undefined) {
  return value && value.trim() ? value.trim() : null;
}

function inferPrecision(decimal: string) {
  const [, frac = ""] = decimal.split(".");
  return frac.replace(/0+$/, "").length;
}

function validateFeePair(takerFee?: string, makerFee?: string) {
  if (takerFee !== undefined && makerFee !== undefined && Number(makerFee) > Number(takerFee)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Maker 费率不应高于 Taker 费率" });
  }
}

export const adminRouter = router({
  /* ------------------------------------------------------------------ */
  /* 1. Platform overview stats                                          */
  /* ------------------------------------------------------------------ */
  overview: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });

    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // Today = midnight of current day (UTC)
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);

    const [
      totalUsersRow,
      activeUsersRow,
      todayNewUsersRow,
      totalOrdersRow,
      openOrdersRow,
      totalTradesRow,
      trades24hRow,
      todayTradesRow,
      pendingWithdrawalsRow,
    ] = await Promise.all([
      db.select({ c: count() }).from(users),
      db.select({ c: count() }).from(users).where(gte(users.lastSignedIn, since24h)),
      db.select({ c: count() }).from(users).where(gte(users.createdAt, todayStart)),
      db.select({ c: count() }).from(ordersTable),
      db.select({ c: count() }).from(ordersTable).where(
        or(eq(ordersTable.status, "new"), eq(ordersTable.status, "partial"))
      ),
      db.select({ c: count(), vol: sum(ordersTable.quoteFilled) }).from(ordersTable)
        .where(eq(ordersTable.status, "filled")),
      db.select({ c: count(), vol: sum(tradesTable.quoteQty) }).from(tradesTable)
        .where(gte(tradesTable.createdAt, since24h)),
      db.select({ c: count(), vol: sum(tradesTable.quoteQty) }).from(tradesTable)
        .where(gte(tradesTable.createdAt, todayStart)),
      db.select({ c: count() }).from(withdrawalsTable).where(eq(withdrawalsTable.status, "pending")),
    ]);

    // Total fee income from ledger
    const feeRow = await db
      .select({ total: sum(ledgerEntries.delta) })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.reason, "trade_fee"));

    // Fee income last 24h
    const fee24hRow = await db
      .select({ total: sum(ledgerEntries.delta) })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.reason, "trade_fee"), gte(ledgerEntries.createdAt, since24h)));

    // Today fee income
    const todayFeeRow = await db
      .select({ total: sum(ledgerEntries.delta) })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.reason, "trade_fee"), gte(ledgerEntries.createdAt, todayStart)));

    // Per-asset fee income (all time)
    const feeByAssetRows = await db
      .select({ asset: ledgerEntries.asset, total: sum(ledgerEntries.delta) })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.reason, "trade_fee"))
      .groupBy(ledgerEntries.asset);

    return {
      totalUsers: totalUsersRow[0]?.c ?? 0,
      activeUsers24h: activeUsersRow[0]?.c ?? 0,
      todayNewUsers: todayNewUsersRow[0]?.c ?? 0,
      totalOrders: totalOrdersRow[0]?.c ?? 0,
      openOrders: openOrdersRow[0]?.c ?? 0,
      totalTrades: totalTradesRow[0]?.c ?? 0,
      totalVolume: totalTradesRow[0]?.vol ?? "0",
      trades24h: trades24hRow[0]?.c ?? 0,
      volume24h: trades24hRow[0]?.vol ?? "0",
      todayTrades: todayTradesRow[0]?.c ?? 0,
      todayVolume: todayTradesRow[0]?.vol ?? "0",
      totalFeeIncome: feeRow[0]?.total ?? "0",
      feeIncome24h: fee24hRow[0]?.total ?? "0",
      todayFeeIncome: todayFeeRow[0]?.total ?? "0",
      feeByAsset: feeByAssetRows.map((r) => ({ asset: r.asset, total: r.total ?? "0" })),
      pendingWithdrawals: pendingWithdrawalsRow[0]?.c ?? 0,
    };
  }),

  /* Recent trades for overview chart */
  recentTrades: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(tradesTable)
        .orderBy(desc(tradesTable.createdAt))
        .limit(input?.limit ?? 50);
    }),

  /* ------------------------------------------------------------------ */
  /* 2. User management                                                  */
  /* ------------------------------------------------------------------ */
  listUsers: adminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        search: z.string().optional(),
        role: z.enum(["user", "admin", "all"]).default("all"),
        banned: z.boolean().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { rows: [], total: 0 };
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 20;
      const offset = (page - 1) * pageSize;

      const conditions = [];
      if (input?.search) {
        conditions.push(
          or(
            like(users.name, `%${input.search}%`),
            like(users.email, `%${input.search}%`),
            like(users.primaryWalletAddress, `%${input.search}%`)
          )
        );
      }
      if (input?.role && input.role !== "all") {
        conditions.push(eq(users.role, input.role));
      }
      if (input?.banned !== undefined) {
        conditions.push(eq(users.isBanned, input.banned));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRow] = await Promise.all([
        db.select().from(users).where(where).orderBy(desc(users.createdAt)).limit(pageSize).offset(offset),
        db.select({ c: count() }).from(users).where(where),
      ]);

      return { rows, total: totalRow[0]?.c ?? 0 };
    }),

  getUserDetail: adminProcedure
    .input(z.object({ userId: z.number().int() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });

      const [balances, recentOrders, recentDeposits, recentWithdrawals] = await Promise.all([
        db.select().from(assetAccounts).where(eq(assetAccounts.userId, input.userId)),
        db.select().from(ordersTable).where(eq(ordersTable.userId, input.userId))
          .orderBy(desc(ordersTable.createdAt)).limit(20),
        db.select().from(depositsTable).where(eq(depositsTable.userId, input.userId))
          .orderBy(desc(depositsTable.createdAt)).limit(10),
        db.select().from(withdrawalsTable).where(eq(withdrawalsTable.userId, input.userId))
          .orderBy(desc(withdrawalsTable.createdAt)).limit(10),
      ]);

      return { user, balances, recentOrders, recentDeposits, recentWithdrawals };
    }),

  setUserRole: adminProcedure
    .input(z.object({ userId: z.number().int(), role: z.enum(["user", "admin"]) }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select({ role: users.role }).from(users).where(eq(users.id, input.userId)).limit(1);
      await db.update(users).set({ role: input.role }).where(eq(users.id, input.userId));
      await auditLog(ctx.user.id, ctx.user.name, "set_user_role", "user", String(input.userId), before, { role: input.role });
      return { ok: true };
    }),

  banUser: adminProcedure
    .input(z.object({ userId: z.number().int(), ban: z.boolean(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select({ isBanned: users.isBanned, banReason: users.banReason }).from(users).where(eq(users.id, input.userId)).limit(1);
      const newValues = { isBanned: input.ban, banReason: input.ban ? (input.reason ?? "违规操作") : null };
      await db.update(users).set(newValues).where(eq(users.id, input.userId));
      await auditLog(ctx.user.id, ctx.user.name, input.ban ? "ban_user" : "unban_user", "user", String(input.userId), before, newValues, input.reason);
      return { ok: true };
    }),

  adjustBalance: adminProcedure
    .input(
      z.object({
        userId: z.number().int(),
        asset: z.string().min(1).max(16),
        delta: z.string().regex(/^-?\d+(?:\.\d+)?$/, "Must be a decimal number"),
        reason: z.string().min(1).max(128).default("管理员调整"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const subId = await ensureDefaultSubAccount(input.userId);
      // Snapshot balance before
      const [before] = await db.select({ available: assetAccounts.available, locked: assetAccounts.locked })
        .from(assetAccounts)
        .where(and(eq(assetAccounts.userId, input.userId), eq(assetAccounts.asset, input.asset)))
        .limit(1);
      const deltaBI = parseDec(input.delta);
      await applyLedgerChange({
        userId: input.userId,
        subAccountId: subId,
        asset: input.asset,
        delta: deltaBI,
        lockedDelta: 0n,
        reason: "admin_adjust",
      });
      const [after] = await db.select({ available: assetAccounts.available, locked: assetAccounts.locked })
        .from(assetAccounts)
        .where(and(eq(assetAccounts.userId, input.userId), eq(assetAccounts.asset, input.asset)))
        .limit(1);
      await auditLog(ctx.user.id, ctx.user.name, "adjust_balance", "user", String(input.userId), { asset: input.asset, ...before }, { asset: input.asset, delta: input.delta, ...after }, input.reason);
      return { ok: true, delta: formatDec(deltaBI) };
    }),



  /* API Key risk management */
  listApiKeys: adminProcedure
    .input(z.object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(20),
      search: z.string().optional(),
      includeRevoked: z.boolean().default(false),
    }).optional())
    .query(async ({ input }) => {
      return listAdminApiKeys({
        page: input?.page ?? 1,
        pageSize: input?.pageSize ?? 20,
        search: input?.search,
        includeRevoked: input?.includeRevoked ?? false,
      });
    }),
  revokeApiKey: adminProcedure
    .input(z.object({ id: z.number().int().positive(), note: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const result = await revokeAnyApiKey(input.id);
      await auditLog(
        ctx.user.id,
        ctx.user.name,
        "revoke_api_key",
        "api_key",
        String(input.id),
        { userId: result.before.userId, label: result.before.label, publicKey: result.before.publicKey, revokedAt: result.before.revokedAt },
        { revokedAt: new Date().toISOString() },
        input.note ?? "管理员撤销 API Key"
      );
      return { ok: true };
    }),

  /* ------------------------------------------------------------------ */
  /* 3. Order management                                                 */
  /* ------------------------------------------------------------------ */
  listAllOrders: adminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        symbol: z.string().optional(),
        status: z.enum(["new", "partial", "filled", "canceled", "rejected", "all"]).default("all"),
        userId: z.number().int().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { rows: [], total: 0 };
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 20;
      const offset = (page - 1) * pageSize;

      const conditions = [];
      if (input?.symbol) conditions.push(eq(ordersTable.symbol, input.symbol));
      if (input?.status && input.status !== "all") conditions.push(eq(ordersTable.status, input.status));
      if (input?.userId) conditions.push(eq(ordersTable.userId, input.userId));

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRow] = await Promise.all([
        db.select().from(ordersTable).where(where).orderBy(desc(ordersTable.createdAt)).limit(pageSize).offset(offset),
        db.select({ c: count() }).from(ordersTable).where(where),
      ]);

      const orderIds = rows.map((row) => row.id);
      const feeByOrderId = new Map<number, bigint>();
      if (orderIds.length > 0) {
        const relatedTrades = await db
          .select({
            buyerOrderId: tradesTable.buyerOrderId,
            sellerOrderId: tradesTable.sellerOrderId,
            buyerFee: tradesTable.buyerFee,
            sellerFee: tradesTable.sellerFee,
          })
          .from(tradesTable)
          .where(or(inArray(tradesTable.buyerOrderId, orderIds), inArray(tradesTable.sellerOrderId, orderIds)));

        for (const trade of relatedTrades) {
          if (orderIds.includes(trade.buyerOrderId)) {
            feeByOrderId.set(trade.buyerOrderId, (feeByOrderId.get(trade.buyerOrderId) ?? BigInt(0)) + parseDec(trade.buyerFee));
          }
          if (orderIds.includes(trade.sellerOrderId)) {
            feeByOrderId.set(trade.sellerOrderId, (feeByOrderId.get(trade.sellerOrderId) ?? BigInt(0)) + parseDec(trade.sellerFee));
          }
        }
      }

      return {
        rows: rows.map((row) => ({
          ...row,
          feeAmount: formatDec(feeByOrderId.get(row.id) ?? BigInt(0)),
        })),
        total: totalRow[0]?.c ?? 0,
      };
    }),

  forceCancel: adminProcedure
    .input(z.object({ orderId: z.number().int() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "订单不存在" });
      const eng = await getMatchingEngine();
      await eng.cancelOrder(order.userId, input.orderId);
      await auditLog(ctx.user.id, ctx.user.name, "force_cancel_order", "order", String(input.orderId), { status: order.status, symbol: order.symbol, userId: order.userId }, { status: "canceled" });
      return { ok: true };
    }),

  bulkCancel: adminProcedure
    .input(z.object({ orderIds: z.array(z.number().int()).min(1).max(100) }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const eng = await getMatchingEngine();
      const results: { orderId: number; ok: boolean; error?: string }[] = [];
      for (const orderId of input.orderIds) {
        try {
          const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
          if (!order) { results.push({ orderId, ok: false, error: "not found" }); continue; }
          await eng.cancelOrder(order.userId, orderId);
          results.push({ orderId, ok: true });
        } catch (e: any) {
          results.push({ orderId, ok: false, error: e.message });
        }
      }
      await auditLog(ctx.user.id, ctx.user.name, "bulk_cancel_orders", "order", input.orderIds.join(","), null, { count: input.orderIds.length, results });
      return { results };
    }),

  /* ------------------------------------------------------------------ */
  /* 4. Deposit management                                               */
  /* ------------------------------------------------------------------ */
  listAllDeposits: adminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        status: z.enum(["pending", "confirmed", "credited", "all"]).default("all"),
        userId: z.number().int().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { rows: [], total: 0 };
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 20;
      const offset = (page - 1) * pageSize;

      const conditions = [];
      if (input?.status && input.status !== "all") conditions.push(eq(depositsTable.status, input.status));
      if (input?.userId) conditions.push(eq(depositsTable.userId, input.userId));

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRow] = await Promise.all([
        db.select().from(depositsTable).where(where).orderBy(desc(depositsTable.createdAt)).limit(pageSize).offset(offset),
        db.select({ c: count() }).from(depositsTable).where(where),
      ]);

      return { rows, total: totalRow[0]?.c ?? 0 };
    }),

  /* ------------------------------------------------------------------ */
  /* 5. Withdrawal management                                            */
  /* ------------------------------------------------------------------ */
  listAllWithdrawals: adminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        status: z.enum(["pending", "reviewing", "approved", "confirmed", "rejected", "failed", "all"]).default("all"),
        userId: z.number().int().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { rows: [], total: 0 };
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 20;
      const offset = (page - 1) * pageSize;

      const conditions = [];
      if (input?.status && input.status !== "all") conditions.push(eq(withdrawalsTable.status, input.status));
      if (input?.userId) conditions.push(eq(withdrawalsTable.userId, input.userId));

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRow] = await Promise.all([
        db.select().from(withdrawalsTable).where(where).orderBy(desc(withdrawalsTable.createdAt)).limit(pageSize).offset(offset),
        db.select({ c: count() }).from(withdrawalsTable).where(where),
      ]);

      return { rows, total: totalRow[0]?.c ?? 0 };
    }),

  pendingWithdrawals: adminProcedure.query(() => listPendingWithdrawals()),

  reviewWithdrawal: adminProcedure
    .input(
      z.object({
        id: z.number().int(),
        decision: z.enum(["approve", "reject"]),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select({ status: withdrawalsTable.status, amount: withdrawalsTable.amount }).from(withdrawalsTable).where(eq(withdrawalsTable.id, input.id)).limit(1);
      if (input.decision === "approve") {
        await approveWithdrawal(input.id);
      } else {
        await rejectWithdrawal(input.id, input.reason ?? "管理员驳回");
      }
      await auditLog(ctx.user.id, ctx.user.name, input.decision === "approve" ? "approve_withdrawal" : "reject_withdrawal", "withdrawal", String(input.id), before, { status: input.decision === "approve" ? "approved" : "rejected" }, input.reason);
      return { ok: true };
    }),

  /* ------------------------------------------------------------------ */
  /* 6. Fee management                                                   */
  /* ------------------------------------------------------------------ */
  listMarkets: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(marketsTable).orderBy(marketsTable.symbol);
  }),

  updateMarketFees: adminProcedure
    .input(
      z.object({
        symbol: marketSymbolInput,
        takerFee: feeDecimal.optional(),
        makerFee: feeDecimal.optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select({ takerFee: marketsTable.takerFee, makerFee: marketsTable.makerFee }).from(marketsTable).where(eq(marketsTable.symbol, input.symbol)).limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "交易对不存在" });
      const nextTaker = input.takerFee ?? before.takerFee;
      const nextMaker = input.makerFee ?? before.makerFee;
      validateFeePair(nextTaker, nextMaker);
      const updates: Record<string, string> = {};
      if (input.takerFee !== undefined) updates.takerFee = input.takerFee;
      if (input.makerFee !== undefined) updates.makerFee = input.makerFee;
      if (Object.keys(updates).length === 0) return { ok: true };
      await db.update(marketsTable).set(updates).where(eq(marketsTable.symbol, input.symbol));
      await auditLog(ctx.user.id, ctx.user.name, "update_market_fees", "market", input.symbol, before, updates);
      return { ok: true };
    }),
  /* ------------------------------------------------------------------ */
  /* 7. Market (trading pair) management                                 */
  /* ------------------------------------------------------------------ */
  createMarket: adminProcedure
    .input(
      z.object({
        symbol: marketSymbolInput,
        base: assetSymbolInput,
        quote: assetSymbolInput.default("USDT"),
        minNotional: positiveDecimal.default("5"),
        priceTick: positiveDecimal.default("0.01"),
        amountStep: positiveDecimal.default("0.0001"),
        takerFee: feeDecimal.default("0.001"),
        makerFee: feeDecimal.default("0.0008"),
        marketMode: z.enum(["binance_mirror", "orderbook"]).default("binance_mirror"),
        externalSymbol: marketSymbolInput.optional(),
        marketDataSource: z.enum(["binance", "internal", "manual"]).default("binance"),
        refExchange: refExchangeInput.default("binance"),
        priceRatio: ratioDecimal.default("1"),
        priceOffset: nonNegativeDecimal.default("0"),
        spreadPct: spreadDecimal.default("0.002"),
        maxDepthLevels: z.number().int().min(1).max(50).default(15),
        updateIntervalSec: z.number().int().min(1).max(3600).default(3),
        maxPriceJumpPct: jumpDecimal.default("0.05"),
        klineFollowMode: klineFollowModeInput.default("scaled"),
        allowRealTrade: z.boolean().default(true),
        allowMarketOrder: z.boolean().default(true),
        allowLimitOrder: z.boolean().default(true),
        isActive: z.boolean().default(true),
        logoUrl: optionalUrl,
        description: optionalText,
        websiteUrl: optionalUrl,
        whitepaperUrl: optionalUrl,
        explorerUrl: optionalUrl,
        contractAddress: optionalContractAddress,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.symbol !== `${input.base}${input.quote}`) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "交易对代码应等于基础币种+计价币种，例如 BTCUSDT" });
      }
      validateFeePair(input.takerFee, input.makerFee);
      const [existing] = await db.select({ symbol: marketsTable.symbol }).from(marketsTable).where(eq(marketsTable.symbol, input.symbol)).limit(1);
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "交易对已存在" });
      const row = {
        symbol: input.symbol,
        base: input.base,
        quote: input.quote,
        minNotional: input.minNotional,
        priceTick: input.priceTick,
        amountStep: input.amountStep,
        pricePrecision: inferPrecision(input.priceTick),
        amountPrecision: inferPrecision(input.amountStep),
        takerFee: input.takerFee,
        makerFee: input.makerFee,
        marketMode: input.marketMode,
        externalSymbol: input.externalSymbol ?? input.symbol,
        marketDataSource: input.marketDataSource,
        refExchange: input.refExchange,
        priceRatio: input.priceRatio,
        priceOffset: input.priceOffset,
        spreadPct: input.spreadPct,
        maxDepthLevels: input.maxDepthLevels,
        updateIntervalSec: input.updateIntervalSec,
        maxPriceJumpPct: input.maxPriceJumpPct,
        klineFollowMode: input.klineFollowMode,
        allowRealTrade: input.allowRealTrade,
        allowMarketOrder: input.allowMarketOrder,
        allowLimitOrder: input.allowLimitOrder,
        isActive: input.isActive,
        logoUrl: emptyToNull(input.logoUrl),
        description: emptyToNull(input.description),
        websiteUrl: emptyToNull(input.websiteUrl),
        whitepaperUrl: emptyToNull(input.whitepaperUrl),
        explorerUrl: emptyToNull(input.explorerUrl),
        contractAddress: emptyToNull(input.contractAddress),
      };
      await db.insert(marketsTable).values(row);
      await refreshMarketCache();
      await auditLog(ctx.user.id, ctx.user.name, "create_market", "market", input.symbol, null, row);
      return { ok: true, symbol: input.symbol };
    }),

  updateMarket: adminProcedure
    .input(
      z.object({
        symbol: marketSymbolInput,
        isActive: z.boolean().optional(),
        minNotional: positiveDecimal.optional(),
        priceTick: positiveDecimal.optional(),
        amountStep: positiveDecimal.optional(),
        marketMode: z.enum(["binance_mirror", "orderbook"]).optional(),
        externalSymbol: marketSymbolInput.optional(),
        marketDataSource: z.enum(["binance", "internal", "manual"]).optional(),
        refExchange: refExchangeInput.optional(),
        priceRatio: ratioDecimal.optional(),
        priceOffset: nonNegativeDecimal.optional(),
        spreadPct: spreadDecimal.optional(),
        maxDepthLevels: z.number().int().min(1).max(50).optional(),
        updateIntervalSec: z.number().int().min(1).max(3600).optional(),
        maxPriceJumpPct: jumpDecimal.optional(),
        klineFollowMode: klineFollowModeInput.optional(),
        allowRealTrade: z.boolean().optional(),
        allowMarketOrder: z.boolean().optional(),
        allowLimitOrder: z.boolean().optional(),
        logoUrl: optionalUrl,
        description: z.string().max(5000).optional().or(z.literal("")),
        websiteUrl: optionalUrl,
        whitepaperUrl: optionalUrl,
        explorerUrl: optionalUrl,
        contractAddress: optionalContractAddress,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { symbol, ...rest } = input;
      const [before] = await db.select().from(marketsTable).where(eq(marketsTable.symbol, symbol)).limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "交易对不存在" });
      const updates: Record<string, unknown> = {};
      if (rest.isActive !== undefined) updates.isActive = rest.isActive;
      if (rest.minNotional !== undefined) updates.minNotional = rest.minNotional;
      if (rest.priceTick !== undefined) { updates.priceTick = rest.priceTick; updates.pricePrecision = inferPrecision(rest.priceTick); }
      if (rest.amountStep !== undefined) { updates.amountStep = rest.amountStep; updates.amountPrecision = inferPrecision(rest.amountStep); }
      if (rest.marketMode !== undefined) updates.marketMode = rest.marketMode;
      if (rest.externalSymbol !== undefined) updates.externalSymbol = rest.externalSymbol;
      if (rest.marketDataSource !== undefined) updates.marketDataSource = rest.marketDataSource;
      if (rest.refExchange !== undefined) updates.refExchange = rest.refExchange;
      if (rest.priceRatio !== undefined) updates.priceRatio = rest.priceRatio;
      if (rest.priceOffset !== undefined) updates.priceOffset = rest.priceOffset;
      if (rest.spreadPct !== undefined) updates.spreadPct = rest.spreadPct;
      if (rest.maxDepthLevels !== undefined) updates.maxDepthLevels = rest.maxDepthLevels;
      if (rest.updateIntervalSec !== undefined) updates.updateIntervalSec = rest.updateIntervalSec;
      if (rest.maxPriceJumpPct !== undefined) updates.maxPriceJumpPct = rest.maxPriceJumpPct;
      if (rest.klineFollowMode !== undefined) updates.klineFollowMode = rest.klineFollowMode;
      if (rest.allowRealTrade !== undefined) updates.allowRealTrade = rest.allowRealTrade;
      if (rest.allowMarketOrder !== undefined) updates.allowMarketOrder = rest.allowMarketOrder;
      if (rest.allowLimitOrder !== undefined) updates.allowLimitOrder = rest.allowLimitOrder;
      if (rest.logoUrl !== undefined) updates.logoUrl = emptyToNull(rest.logoUrl);
      if (rest.description !== undefined) updates.description = emptyToNull(rest.description);
      if (rest.websiteUrl !== undefined) updates.websiteUrl = emptyToNull(rest.websiteUrl);
      if (rest.whitepaperUrl !== undefined) updates.whitepaperUrl = emptyToNull(rest.whitepaperUrl);
      if (rest.explorerUrl !== undefined) updates.explorerUrl = emptyToNull(rest.explorerUrl);
      if (rest.contractAddress !== undefined) updates.contractAddress = emptyToNull(rest.contractAddress);
      if (Object.keys(updates).length === 0) return { ok: true };
      await db.update(marketsTable).set(updates).where(eq(marketsTable.symbol, symbol));
      await refreshMarketCache();
      await auditLog(ctx.user.id, ctx.user.name, "update_market", "market", symbol, before, updates);
      return { ok: true };
    }),
  /* ------------------------------------------------------------------ */
  /* 8. System settings (hedge, data sources))                            */
  /* ------------------------------------------------------------------ */
  getPlatformMode: adminProcedure.query(async () => ({
    mode: await getPlatformMode(),
  })),

  setPlatformMode: adminProcedure
    .input(z.object({ mode: z.enum(["internal_only", "hedged"]) }))
    .mutation(async ({ input, ctx }) => {
      const before = await getPlatformMode();
      await setPlatformMode(input.mode);
      await auditLog(ctx.user.id, ctx.user.name, "set_platform_mode", "system", null, { mode: before }, { mode: input.mode });
      return { ok: true, mode: input.mode };
    }),
  hedgeLog: adminProcedure.query(() => recentHedgeLog()),

  marketSources: adminProcedure.query(() => {
    const hub = getMarketDataHub();
    const h = hub.sourceHealth();
    return {
      binance: h.binance,
      okx: h.okx,
      hyperliquid: h.hyperliquid,
      distinctSourcesSeen: h.distinctSourcesSeen.slice(0, 30),
    };
  }),

  /* Admin deposit credit */
  simulateDeposit: adminProcedure
    .input(
      z.object({
        userId: z.number().int(),
        chain: z.enum(SUPPORTED_CHAINS),
        asset: z.string().min(1).max(16).regex(/^[A-Z0-9_:-]+$/i),
        amount: z.string().regex(/^\d+(?:\.\d+)?$/),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { simulateIncoming } = await import("../exchange/deposits/service");
      const amt = Number(input.amount);
      if (amt <= 0 || amt > 1_000_000) throw new TRPCError({ code: "BAD_REQUEST", message: "金额超出范围" });
      const asset = input.asset.toUpperCase();
      const result = await simulateIncoming(input.userId, input.chain, asset, input.amount);
      await auditLog(ctx.user.id, ctx.user.name, "simulate_deposit", "user", String(input.userId), null, { chain: input.chain, asset, amount: input.amount });
      return result;
    }),

  /* ------------------------------------------------------------------ */
  /* 9. Revenue chart (7-day / 30-day)                                  */
  /* ------------------------------------------------------------------ */
  revenueChart: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(7) }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const days = input?.days ?? 7;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      // Get daily fee income and volume
      const rows = await db
        .select({
          day: sql<string>`DATE(${tradesTable.createdAt})`,
          volume: sum(tradesTable.quoteQty),
          tradeCount: count(),
        })
        .from(tradesTable)
        .where(gte(tradesTable.createdAt, since))
        .groupBy(sql`DATE(${tradesTable.createdAt})`);
      const feeRows = await db
        .select({
          day: sql<string>`DATE(${ledgerEntries.createdAt})`,
          fee: sum(ledgerEntries.delta),
        })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.reason, "trade_fee"), gte(ledgerEntries.createdAt, since)))
        .groupBy(sql`DATE(${ledgerEntries.createdAt})`);
      // Merge by day
      const feeMap = new Map(feeRows.map((r) => [r.day, r.fee ?? "0"]));
      return rows.map((r) => ({
        day: r.day,
        volume: r.volume ?? "0",
        tradeCount: r.tradeCount,
        feeIncome: feeMap.get(r.day) ?? "0",
      }));
    }),

  userGrowth: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(7) }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const days = input?.days ?? 7;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return db
        .select({
          day: sql<string>`DATE(${users.createdAt})`,
          newUsers: count(),
        })
        .from(users)
        .where(gte(users.createdAt, since))
        .groupBy(sql`DATE(${users.createdAt})`);
    }),

  /* ------------------------------------------------------------------ */
  /* 10. Top traders                                                     */
  /* ------------------------------------------------------------------ */
  topTraders: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const limit = input?.limit ?? 20;
      // Aggregate volume from trades (buyer + seller)
      const buyerRows = await db
        .select({
          userId: tradesTable.buyerUserId,
          volume: sum(tradesTable.quoteQty),
          tradeCount: count(),
        })
        .from(tradesTable)
        .groupBy(tradesTable.buyerUserId);
      const sellerRows = await db
        .select({
          userId: tradesTable.sellerUserId,
          volume: sum(tradesTable.quoteQty),
          tradeCount: count(),
        })
        .from(tradesTable)
        .groupBy(tradesTable.sellerUserId);
      // Merge
      const volumeMap = new Map<number, { volume: number; tradeCount: number }>();
      for (const r of [...buyerRows, ...sellerRows]) {
        const prev = volumeMap.get(r.userId) ?? { volume: 0, tradeCount: 0 };
        volumeMap.set(r.userId, {
          volume: prev.volume + Number(r.volume ?? 0),
          tradeCount: prev.tradeCount + Number(r.tradeCount),
        });
      }
      const sorted = Array.from(volumeMap.entries())
        .sort((a, b) => b[1].volume - a[1].volume)
        .slice(0, limit);
      if (sorted.length === 0) return [];
      const userIds = sorted.map(([id]) => id);
      const userRows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users)
        .where(or(...userIds.map((id) => eq(users.id, id))));
      const userMap = new Map(userRows.map((u) => [u.id, u]));
      return sorted.map(([userId, stats]) => ({
        userId,
        name: userMap.get(userId)?.name ?? "Unknown",
        email: userMap.get(userId)?.email ?? "",
        volume: stats.volume,
        tradeCount: stats.tradeCount,
      }));
    }),

  /* ------------------------------------------------------------------ */
  /* 11. Ledger audit trail                                              */
  /* ------------------------------------------------------------------ */
  getLedgerAudit: adminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(50),
        userId: z.number().int().optional(),
        asset: z.string().optional(),
        reason: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { rows: [], total: 0 };
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 50;
      const offset = (page - 1) * pageSize;
      const conditions = [];
      if (input?.userId) conditions.push(eq(ledgerEntries.userId, input.userId));
      if (input?.asset) conditions.push(eq(ledgerEntries.asset, input.asset));
      if (input?.reason) conditions.push(eq(ledgerEntries.reason, input.reason as any));
      if (input?.dateFrom) conditions.push(gte(ledgerEntries.createdAt, new Date(input.dateFrom)));
      if (input?.dateTo) conditions.push(lte(ledgerEntries.createdAt, new Date(input.dateTo)));
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const [rows, totalRow] = await Promise.all([
        db.select().from(ledgerEntries).where(where).orderBy(desc(ledgerEntries.createdAt)).limit(pageSize).offset(offset),
        db.select({ c: count() }).from(ledgerEntries).where(where),
      ]);
      return { rows, total: totalRow[0]?.c ?? 0 };
    }),

  /* ------------------------------------------------------------------ */
  /* 12. Fee income breakdown by market                                  */
  /* ------------------------------------------------------------------ */
  feeIncomeBreakdown: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(30) }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const days = input?.days ?? 30;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      // Fee income per symbol from trades
      return db
        .select({
          symbol: tradesTable.symbol,
          totalFee: sql<string>`SUM(CAST(${tradesTable.buyerFee} AS DECIMAL(36,18)) + CAST(${tradesTable.sellerFee} AS DECIMAL(36,18)))`,
          tradeCount: count(),
          totalVolume: sum(tradesTable.quoteQty),
        })
        .from(tradesTable)
        .where(gte(tradesTable.createdAt, since))
        .groupBy(tradesTable.symbol)
        .orderBy(desc(sql`SUM(CAST(${tradesTable.buyerFee} AS DECIMAL(36,18)) + CAST(${tradesTable.sellerFee} AS DECIMAL(36,18)))`));
    }),

  /* ------------------------------------------------------------------ */
  /* 13. Balance snapshot (platform asset totals)                        */
  /* ------------------------------------------------------------------ */
  balanceSnapshot: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select({
        asset: assetAccounts.asset,
        totalAvailable: sum(assetAccounts.available),
        totalLocked: sum(assetAccounts.locked),
        accountCount: count(),
      })
      .from(assetAccounts)
      .groupBy(assetAccounts.asset)
      .orderBy(assetAccounts.asset);
  }),

  /* ------------------------------------------------------------------ */
  /* 14. Risk alerts                                                     */
  /* ------------------------------------------------------------------ */
  riskAlerts: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const alerts: { level: string; type: string; message: string; data: unknown }[] = [];
    const since1h = new Date(Date.now() - 60 * 60 * 1000);
    // Large pending withdrawals (> 10000 USDT)
    const largeWithdrawals = await db
      .select()
      .from(withdrawalsTable)
      .where(and(eq(withdrawalsTable.status, "pending"), gte(withdrawalsTable.amount, "10000")))
      .orderBy(desc(withdrawalsTable.amount))
      .limit(10);
    for (const w of largeWithdrawals) {
      alerts.push({ level: "high", type: "large_withdrawal", message: `大额提现待审核: ${w.amount} ${w.asset}，用户ID: ${w.userId}`, data: w });
    }
    // Users with negative available balance (data anomaly)
    const negativeBalances = await db
      .select()
      .from(assetAccounts)
      .where(sql`CAST(${assetAccounts.available} AS DECIMAL(36,18)) < 0`)
      .limit(20);
    for (const b of negativeBalances) {
      alerts.push({ level: "critical", type: "negative_balance", message: `余额异常(负数): 用户${b.userId} ${b.asset} 可用=${b.available}`, data: b });
    }
    // Pending withdrawals count
    const [pendingRow] = await db.select({ c: count() }).from(withdrawalsTable).where(eq(withdrawalsTable.status, "pending"));
    if ((pendingRow?.c ?? 0) > 10) {
      alerts.push({ level: "medium", type: "many_pending_withdrawals", message: `待审核提现数量较多: ${pendingRow?.c} 条`, data: { count: pendingRow?.c } });
    }
    return alerts;
  }),

  /* ------------------------------------------------------------------ */
  /* 15. Admin action logs                                               */
  /* ------------------------------------------------------------------ */
  getAdminLogs: adminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(50),
        action: z.string().optional(),
        adminId: z.number().int().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { rows: [], total: 0 };
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 50;
      const offset = (page - 1) * pageSize;
      const conditions = [];
      if (input?.action) conditions.push(eq(adminActionLogs.action, input.action));
      if (input?.adminId) conditions.push(eq(adminActionLogs.adminId, input.adminId));
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const [rows, totalRow] = await Promise.all([
        db.select().from(adminActionLogs).where(where).orderBy(desc(adminActionLogs.createdAt)).limit(pageSize).offset(offset),
        db.select({ c: count() }).from(adminActionLogs).where(where),
      ]);
      return { rows, total: totalRow[0]?.c ?? 0 };
    }),

  /* ------------------------------------------------------------------ */
  /* 16. All trades (with fee breakdown)                                 */
  /* ------------------------------------------------------------------ */
  listAllTrades: adminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(50),
        symbol: z.string().optional(),
        userId: z.number().int().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { rows: [], total: 0 };
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 50;
      const offset = (page - 1) * pageSize;
      const conditions = [];
      if (input?.symbol) conditions.push(eq(tradesTable.symbol, input.symbol));
      if (input?.userId) conditions.push(or(eq(tradesTable.buyerUserId, input.userId), eq(tradesTable.sellerUserId, input.userId)));
      if (input?.dateFrom) conditions.push(gte(tradesTable.createdAt, new Date(input.dateFrom)));
      if (input?.dateTo) conditions.push(lte(tradesTable.createdAt, new Date(input.dateTo)));
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const [rows, totalRow] = await Promise.all([
        db.select().from(tradesTable).where(where).orderBy(desc(tradesTable.createdAt)).limit(pageSize).offset(offset),
        db.select({ c: count() }).from(tradesTable).where(where),
      ]);
      return { rows, total: totalRow[0]?.c ?? 0 };
    }),

  /* ------------------------------------------------------------------ */
  /* 17. Deposit stats                                                   */
  /* ------------------------------------------------------------------ */
  depositStats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select({
        chain: depositsTable.chain,
        status: depositsTable.status,
        count: count(),
        totalAmount: sum(depositsTable.amount),
      })
      .from(depositsTable)
      .groupBy(depositsTable.chain, depositsTable.status);
  }),

  /* ------------------------------------------------------------------ */
  /* 18. Withdrawal stats                                                */
  /* ------------------------------------------------------------------ */
  withdrawalStats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select({
        chain: withdrawalsTable.chain,
        status: withdrawalsTable.status,
        count: count(),
        totalAmount: sum(withdrawalsTable.amount),
      })
      .from(withdrawalsTable)
      .groupBy(withdrawalsTable.chain, withdrawalsTable.status);
  }),

  /* ------------------------------------------------------------------ */
  /* 19. Balance consistency check                                       */
  /* ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ */
  /* 20. Trades by order ID (for order expand row)                       */
  /* ------------------------------------------------------------------ */
  getTradesByOrder: adminProcedure
    .input(z.object({ orderId: z.number().int() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(tradesTable)
        .where(
          or(
            eq(tradesTable.buyerOrderId, input.orderId),
            eq(tradesTable.sellerOrderId, input.orderId)
          )
        )
        .orderBy(desc(tradesTable.createdAt))
        .limit(50);
    }),

  /* ------------------------------------------------------------------ */
  /* 21. Bulk ban/unban users                                            */
  /* ------------------------------------------------------------------ */
  bulkBanUsers: adminProcedure
    .input(
      z.object({
        userIds: z.array(z.number().int()).min(1).max(100),
        ban: z.boolean(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const results: { userId: number; ok: boolean; error?: string }[] = [];
      for (const userId of input.userIds) {
        try {
          const [before] = await db.select({ isBanned: users.isBanned }).from(users).where(eq(users.id, userId)).limit(1);
          if (!before) { results.push({ userId, ok: false, error: "用户不存在" }); continue; }
          await db.update(users).set({
            isBanned: input.ban,
            banReason: input.ban ? (input.reason ?? "批量封禁") : null,
          }).where(eq(users.id, userId));
          await auditLog(ctx.user.id, ctx.user.name, input.ban ? "ban_user" : "unban_user", "user", String(userId), { isBanned: before.isBanned }, { isBanned: input.ban }, input.reason);
          results.push({ userId, ok: true });
        } catch (e: any) {
          results.push({ userId, ok: false, error: e.message });
        }
      }
      return { results };
    }),

  /* ------------------------------------------------------------------ */
  /* 22. User ledger entries (for user detail drawer)                    */
  /* ------------------------------------------------------------------ */
  getUserLedger: adminProcedure
    .input(z.object({ userId: z.number().int(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, input.userId))
        .orderBy(desc(ledgerEntries.createdAt))
        .limit(input.limit);
    }),

  balanceConsistencyCheck: adminProcedure
    .input(z.object({ userId: z.number().int() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Get current balances
      const balances = await db.select().from(assetAccounts).where(eq(assetAccounts.userId, input.userId));
      // Sum ledger entries per asset
      const ledgerSums = await db
        .select({
          asset: ledgerEntries.asset,
          sumDelta: sum(ledgerEntries.delta),
          sumLocked: sum(ledgerEntries.lockedDelta),
        })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, input.userId))
        .groupBy(ledgerEntries.asset);
      const ledgerMap = new Map(ledgerSums.map((r) => [r.asset, r]));
      return balances.map((b) => {
        const ledger = ledgerMap.get(b.asset);
        const ledgerAvailable = Number(ledger?.sumDelta ?? 0);
        const ledgerLocked = Number(ledger?.sumLocked ?? 0);
        const actualAvailable = Number(b.available);
        const actualLocked = Number(b.locked);
        const availableDiff = Math.abs(actualAvailable - ledgerAvailable);
        const lockedDiff = Math.abs(actualLocked - ledgerLocked);
        return {
          asset: b.asset,
          actualAvailable: b.available,
          actualLocked: b.locked,
          ledgerAvailable: String(ledgerAvailable),
          ledgerLocked: String(ledgerLocked),
          availableMatch: availableDiff < 0.000001,
          lockedMatch: lockedDiff < 0.000001,
          availableDiff: String(availableDiff),
          lockedDiff: String(lockedDiff),
        };
      });
    }),

  /* ------------------------------------------------------------------ */
  /* 22. Bulk review withdrawals                                          */
  /* ------------------------------------------------------------------ */
  bulkReviewWithdrawals: adminProcedure
    .input(
      z.object({
        ids: z.array(z.number().int()).min(1).max(50),
        action: z.enum(["approve", "reject"]),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const results: { id: number; success: boolean; error?: string }[] = [];
      for (const id of input.ids) {
        try {
          if (input.action === "approve") {
            await approveWithdrawal(id);
          } else {
            await rejectWithdrawal(id, input.reason ?? "管理员驳回");
          }
          await auditLog(
            ctx.user.id,
            ctx.user.name,
            `bulk_${input.action}_withdrawal`,
            "withdrawal",
            String(id),
            { status: "pending" },
            { status: input.action === "approve" ? "approved" : "rejected" },
            input.reason
          );
          results.push({ id, success: true });
        } catch (e: unknown) {
          results.push({ id, success: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { results, successCount: results.filter((r) => r.success).length };
    }),
});
