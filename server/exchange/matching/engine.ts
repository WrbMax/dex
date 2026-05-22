/**
 * MatchingEngine — per-symbol in-memory engines, strict FIFO order processing,
 * synchronous settlement through the ledger, and persistent writes for orders
 * and trades.
 *
 * Throughput target: 1,000 TPS. Because each market has its own engine, a
 * multi-symbol workload naturally parallelizes at the OS scheduler level.
 */

import { and, eq, or, sql as drizzleSql } from "drizzle-orm";
import { EventEmitter } from "node:events";
import { getDb } from "../../db";
import { orders as ordersTable, trades as tradesTable, markets as marketsTable, assetAccounts, type Market } from "../../../drizzle/schema";
import { applyLedgerChanges, type LedgerReason } from "../accounts/ledger";
import { formatDec, mul, parseDec, ZERO } from "../utils/bigdec";
import { OrderBook, type Fill } from "./orderbook";
import { allMarketsCached, ensureMarketsLoaded, getMarket } from "../markets/registry";
import { transformReferencePrice } from "../marketdata/market_config";
import { createNotification } from "../notifications/service";

export type SubmitOrderInput = {
  userId: number;
  subAccountId: number;
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price?: string; // required when type=limit
  quantity: string; // base asset quantity
  source?: "web" | "api";
  clientOrderId?: string;
};

export type EngineEvent =
  | { type: "order_new"; order: any }
  | { type: "order_update"; order: any }
  | { type: "trade"; trade: any; symbol: string };

class SymbolEngine {
  readonly symbol: string;
  readonly market: Market;
  readonly book: OrderBook;
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  // FIX H001: Prevent duplicate onTicker tasks for the same order.
  // Binance WS pushes tickers for all 30 symbols nearly simultaneously,
  // causing onTicker to enqueue the same resting order many times per second.
  // Each task takes ~500ms, so many queued tasks cause submitOrder to time out.
  readonly pendingOrderIds = new Set<number>();

  constructor(market: Market) {
    this.symbol = market.symbol;
    this.market = market;
    this.book = new OrderBook(market.symbol);
  }

  submit(task: () => Promise<void>) {
    this.queue.push(task);
    void this.drain();
  }

  // Submit a deduplicated onTicker task for a specific order.
  // If a task for this orderId is already queued or processing, skip it.
  submitOnTicker(orderId: number, task: () => Promise<void>) {
    if (this.pendingOrderIds.has(orderId)) return;
    this.pendingOrderIds.add(orderId);
    this.queue.push(async () => {
      try {
        await task();
      } finally {
        this.pendingOrderIds.delete(orderId);
      }
    });
    void this.drain();
  }

  private async drain() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const t = this.queue.shift()!;
        try {
          await t();
        } catch (err) {
          console.error(`[engine:${this.symbol}] task error:`, err);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

class MatchingEngine extends EventEmitter {
  private engines = new Map<string, SymbolEngine>();
  private lastPrices = new Map<string, bigint>();
  // FIX H003: Prevent concurrent onTicker executions for the same symbol.
  // Binance pushes ~1 ticker/sec per symbol; each onTicker does a DB query
  // (~266ms). Without this guard, multiple concurrent onTicker calls for the
  // same symbol pile up Promise microtasks, saturating the V8 microtask queue
  // and blocking the event loop (100% CPU, HTTP timeouts).
  private onTickerProcessing = new Set<string>();
  /**
   * Fetch a fresh Binance best bid/ask for immediate platform-liquidity fills.
   *
   * Market orders must be priced from the current executable book ticker instead
   * of the in-memory lastPrices cache. The cache is still useful for UI/ticker
   * triggered limit-order checks, but it can be stale when the WebSocket stream
   * reconnects or lags. For order execution, freshness is more important than
   * cache hit ratio; if the live quote is unavailable, the caller must cancel
   * and release the frozen funds rather than filling at an old price.
   */
  private async fetchFreshBookTickerPrice(symbol: string, side: "buy" | "sell"): Promise<bigint | null> {
    try {
      const market = getMarket(symbol);
      const upstreamSymbol = (market?.externalSymbol || symbol).toUpperCase();
      const binanceRes = await fetch(
        `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${upstreamSymbol}`,
        { signal: AbortSignal.timeout(3000) }
      );
      if (!binanceRes.ok) return null;
      const bt = await binanceRes.json() as { bidPrice?: string; askPrice?: string };
      const raw = side === "buy" ? bt.askPrice : bt.bidPrice;
      if (!raw) return null;
      const transformed = transformReferencePrice(raw, market);
      const parsed = parseDec(transformed);
      return parsed > ZERO ? parsed : null;
    } catch {
      return null;
    }
  }

  private async releaseRemainingOrderFunds(params: {
    order: typeof ordersTable.$inferSelect;
    market: Market;
    orderId: number;
    remaining: bigint;
    reason?: LedgerReason;
  }) {
    const { order, market, orderId, remaining } = params;
    if (remaining <= ZERO) return;

    if (order.side === "buy") {
      const takerFeeRate = parseDec(market.takerFee);
      const principal = mul(parseDec(order.price!), remaining);
      const feeBuffer = mul(principal, takerFeeRate);
      const totalRelease = principal + feeBuffer;
      await applyLedgerChanges([{
        userId: order.userId,
        subAccountId: order.subAccountId,
        asset: market.quote,
        delta: totalRelease,
        lockedDelta: -totalRelease,
        reason: params.reason ?? "order_unfreeze",
        refTable: "orders",
        refId: orderId,
      }]);
    } else {
      await applyLedgerChanges([{
        userId: order.userId,
        subAccountId: order.subAccountId,
        asset: market.base,
        delta: remaining,
        lockedDelta: -remaining,
        reason: params.reason ?? "order_unfreeze",
        refTable: "orders",
        refId: orderId,
      }]);
    }
  }


  async init() {
    const markets = await ensureMarketsLoaded();
    for (const m of markets) this.engines.set(m.symbol, new SymbolEngine(m));
    await this.loadRestingOrders();
    console.log(`[engine] ready for ${this.engines.size} symbols`);
  }

  private async loadRestingOrders() {
    const db = await getDb();
    if (!db) return;
    const open = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.status, "new"));
    const partial = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.status, "partial"));
    const groups = new Map<string, typeof open>();
    for (const o of [...open, ...partial]) {
      if (!groups.has(o.symbol)) groups.set(o.symbol, [] as any);
      groups.get(o.symbol)!.push(o);
    }
    for (const [symbol, rows] of groups.entries()) {
      const eng = this.engines.get(symbol);
      if (!eng) continue;

      // Cancel any stuck market orders (market orders must never rest in the book).
      // Historical market-buy rows may store `quantity` as quote-spend and `filledQty` as base-filled;
      // therefore `quantity - filledQty` mixes USDT and BTC units and can over-unfreeze locked quote,
      // preventing the service from starting.  Compute the remaining frozen amount in the correct asset
      // and cap the release by the actual account locked balance so one bad legacy row cannot block boot.
      const stuckMarketOrders = rows.filter((r) => r.type === "market");
      for (const o of stuckMarketOrders) {
        const market = getMarket(o.symbol);
        if (!market) continue;

        const releaseLocked = async (asset: string, desired: bigint) => {
          if (desired <= 0n) return;
          const [account] = await db
            .select({ locked: assetAccounts.locked })
            .from(assetAccounts)
            .where(and(eq(assetAccounts.subAccountId, o.subAccountId), eq(assetAccounts.asset, asset)))
            .limit(1);
          const locked = parseDec(account?.locked ?? "0");
          const release = desired > locked ? locked : desired;
          if (release <= 0n) {
            console.warn(`[engine] stuck market order ${o.id} has no locked ${asset} to release`);
            return;
          }
          if (release < desired) {
            console.warn(`[engine] stuck market order ${o.id} release capped for ${asset}: desired=${formatDec(desired)}, locked=${formatDec(locked)}`);
          }
          await applyLedgerChanges([
            {
              userId: o.userId,
              subAccountId: o.subAccountId,
              asset,
              delta: release,
              lockedDelta: -release,
              reason: "order_unfreeze",
              refTable: "orders",
              refId: o.id,
            },
          ]);
        };

        if (o.side === "buy") {
          const orderQuote = parseDec(o.quantity);
          const quoteFilled = parseDec(o.quoteFilled ?? "0");
          const takerFeeRate = parseDec(market.takerFee);
          const originallyFrozen = orderQuote + mul(orderQuote, takerFeeRate);
          const consumed = quoteFilled + mul(quoteFilled, takerFeeRate);
          const remainingQuoteLocked = originallyFrozen > consumed ? originallyFrozen - consumed : ZERO;
          await releaseLocked(market.quote, remainingQuoteLocked);
        } else {
          const remainingBase = parseDec(o.quantity) - parseDec(o.filledQty);
          await releaseLocked(market.base, remainingBase > 0n ? remainingBase : ZERO);
        }

        await db
          .update(ordersTable)
          .set({ status: "canceled" })
          .where(eq(ordersTable.id, o.id));
        console.log(`[engine] Cancelled stuck market order ${o.id} on restart`);
      }

      const currentMarket = getMarket(symbol);
      if ((currentMarket?.marketMode ?? "binance_mirror") !== "orderbook") {
        console.log(`[engine] skipped in-memory order book load for ${symbol}: marketMode=${currentMarket?.marketMode ?? "binance_mirror"}`);
        continue;
      }

      eng.book.load(
        rows
          .filter((r) => r.type === "limit" && r.price)
          .map((r) => ({
            id: r.id,
            userId: r.userId,
            subAccountId: r.subAccountId,
            side: r.side as "buy" | "sell",
            price: parseDec(r.price as string),
            remaining: parseDec(r.quantity) - parseDec(r.filledQty),
            type: "limit" as const,
          }))
      );
    }
  }

  getLastPrice(symbol: string): string | null {
    const p = this.lastPrices.get(symbol);
    return p ? formatDec(p) : null;
  }

  depth(symbol: string, depth = 20) {
    const eng = this.engines.get(symbol);
    if (!eng) return { bids: [] as [string, string][], asks: [] as [string, string][] };
    const raw = eng.book.depth(depth);
    return {
      bids: raw.bids.map(([p, q]) => [formatDec(BigInt(p)), formatDec(BigInt(q))] as [string, string]),
      asks: raw.asks.map(([p, q]) => [formatDec(BigInt(p)), formatDec(BigInt(q))] as [string, string]),
    };
  }

  markets(): string[] {
    return Array.from(this.engines.keys());
  }

  /**
   * Place an order. Validates market/amount/price against tick sizes, freezes
   * balance, matches and settles through the ledger, writes order & trades
   * to the DB, and returns the persisted order row.
   */
  async submitOrder(input: SubmitOrderInput) {
    if (input.side !== "buy" && input.side !== "sell") throw new Error("订单方向非法");
    if (input.type !== "limit" && input.type !== "market") throw new Error("订单类型非法");
    if (input.clientOrderId != null && input.clientOrderId.length > 64) throw new Error("clientOrderId 长度不能超过 64 个字符");

    const market = getMarket(input.symbol);
    if (!market) throw new Error(`未知交易对 ${input.symbol}`);
    if (!market.isActive) throw new Error(`交易对 ${input.symbol} 已下架或暂停交易`);
    if (market.allowRealTrade === false) throw new Error(`交易对 ${input.symbol} 当前仅展示行情，暂不允许真实成交`);
    if (input.type === "market" && market.allowMarketOrder === false) {
      throw new Error(`交易对 ${input.symbol} 暂不支持市价单`);
    }
    if (input.type === "limit" && market.allowLimitOrder === false) {
      throw new Error(`交易对 ${input.symbol} 暂不支持限价单`);
    }
    const eng = this.engines.get(input.symbol);
    if (!eng) throw new Error("撮合引擎未初始化");

    const qty = parseDec(input.quantity);
    if (qty <= 0n) throw new Error("数量必须大于 0");
    const priceTick = parseDec(market.priceTick);
    const amountStep = parseDec(market.amountStep);
    // For market buy orders, qty is the quote-asset total cost cap entered by the user.
    // Example: entering 1000 USDT means principal + taker fee must be <= 1000 USDT.
    const isMarketBuy = input.type === "market" && input.side === "buy";
    if (!isMarketBuy && amountStep > 0n && qty % amountStep !== 0n) {
      const stepDisplay = parseFloat(market.amountStep).toString();
      throw new Error(`数量精度错误：数量必须是 ${stepDisplay} 的整数倍`);
    }

    let price = 0n;
    if (input.type === "limit") {
      if (!input.price) throw new Error("限价单必须填写价格");
      price = parseDec(input.price);
      if (price <= 0n) throw new Error("价格必须大于 0");
      if (priceTick > 0n && price % priceTick !== 0n) {
        // Format priceTick cleanly (remove trailing zeros)
        const tickDisplay = parseFloat(market.priceTick).toString();
        throw new Error(`价格精度错误：价格必须是 ${tickDisplay} 的整数倍`);
      }
      const notional = mul(price, qty);
      if (notional < parseDec(market.minNotional)) {
        const minDisplay = parseFloat(market.minNotional).toString();
        throw new Error(`最小下单额为 ${minDisplay} ${market.quote}，请增加价格或数量`);
      }
    }

    const base = market.base;
    const quote = market.quote;
    const takerFeeRate = parseDec(market.takerFee);
    const orderNotional = input.type === "limit" ? mul(price, qty) : qty;
    const quoteFeeInclusiveBudget = isMarketBuy ? qty : ZERO;
    const quotePrincipalBudget = isMarketBuy
      ? (quoteFeeInclusiveBudget * 10n ** 18n) / (10n ** 18n + takerFeeRate)
      : ZERO;
    const freezeAsset = input.side === "buy" ? quote : base;
    const requiredFreeze = input.side === "buy"
      ? (isMarketBuy ? quoteFeeInclusiveBudget : orderNotional + mul(orderNotional, takerFeeRate))
      : qty;

    const db = await getDb();
    if (!db) throw new Error("数据库连接失败，请稍后重试");

    // P0 idempotency guard: for API clients, clientOrderId is the user's replay
    // key.  A retry with the same key must not create a second order, freeze
    // funds again, or produce duplicate fills.  This check is deliberately before
    // any ledger mutation.  The schema also defines a user-scoped unique index to
    // close the concurrent retry window at the database layer.
    if (input.clientOrderId) {
      const [existingOrder] = await db
        .select()
        .from(ordersTable)
        .where(and(eq(ordersTable.userId, input.userId), eq(ordersTable.clientOrderId, input.clientOrderId)))
        .limit(1);
      if (existingOrder) {
        return { order: existingOrder, fills: [] };
      }
    }

    // P0 correctness fix: insert the order first, then freeze funds through the
    // centralized LedgerEngine with refId = orderId.  The previous path built a
    // multi-statement SQL string and patched ledger refId afterwards, which was
    // incompatible with `multipleStatements: false` and made concurrent order
    // freezes hard to audit.  If freezing fails, the just-created order is marked
    // canceled and no ledger row is written.
    let orderId: number;
    let insertRes: unknown;
    try {
      insertRes = await db.insert(ordersTable).values({
        clientOrderId: input.clientOrderId ?? null,
        userId: input.userId,
        subAccountId: input.subAccountId,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        price: input.type === "limit" ? input.price! : null,
        quantity: input.quantity,
        filledQty: "0",
        quoteFilled: "0",
        avgPrice: "0",
        status: "new",
        source: input.source ?? "web",
      });
    } catch (err) {
      if (input.clientOrderId) {
        const [existingOrder] = await db
          .select()
          .from(ordersTable)
          .where(and(eq(ordersTable.userId, input.userId), eq(ordersTable.clientOrderId, input.clientOrderId)))
          .limit(1);
        if (existingOrder) return { order: existingOrder, fills: [] };
      }
      throw err;
    }
    orderId = Number((insertRes as { insertId: number }).insertId ?? (insertRes as [{ insertId: number }])[0]?.insertId);
    if (!orderId) throw new Error("订单插入失败");

    try {
      await applyLedgerChanges([
        {
          userId: input.userId,
          subAccountId: input.subAccountId,
          asset: freezeAsset,
          delta: -requiredFreeze,
          lockedDelta: requiredFreeze,
          reason: "order_freeze",
          refTable: "orders",
          refId: orderId,
        },
      ]);
    } catch (err) {
      await db.update(ordersTable).set({ status: "canceled" }).where(eq(ordersTable.id, orderId));
      throw err;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODE SPLIT: binance_mirror and orderbook are intentionally separate paths.
    //
    //  binance_mirror — Platform-counterparty automatic market making. Orders
    //                   never inspect, submit to, or consume the internal OrderBook.
    //                   If the platform executable quote satisfies the order, the
    //                   counterparty is platform userId=0; otherwise a limit order
    //                   stays open in the database for future platform quote checks.
    //
    //  orderbook      — Pure internal peer-to-peer order-book matching. Orders may
    //                   submit to the in-memory OrderBook and match only against
    //                   other resident user orders. External ticker events never
    //                   platform-fill these orders.
    // ─────────────────────────────────────────────────────────────────────────
    const marketMode = market.marketMode ?? "binance_mirror";

    if (marketMode === "binance_mirror") {
      // ── BINANCE_MIRROR AUTO MARKET-MAKING PATH ───────────────────────────────
      // Execute only against platform liquidity; do not touch the internal book.
      try {
        // Re-check: onTicker may have already filled this order in the tiny window
        // between DB insert and here.
        const [freshCheck] = await db.select({ status: ordersTable.status })
          .from(ordersTable).where(eq(ordersTable.id, orderId));
        if (freshCheck && (freshCheck.status === "filled" || freshCheck.status === "canceled")) {
          const [filledRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
          return { order: filledRow!, fills: [] };
        }

        // Synchronous platform-counterparty matching returns the real order status.
        // AMM/binance_mirror market orders must not consume user resting orders.
        // They are platform-liquidity fills, with platform counterparty recorded as userId=0.
        // For market buy: qty is the fee-inclusive USDT total cost cap; convert the principal budget to base using platform reference ask.
        let bookQty = qty;
        if (isMarketBuy) {
          const bestAskPrice = await this.fetchFreshBookTickerPrice(input.symbol, "buy");
          if (!bestAskPrice || bestAskPrice === ZERO) {
            // No platform reference price; cancel immediately and release frozen quote.
            await db.update(ordersTable).set({ status: "canceled" }).where(eq(ordersTable.id, orderId));
            await applyLedgerChanges([{ userId: input.userId, subAccountId: input.subAccountId, asset: quote, delta: quoteFeeInclusiveBudget, lockedDelta: -quoteFeeInclusiveBudget, reason: "order_unfreeze", refTable: "orders", refId: orderId }]);
            const [canceledRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
            return { order: canceledRow!, fills: [] };
          }
          bookQty = (quotePrincipalBudget * 10n ** 18n) / bestAskPrice;
          if (amountStep > 0n && bookQty > 0n) {
            bookQty = (bookQty / amountStep) * amountStep;
          }
          if (bookQty <= 0n) {
            await db.update(ordersTable).set({ status: "canceled" }).where(eq(ordersTable.id, orderId));
            await applyLedgerChanges([{ userId: input.userId, subAccountId: input.subAccountId, asset: quote, delta: quoteFeeInclusiveBudget, lockedDelta: -quoteFeeInclusiveBudget, reason: "order_unfreeze", refTable: "orders", refId: orderId }]);
            const [canceledRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
            return { order: canceledRow!, fills: [] };
          }

          const quoteFilled = mul(bestAskPrice, bookQty);
          const takerFee = mul(quoteFilled, takerFeeRate);
          const consumedQuote = quoteFilled + takerFee;
          await applyLedgerChanges([
            { userId: input.userId, subAccountId: input.subAccountId, asset: quote, delta: 0n, lockedDelta: -consumedQuote, reason: "trade_fill", refTable: "orders", refId: orderId },
            { userId: input.userId, subAccountId: input.subAccountId, asset: base, delta: bookQty, lockedDelta: 0n, reason: "trade_fill", refTable: "orders", refId: orderId },
          ]);
          const unusedQuote = quoteFeeInclusiveBudget > consumedQuote ? quoteFeeInclusiveBudget - consumedQuote : ZERO;
          if (unusedQuote > 0n) {
            await applyLedgerChanges([{ userId: input.userId, subAccountId: input.subAccountId, asset: quote, delta: unusedQuote, lockedDelta: -unusedQuote, reason: "order_unfreeze", refTable: "orders", refId: orderId }]);
          }
          await db.insert(tradesTable).values({ symbol: input.symbol, price: formatDec(bestAskPrice), quantity: formatDec(bookQty), quoteQty: formatDec(quoteFilled), buyerOrderId: orderId, sellerOrderId: 0, buyerUserId: input.userId, sellerUserId: 0, buyerIsMaker: false, buyerFee: formatDec(takerFee), sellerFee: "0" });
          const avgPrice = (quoteFilled * 10n ** 18n) / bookQty;
          await db.update(ordersTable).set({ filledQty: formatDec(bookQty), quoteFilled: formatDec(quoteFilled), avgPrice: formatDec(avgPrice), status: "filled" }).where(eq(ordersTable.id, orderId));
          this.lastPrices.set(input.symbol, bestAskPrice);
          this.emit("order_update", { orderId, status: "filled", filledQty: bookQty, quoteFilled });
          this.emit("trade", { symbol: input.symbol, price: formatDec(bestAskPrice), quantity: formatDec(bookQty), quoteQty: formatDec(quoteFilled), timestamp: Date.now(), side: "buy" });
          void createNotification({ userId: input.userId, type: "order_filled", title: `买入 ${input.symbol} 成交`, body: `市价买入 ${formatDec(bookQty)} ${base}，成交价 ${formatDec(bestAskPrice)} ${quote}，手续费 ${formatDec(takerFee)} ${quote}`, refTable: "orders", refId: orderId });
          const [filledRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
          return { order: filledRow!, fills: [] };
        }

        // For market sell: AMM/binance_mirror uses platform liquidity directly.
        const isMarketSell = input.type === "market" && input.side === "sell";
        if (isMarketSell) {
          const bestBidPrice = await this.fetchFreshBookTickerPrice(input.symbol, "sell");
          if (!bestBidPrice || bestBidPrice === ZERO) {
            await db.update(ordersTable).set({ status: "canceled" }).where(eq(ordersTable.id, orderId));
            await applyLedgerChanges([{ userId: input.userId, subAccountId: input.subAccountId, asset: base, delta: bookQty, lockedDelta: -bookQty, reason: "order_unfreeze", refTable: "orders", refId: orderId }]);
            const [canceledRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
            return { order: canceledRow!, fills: [] };
          }
          const quoteFilled = mul(bestBidPrice, bookQty);
          const takerFee = mul(quoteFilled, takerFeeRate);
          const quoteNet = quoteFilled - takerFee;
          await applyLedgerChanges([
            { userId: input.userId, subAccountId: input.subAccountId, asset: base, delta: 0n, lockedDelta: -bookQty, reason: "trade_fill", refTable: "orders", refId: orderId },
            { userId: input.userId, subAccountId: input.subAccountId, asset: quote, delta: quoteNet, lockedDelta: 0n, reason: "trade_fill", refTable: "orders", refId: orderId },
          ]);
          await db.insert(tradesTable).values({ symbol: input.symbol, price: formatDec(bestBidPrice), quantity: formatDec(bookQty), quoteQty: formatDec(quoteFilled), buyerOrderId: 0, sellerOrderId: orderId, buyerUserId: 0, sellerUserId: input.userId, buyerIsMaker: true, buyerFee: "0", sellerFee: formatDec(takerFee) });
          const avgPrice = (quoteFilled * 10n ** 18n) / bookQty;
          await db.update(ordersTable).set({ filledQty: formatDec(bookQty), quoteFilled: formatDec(quoteFilled), avgPrice: formatDec(avgPrice), status: "filled" }).where(eq(ordersTable.id, orderId));
          this.lastPrices.set(input.symbol, bestBidPrice);
          this.emit("order_update", { orderId, status: "filled", filledQty: bookQty, quoteFilled });
          this.emit("trade", { symbol: input.symbol, price: formatDec(bestBidPrice), quantity: formatDec(bookQty), quoteQty: formatDec(quoteFilled), timestamp: Date.now(), side: "sell" });
          void createNotification({ userId: input.userId, type: "order_filled", title: `卖出 ${input.symbol} 成交`, body: `市价卖出 ${formatDec(bookQty)} ${base}，成交价 ${formatDec(bestBidPrice)} ${quote}，手续费 ${formatDec(mul(quoteFilled, takerFeeRate))} ${quote}`, refTable: "orders", refId: orderId });
          const [filledRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
          return { order: filledRow!, fills: [] };
        }

        // ── AUTO MARKET-MAKING LIMIT PATH ────────────────────────────────────────
        // binance_mirror is platform-counterparty trading only. Limit orders in this
        // mode must never be submitted to the internal OrderBook. If the current
        // executable platform quote satisfies the user's limit price, fill directly
        // against platform userId=0; otherwise keep the order open in the database
        // and let onTicker re-check the platform quote later.
        if (input.type === "limit") {
          const platformFillPrice = await this.fetchFreshBookTickerPrice(input.symbol, input.side);
          const executable = platformFillPrice !== null && platformFillPrice > ZERO && (
            input.side === "buy" ? platformFillPrice <= price : platformFillPrice >= price
          );

          if (executable) {
            const limitQuoteFilled = mul(platformFillPrice, qty);
            const takerFee = mul(limitQuoteFilled, takerFeeRate);
            if (input.side === "buy") {
              const consumedQuote = limitQuoteFilled + takerFee;
              await applyLedgerChanges([
                { userId: input.userId, subAccountId: input.subAccountId, asset: quote, delta: 0n, lockedDelta: -consumedQuote, reason: "trade_fill", refTable: "orders", refId: orderId },
                { userId: input.userId, subAccountId: input.subAccountId, asset: base, delta: qty, lockedDelta: 0n, reason: "trade_fill", refTable: "orders", refId: orderId },
              ]);
              const unusedQuote = requiredFreeze > consumedQuote ? requiredFreeze - consumedQuote : ZERO;
              if (unusedQuote > ZERO) {
                await applyLedgerChanges([{ userId: input.userId, subAccountId: input.subAccountId, asset: quote, delta: unusedQuote, lockedDelta: -unusedQuote, reason: "order_unfreeze", refTable: "orders", refId: orderId }]);
              }
              await db.insert(tradesTable).values({ symbol: input.symbol, price: formatDec(platformFillPrice), quantity: formatDec(qty), quoteQty: formatDec(limitQuoteFilled), buyerOrderId: orderId, sellerOrderId: 0, buyerUserId: input.userId, sellerUserId: 0, buyerIsMaker: false, buyerFee: formatDec(takerFee), sellerFee: "0" });
            } else {
              const quoteNet = limitQuoteFilled - takerFee;
              await applyLedgerChanges([
                { userId: input.userId, subAccountId: input.subAccountId, asset: base, delta: 0n, lockedDelta: -qty, reason: "trade_fill", refTable: "orders", refId: orderId },
                { userId: input.userId, subAccountId: input.subAccountId, asset: quote, delta: quoteNet, lockedDelta: 0n, reason: "trade_fill", refTable: "orders", refId: orderId },
              ]);
              await db.insert(tradesTable).values({ symbol: input.symbol, price: formatDec(platformFillPrice), quantity: formatDec(qty), quoteQty: formatDec(limitQuoteFilled), buyerOrderId: 0, sellerOrderId: orderId, buyerUserId: 0, sellerUserId: input.userId, buyerIsMaker: true, buyerFee: "0", sellerFee: formatDec(takerFee) });
            }

            const avgPrice = (limitQuoteFilled * 10n ** 18n) / qty;
            await db.update(ordersTable).set({ filledQty: formatDec(qty), quoteFilled: formatDec(limitQuoteFilled), avgPrice: formatDec(avgPrice), status: "filled" }).where(eq(ordersTable.id, orderId));
            this.lastPrices.set(input.symbol, platformFillPrice);
            this.emit("order_update", { orderId, status: "filled", filledQty: qty, quoteFilled: limitQuoteFilled });
            this.emit("trade", { symbol: input.symbol, price: formatDec(platformFillPrice), quantity: formatDec(qty), quoteQty: formatDec(limitQuoteFilled), timestamp: Date.now(), side: input.side });
            void createNotification({ userId: input.userId, type: "order_filled", title: `限价${input.side === "buy" ? "买入" : "卖出"} ${input.symbol} 成交`, body: `平台报价满足条件，限价单以 ${formatDec(platformFillPrice)} ${quote} 成交 ${formatDec(qty)} ${base}，手续费 ${formatDec(takerFee)} ${quote}`, refTable: "orders", refId: orderId });
            const [filledRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
            return { order: filledRow!, fills: [] };
          }

          const [restingRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
          this.emit("order_update", { orderId, status: "new", filledQty: ZERO, quoteFilled: ZERO });
          return { order: restingRow!, fills: [] };
        }

        const [restingRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
        return { order: restingRow!, fills: [] };

      } catch (e) {
        console.error(`[engine:submitOrder:binance_mirror] matching error for order ${orderId}:`, e);
        // Return whatever is in DB
        const [errRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
        return { order: errRow ?? { id: orderId, status: "new" } as any, fills: [] };
      }
    }

    // ── ORDERBOOK PATH: Fire-and-forget — return status='new' immediately ─────
    // Pure peer-to-peer matching. The order rests in the internal book until a
    // real user counterparty arrives through another submitOrder call.
    eng.submit(async () => {
      try {
        // Re-check: order may have been canceled between insert and queue drain.
        const [freshCheck] = await db.select({ status: ordersTable.status })
          .from(ordersTable).where(eq(ordersTable.id, orderId));
        if (!freshCheck || (freshCheck.status !== "new" && freshCheck.status !== "partial")) return;

        const bookQtyInternal = qty;
        const { fills, remaining } = eng.book.submit({
          id: orderId,
          userId: input.userId,
          subAccountId: input.subAccountId,
          side: input.side,
          type: input.type,
          price,
          quantity: bookQtyInternal,
        });
        // Self-trade protection
        const selfFills = fills.filter(f => f.makerUserId === input.userId);
        for (const sf of selfFills) {
          const resident = eng.book.cancel(sf.makerOrderId);
          const [makerRow] = await db.select().from(ordersTable).where(eq(ordersTable.id, sf.makerOrderId));
          if (!makerRow || (makerRow.status !== "new" && makerRow.status !== "partial")) continue;
          const makerRemaining = resident ? resident.remaining : parseDec(makerRow.quantity) - parseDec(makerRow.filledQty);
          await db.update(ordersTable).set({ status: "canceled" }).where(
            and(eq(ordersTable.id, sf.makerOrderId), or(eq(ordersTable.status, "new"), eq(ordersTable.status, "partial")))
          );
          await this.releaseRemainingOrderFunds({ order: makerRow, market, orderId: sf.makerOrderId, remaining: makerRemaining, reason: "order_unfreeze" });
        }
        const validFills = fills.filter(f => f.makerUserId !== input.userId);
        const filledQty = bookQtyInternal - remaining - selfFills.reduce((s, f) => s + f.quantity, ZERO);
        let quoteFilled = ZERO;
        let takerFeeForValidFills = ZERO;
        for (const f of validFills) {
          const fillQuote = mul(f.price, f.quantity);
          quoteFilled += fillQuote;
          takerFeeForValidFills += mul(fillQuote, takerFeeRate);
        }
        await this.settleFills(market, input, orderId, validFills);

        let status: "new" | "partial" | "filled" | "canceled" = "new";
        if (remaining === ZERO) status = "filled";
        else if (input.type === "market") status = filledQty > ZERO ? "filled" : "canceled";
        else if (filledQty > ZERO) status = "partial";
        const avgPrice = filledQty > ZERO ? (quoteFilled * 10n ** 18n) / filledQty : 0n;
        await db.update(ordersTable).set({ filledQty: formatDec(filledQty), quoteFilled: formatDec(quoteFilled), avgPrice: formatDec(avgPrice), status }).where(eq(ordersTable.id, orderId));
        if (input.type === "limit" && input.side === "buy" && filledQty > ZERO && price) {
          const limitPrincipalForFilled = mul(price, filledQty);
          const frozenForFilled = limitPrincipalForFilled + mul(limitPrincipalForFilled, takerFeeRate);
          const consumedForFilled = quoteFilled + takerFeeForValidFills;
          const priceImprovementRefund = frozenForFilled > consumedForFilled ? frozenForFilled - consumedForFilled : ZERO;
          if (priceImprovementRefund > ZERO) {
            await applyLedgerChanges([{ userId: input.userId, subAccountId: input.subAccountId, asset: market.quote, delta: priceImprovementRefund, lockedDelta: -priceImprovementRefund, reason: "order_unfreeze", refTable: "orders", refId: orderId }]);
          }
        }
        if (input.type === "market" && remaining > ZERO) {
          if (input.side === "buy") {
            const consumedWithFee = quoteFilled + takerFeeForValidFills;
            const unusedQuote = quoteFeeInclusiveBudget > consumedWithFee ? quoteFeeInclusiveBudget - consumedWithFee : ZERO;
            if (unusedQuote > 0n) await applyLedgerChanges([{ userId: input.userId, subAccountId: input.subAccountId, asset: market.quote, delta: unusedQuote, lockedDelta: -unusedQuote, reason: "order_unfreeze", refTable: "orders", refId: orderId }]);
          } else {
            await applyLedgerChanges([{ userId: input.userId, subAccountId: input.subAccountId, asset: market.base, delta: remaining, lockedDelta: -remaining, reason: "order_unfreeze", refTable: "orders", refId: orderId }]);
          }
        }
        if (fills.length > 0) this.lastPrices.set(input.symbol, fills[fills.length - 1].price);
        this.emit("order_update", { orderId, status, filledQty, quoteFilled });
      } catch (e) {
        console.error(`[engine:submitOrder:orderbook] matching error for order ${orderId}:`, e);
      }
    });

    // Return immediately with status='new' (matching is async)
    return {
      order: {
        id: orderId,
        clientOrderId: input.clientOrderId ?? null,
        userId: input.userId,
        subAccountId: input.subAccountId,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        price: input.type === "limit" ? input.price! : null,
        quantity: input.quantity,
        filledQty: "0",
        quoteFilled: "0",
        avgPrice: "0",
        status: "new" as const,
        source: (input.source ?? "web") as "web" | "api",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      fills: [],
    };
  }

  private async settleFills(
    market: Market,
    input: SubmitOrderInput,
    takerOrderId: number,
    fills: Fill[]
  ) {
    if (fills.length === 0) return;
    const db = await getDb();
    if (!db) return;

    const makerFeeRate = parseDec(market.makerFee);
    const takerFeeRate = parseDec(market.takerFee);

    for (const f of fills) {
      const quote = mul(f.price, f.quantity);
      const takerFee = mul(quote, takerFeeRate);
      const makerFee = mul(quote, makerFeeRate);

      const changes = [] as Parameters<typeof applyLedgerChanges>[0];

      if (input.side === "buy") {
        // Taker = buyer. Maker = seller.
        // FIX B014: Taker buyer pays takerFee in QUOTE (USDT).
        // At order entry we froze: quote * (1 + takerFeeRate).
        // Settlement consumes: quote + takerFee = quote * (1 + takerFeeRate).
        // The entire frozen amount is consumed — nothing to return.
        changes.push({
          userId: f.takerUserId,
          subAccountId: f.takerSubAccountId,
          asset: market.quote,
          delta: 0n,                        // fee consumed from frozen buffer, no refund
          lockedDelta: -(quote + takerFee), // unlock principal + fee
          reason: "trade_fill",
          refTable: "orders",
          refId: takerOrderId,
        });
        // Buyer receives full BTC quantity (no BTC fee deduction)
        changes.push({
          userId: f.takerUserId,
          subAccountId: f.takerSubAccountId,
          asset: market.base,
          delta: f.quantity,
          lockedDelta: 0n,
          reason: "trade_fill",
          refTable: "orders",
          refId: takerOrderId,
        });
        changes.push({
          userId: f.makerUserId,
          subAccountId: f.makerSubAccountId,
          asset: market.base,
          delta: 0n,
          lockedDelta: -f.quantity,
          reason: "trade_fill",
          refTable: "orders",
          refId: f.makerOrderId,
        });
        changes.push({
          userId: f.makerUserId,
          subAccountId: f.makerSubAccountId,
          asset: market.quote,
          delta: quote - makerFee,
          lockedDelta: 0n,
          reason: "trade_fill",
          refTable: "orders",
          refId: f.makerOrderId,
        });
      } else {
        // Taker = seller. Maker = buyer.
        // Taker seller pays takerFee in QUOTE (USDT). Unchanged.
        changes.push({
          userId: f.takerUserId,
          subAccountId: f.takerSubAccountId,
          asset: market.base,
          delta: 0n,
          lockedDelta: -f.quantity,
          reason: "trade_fill",
          refTable: "orders",
          refId: takerOrderId,
        });
        changes.push({
          userId: f.takerUserId,
          subAccountId: f.takerSubAccountId,
          asset: market.quote,
          delta: quote - takerFee,
          lockedDelta: 0n,
          reason: "trade_fill",
          refTable: "orders",
          refId: takerOrderId,
        });
        // Maker buyer pays makerFee in QUOTE (USDT). Unchanged.
        // Maker buyer froze quote * (1 + takerFeeRate) at order entry.
        // Settlement consumes: quote + makerFee.
        // Excess fee buffer = quote * (takerFeeRate - makerFeeRate) is returned.
        const makerFeeBuffer = mul(quote, takerFeeRate); // what was frozen as fee buffer
        const makerFeeRefund = makerFeeBuffer - makerFee; // excess buffer to return
        changes.push({
          userId: f.makerUserId,
          subAccountId: f.makerSubAccountId,
          asset: market.quote,
          delta: makerFeeRefund,               // return excess fee buffer to available
          lockedDelta: -(quote + makerFeeBuffer), // unlock principal + fee buffer
          reason: "trade_fill",
          refTable: "orders",
          refId: f.makerOrderId,
        });
        changes.push({
          userId: f.makerUserId,
          subAccountId: f.makerSubAccountId,
          asset: market.base,
          delta: f.quantity,
          lockedDelta: 0n,
          reason: "trade_fill",
          refTable: "orders",
          refId: f.makerOrderId,
        });
      }

      await applyLedgerChanges(changes);

      const buyerIsMaker = input.side === "sell";
      const buyerOrderId = buyerIsMaker ? f.makerOrderId : takerOrderId;
      const sellerOrderId = buyerIsMaker ? takerOrderId : f.makerOrderId;
      const buyerUserId = buyerIsMaker ? f.makerUserId : f.takerUserId;
      const sellerUserId = buyerIsMaker ? f.takerUserId : f.makerUserId;
      const buyerFee = buyerIsMaker ? makerFee : takerFee;
      const sellerFee = buyerIsMaker ? takerFee : makerFee;

      await db.insert(tradesTable).values({
        symbol: market.symbol,
        price: formatDec(f.price),
        quantity: formatDec(f.quantity),
        quoteQty: formatDec(quote),
        buyerOrderId,
        sellerOrderId,
        buyerUserId,
        sellerUserId,
        buyerIsMaker,
        buyerFee: formatDec(buyerFee),
        sellerFee: formatDec(sellerFee),
      });

      // FIX B005: Update maker order status after each fill.
      // Previously settleFills only updated taker order status (done in submitOrder after
      // this call), but never updated the maker's filledQty / quoteFilled / status.
      // This left maker orders stuck in 'new' forever with funds permanently frozen.
      const [makerRow] = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, f.makerOrderId));
      if (makerRow) {
        const makerFilledQty = parseDec(makerRow.filledQty) + f.quantity;
        const makerQuoteFilled = parseDec(makerRow.quoteFilled) + quote;
        const makerTotalQty = parseDec(makerRow.quantity);
        const makerStatus: "partial" | "filled" =
          makerFilledQty >= makerTotalQty ? "filled" : "partial";
        const makerAvgPrice =
          makerFilledQty > 0n
            ? (makerQuoteFilled * 10n ** 18n) / makerFilledQty
            : 0n;
        await db
          .update(ordersTable)
          .set({
            filledQty: formatDec(makerFilledQty),
            quoteFilled: formatDec(makerQuoteFilled),
            avgPrice: formatDec(makerAvgPrice),
            status: makerStatus,
          })
          .where(eq(ordersTable.id, f.makerOrderId));
        this.emit("order_update", {
          orderId: f.makerOrderId,
          status: makerStatus,
          filledQty: makerFilledQty,
          quoteFilled: makerQuoteFilled,
        });
        // Send notification to maker
        const makerSide = input.side === "buy" ? "sell" : "buy";
        const makerFeeAmt = input.side === "buy" ? makerFee : makerFee;
        const makerFeeAsset = market.quote;
        void createNotification({
          userId: f.makerUserId,
          type: "order_filled",
          title: `限价${makerSide === "buy" ? "买入" : "卖出"} ${market.symbol} 已成交`,
          body: `您的限价单以 ${formatDec(f.price)} ${market.quote} 成交 ${formatDec(f.quantity)} ${market.base}，手续费 ${formatDec(makerFeeAmt)} ${makerFeeAsset}`,
          refTable: "orders",
          refId: f.makerOrderId,
        });
      }

      this.emit("trade", {
        symbol: market.symbol,
        price: formatDec(f.price),
        quantity: formatDec(f.quantity),
        quoteQty: formatDec(quote),
        timestamp: Date.now(),
        side: input.side,
      });
    }
  }

  /**
   * Called by the market data hub whenever a new ticker price arrives.
   * Scans all resting limit orders for this symbol and fills those whose
   * price condition is now met (buy limit >= market price, sell limit <= market price).
   * This ensures limit orders are executed as soon as the market reaches the target price.
   */
  async onTicker(symbol: string, marketPrice: string) {
    // FIX H003: Skip if a previous onTicker for this symbol is still running.
    if (this.onTickerProcessing.has(symbol)) return;
    this.onTickerProcessing.add(symbol);
    try {
      await this._onTickerImpl(symbol, marketPrice);
    } finally {
      this.onTickerProcessing.delete(symbol);
    }
  }

  private async _onTickerImpl(symbol: string, marketPrice: string) {
    const eng = this.engines.get(symbol);
    if (!eng) return;
    const market = getMarket(symbol);
    if (!market) return;
    const db = await getDb();
    if (!db) return;
    const price = parseDec(marketPrice);
    if (price <= 0n) return;

    // P0 mode isolation: orderbook markets are pure internal matching markets.
    // External tickers may update UI price, but they must never platform-fill
    // resting orders. Binance-mirror markets keep the original platform fill path.
    if ((market.marketMode ?? "binance_mirror") !== "binance_mirror") return;

    // FIX B004 (regression): Filter by status IN ('new','partial') at the SQL level
    // so we never load canceled/filled orders into memory and attempt to re-fill them.
    const restingOrders = await db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.symbol, symbol),
          eq(ordersTable.type, "limit"),
          or(
            eq(ordersTable.status, "new"),
            eq(ordersTable.status, "partial")
          )
        )
      );

    // Platform AMM fills must be gated by executable bookTicker quotes, not ticker lastPrice.
    // The ticker price can be an index/last trade/mid-like value that is not visible in the
    // displayed order book. For buy limits, the executable price is ask; for sell limits, bid.
    let executableAskPrice: bigint | null = null;
    let executableBidPrice: bigint | null = null;
    if (restingOrders.some((o) => o.side === "buy")) {
      executableAskPrice = await this.fetchFreshBookTickerPrice(symbol, "buy").catch(() => null);
    }
    if (restingOrders.some((o) => o.side === "sell")) {
      executableBidPrice = await this.fetchFreshBookTickerPrice(symbol, "sell").catch(() => null);
    }

    const toFill = restingOrders.filter((o) => {
      if (o.status !== "new" && o.status !== "partial") return false;
      if (!o.price) return false;
      const limitPrice = parseDec(o.price);
      // Buy limit: fill only when executable ask is at or below the limit price.
      if (o.side === "buy") return executableAskPrice !== null && executableAskPrice <= limitPrice;
      // Sell limit: fill only when executable bid is at or above the limit price.
      if (o.side === "sell") return executableBidPrice !== null && executableBidPrice >= limitPrice;
      return false;
    });

    for (const order of toFill) {
      eng.submitOnTicker(order.id, async () => {
        try {
          // Re-check status inside the queue (may have been filled/cancelled already)
          const [fresh] = await db.select().from(ordersTable).where(eq(ordersTable.id, order.id));
          if (!fresh || (fresh.status !== "new" && fresh.status !== "partial")) {
            return;
          }

          const limitPrice = parseDec(fresh.price!);
          const takerFeeRate = parseDec(market.takerFee);
          const base = market.base;
          const quote = market.quote;
          const filledSoFar = parseDec(fresh.filledQty);
          const remaining = parseDec(fresh.quantity) - filledSoFar;
          if (remaining <= 0n) return;

          // Mode already checked before loading resting orders. Keep a second local
          // guard for safety if market config is refreshed while this task is queued.
          if ((market.marketMode ?? "binance_mirror") !== "binance_mirror") return;

          // binance_mirror ticker execution is platform-counterparty only.
          // Do not inspect or submit to the internal order book here. If the
          // platform quote satisfies the limit price, the platform userId=0 is
          // the only counterparty; otherwise the order remains open.

          // Verify the platform executable quote still satisfies the limit price.
          // We fetch the fresh bookTicker to confirm executability, but the actual
          // fill price is always the user's limitPrice (platform takes the spread).
          let executablePrice: bigint;
          try {
            const freshFillPrice = await this.fetchFreshBookTickerPrice(symbol, fresh.side as "buy" | "sell");
            if (freshFillPrice === null) {
              console.warn(`[engine:onTicker] skip platform fill for order #${fresh.id}: executable quote unavailable`);
              return;
            }
            executablePrice = freshFillPrice;
          } catch (quoteErr) {
            console.warn(`[engine:onTicker] skip platform fill for order #${fresh.id}: executable quote unavailable`, quoteErr);
            return;
          }
          // Re-check: platform quote must still satisfy the limit condition
          if (fresh.side === "buy" && executablePrice > limitPrice) return;
          if (fresh.side === "sell" && executablePrice < limitPrice) return;

          // Fill at the user's limit price (not the platform executable quote).
          // This ensures the user always gets exactly the price they specified.
          const fillPrice = limitPrice;
          const fillQty = remaining;
          const fillQuote = mul(fillPrice, fillQty);

          if (fresh.side === "sell") {
            // Sell limit orders freeze only base quantity. Trading fees are charged
            // from quote proceeds, so platform fills must unlock exactly fillQty base.
            const takerFee = mul(fillQuote, takerFeeRate);
            const quoteNet = fillQuote - takerFee;
            await applyLedgerChanges([
              { userId: fresh.userId, subAccountId: fresh.subAccountId, asset: base, delta: 0n, lockedDelta: -fillQty, reason: "trade_fill", refTable: "orders", refId: fresh.id },
              { userId: fresh.userId, subAccountId: fresh.subAccountId, asset: quote, delta: quoteNet, lockedDelta: 0n, reason: "trade_fill", refTable: "orders", refId: fresh.id },
            ]);
            await db.insert(tradesTable).values({ symbol, price: formatDec(fillPrice), quantity: formatDec(fillQty), quoteQty: formatDec(fillQuote), buyerOrderId: 0, sellerOrderId: fresh.id, buyerUserId: 0, sellerUserId: fresh.userId, buyerIsMaker: true, buyerFee: "0", sellerFee: formatDec(takerFee) });
          } else {
            // buy limit: Fill at limitPrice.
            // Frozen at entry: limitPrice * qty * (1 + takerFeeRate)
            // Consumed: limitPrice * qty + takerFee = fillQuote + takerFee
            // Since fillPrice === limitPrice, consumed === frozenTotal, no refund needed
            // (but we keep the logic for partial fills where filledSoFar > 0).
            const takerFee = mul(fillQuote, takerFeeRate); // fee in USDT
            const consumed = fillQuote + takerFee;
            const frozenTotal = mul(limitPrice, parseDec(fresh.quantity)) + mul(mul(limitPrice, parseDec(fresh.quantity)), takerFeeRate);
            const unusedQuote = frozenTotal > consumed ? frozenTotal - consumed : 0n;
            await applyLedgerChanges([
              // Unlock consumed amount (principal + fee); no delta (fee consumed from locked)
              { userId: fresh.userId, subAccountId: fresh.subAccountId, asset: quote, delta: 0n, lockedDelta: -consumed, reason: "trade_fill", refTable: "orders", refId: fresh.id },
              // Buyer receives full base quantity
              { userId: fresh.userId, subAccountId: fresh.subAccountId, asset: base, delta: fillQty, lockedDelta: 0n, reason: "trade_fill", refTable: "orders", refId: fresh.id },
            ]);
            if (unusedQuote > 0n) {
              await applyLedgerChanges([{ userId: fresh.userId, subAccountId: fresh.subAccountId, asset: quote, delta: unusedQuote, lockedDelta: -unusedQuote, reason: "order_unfreeze", refTable: "orders", refId: fresh.id }]);
            }
            await db.insert(tradesTable).values({ symbol, price: formatDec(fillPrice), quantity: formatDec(fillQty), quoteQty: formatDec(fillQuote), buyerOrderId: fresh.id, sellerOrderId: 0, buyerUserId: fresh.userId, sellerUserId: 0, buyerIsMaker: false, buyerFee: formatDec(takerFee), sellerFee: "0" });
          }

          const newFilledQty = filledSoFar + fillQty;
          const newQuoteFilled = parseDec(fresh.quoteFilled) + fillQuote;
          const avgPrice = (newQuoteFilled * 10n ** 18n) / newFilledQty;
          await db.update(ordersTable).set({ filledQty: formatDec(newFilledQty), quoteFilled: formatDec(newQuoteFilled), avgPrice: formatDec(avgPrice), status: "filled" }).where(eq(ordersTable.id, fresh.id));

          this.lastPrices.set(symbol, fillPrice);
          this.emit("order_update", { orderId: fresh.id, status: "filled", filledQty: newFilledQty, quoteFilled: newQuoteFilled });
          this.emit("trade", { symbol, price: formatDec(fillPrice), quantity: formatDec(fillQty), quoteQty: formatDec(fillQuote), timestamp: Date.now(), side: fresh.side });

          // Taker fees are in QUOTE (USDT)
          const feeAmt = mul(fillQuote, takerFeeRate);
          const feeAsset = quote;
          void createNotification({
            userId: fresh.userId,
            type: "order_filled",
            title: `限价${fresh.side === "buy" ? "买入" : "卖出"} ${symbol} 已成交`,
            body: `限价单以 ${formatDec(fillPrice)} ${quote} 成交 ${formatDec(fillQty)} ${base}，手续费 ${formatDec(feeAmt)} ${feeAsset}`,
            refTable: "orders",
            refId: fresh.id,
          });
          console.log(`[engine:onTicker] Filled limit order #${fresh.id} ${fresh.side} ${symbol} at limitPrice ${formatDec(fillPrice)} (platform quote: ${formatDec(executablePrice)}, ticker: ${marketPrice})`);
        } catch (err) {
          console.error(`[engine:onTicker] fill error for order ${order.id}:`, err);
          // Mark as canceled in DB if still open (best-effort). Do not touch the
          // internal order book in binance_mirror mode; auto market-making orders
          // are intentionally not loaded there.
          try {
            await db.update(ordersTable).set({ status: "canceled" }).where(
              and(eq(ordersTable.id, order.id), or(eq(ordersTable.status, "new"), eq(ordersTable.status, "partial")))
            );
          } catch (_) {}
        }
      });
    }
  }

  async cancelOrder(userId: number, orderId: number) {
    const db = await getDb();
    if (!db) throw new Error("数据库连接失败，请稍庎重试");

    // P0 correctness fix: do not use multi-statement SQL for cancel.  Read the
    // order through the ORM, validate ownership, then release funds and mark the
    // order canceled in an auditable sequence.
    const [r] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    let row: typeof import("../../../drizzle/schema").orders.$inferSelect | undefined = r;

    if (!row) throw new Error("Order not found");
    if (row.userId !== userId) throw new Error("Not your order");
    if (row.status === "filled" || row.status === "canceled") {
      const market = getMarket(row.symbol);
      if ((market?.marketMode ?? "binance_mirror") === "orderbook") {
        // Only pure orderbook markets maintain resident orders in memory.
        const eng2 = this.engines.get(row.symbol);
        if (eng2) eng2.book.cancel(orderId);
      }
      return { ...row, status: "canceled" as const };
    }

    const eng = this.engines.get(row.symbol);
    if (!eng) throw new Error("撮合引擎未初始化");
    const market = getMarket(row.symbol)!;

    // FIX B_CANCEL: Bypass eng.submit queue for cancelOrder.
    // cancelOrder used to wrap everything in eng.submit(), which meant it had to
    // wait behind all pending onTicker tasks (~300ms each). With many queued tasks
    // from cancel_all_open_db, a user cancel could take 30+ seconds.
    //
    // Safety: JavaScript is single-threaded. eng.book.cancel() is synchronous and
    // runs atomically in the current microtask. The async drain() tasks cannot
    // interleave with synchronous code, so removing from the book here is safe.
    // DB operations (applyLedgerChanges, UPDATE) are also safe to run directly
    // because the order is already removed from the in-memory book before any
    // await, preventing double-settlement.

    // Step 1: Remove from in-memory book only for pure orderbook markets.
    // binance_mirror orders are platform-counterparty orders and are never
    // resident in the internal book.
    const resident = market.marketMode === "orderbook" ? eng.book.cancel(orderId) : null;
    const remaining = resident
      ? resident.remaining
      : parseDec(row.quantity) - parseDec(row.filledQty);

    // PERF FIX: Steps 2+3 run asynchronously (fire-and-forget).
    // For orderbook markets the order is already removed from the in-memory book
    // (step 1), so no race condition is possible. For binance_mirror markets no
    // book entry exists by design. We return immediately with a synthetic canceled row.
    void (async () => {
      try {
        // Step 2: Release frozen funds.
        await this.releaseRemainingOrderFunds({ order: row, market, orderId, remaining });
        // Step 3: Mark as canceled in DB.
        await db.update(ordersTable).set({ status: "canceled" }).where(eq(ordersTable.id, orderId));
      } catch (e) {
        console.error(`[engine:cancelOrder] async cleanup error for order ${orderId}:`, e);
      }
    })();

    // Return immediately with synthetic canceled row.
    return { ...row, status: "canceled" as const };
  }
}

let _engine: MatchingEngine | null = null;
export async function getMatchingEngine() {
  if (!_engine) {
    _engine = new MatchingEngine();
    await _engine.init();
  }
  return _engine;
}
export type { MatchingEngine };

export function __resetMatchingEngineForTests() {
  if (process.env.NODE_ENV !== "test") return;
  _engine = null;
}





