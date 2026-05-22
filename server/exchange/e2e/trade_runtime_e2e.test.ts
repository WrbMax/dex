import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDec, parseDec, ZERO } from "../utils/bigdec";
import {
  assertAllOrderAggregatesMatchTrades,
  assertMarketBuyTotalCostWithinBudget,
  assertNoNegativeBalances,
  assertTerminalOrderHasNoLockedBalance,
  assertTradeQuoteMath,
} from "./asset_reconciliation";

const testState = vi.hoisted(() => {
  return {
    nextOrderId: 1,
    currentOrderId: 0,
    orders: new Map<number, any>(),
    trades: [] as any[],
    ledgerChanges: [] as any[],
    balances: new Map<string, { available: bigint; locked: bigint }>(),
    bookTickers: [] as Array<{ bidPrice?: string; askPrice?: string; ok?: boolean }>,
    notifications: [] as any[],
    marketMode: "binance_mirror" as "binance_mirror" | "orderbook",
    allowMarketOrder: true,
    allowLimitOrder: true,
    allowRealTrade: true,
    isActive: true,
  };
});

function balanceKey(userId: number, subAccountId: number, asset: string) {
  return `${userId}:${subAccountId}:${asset}`;
}

function setBalance(userId: number, subAccountId: number, asset: string, available: string, locked = "0") {
  testState.balances.set(balanceKey(userId, subAccountId, asset), {
    available: parseDec(available),
    locked: parseDec(locked),
  });
}

function getBalance(userId: number, subAccountId: number, asset: string) {
  return testState.balances.get(balanceKey(userId, subAccountId, asset)) ?? { available: ZERO, locked: ZERO };
}

function setMarketMode(mode: "binance_mirror" | "orderbook") {
  testState.marketMode = mode;
}

function configureMarket(flags: Partial<{ allowMarketOrder: boolean; allowLimitOrder: boolean; allowRealTrade: boolean; isActive: boolean }>) {
  Object.assign(testState, flags);
}

function expectBalance(userId: number, asset: string, available: string, locked = "0") {
  const balance = getBalance(userId, 1, asset);
  expect(formatDec(balance.available), `${userId} ${asset} available`).toBe(available);
  expect(formatDec(balance.locked), `${userId} ${asset} locked`).toBe(locked);
}

function resetRuntimeState() {
  testState.nextOrderId = 1;
  testState.currentOrderId = 0;
  testState.orders.clear();
  testState.trades.length = 0;
  testState.ledgerChanges.length = 0;
  testState.balances.clear();
  testState.bookTickers.length = 0;
  testState.notifications.length = 0;
  testState.marketMode = "binance_mirror";
  testState.allowMarketOrder = true;
  testState.allowLimitOrder = true;
  testState.allowRealTrade = true;
  testState.isActive = true;
  setBalance(101, 1, "USDT", "10000");
  setBalance(101, 1, "BTC", "2");
}

function chunkText(chunk: any): string {
  if (!chunk) return "";
  if (typeof chunk === "string") return chunk;
  const value = chunk.value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join("");
  if (typeof value === "string" && !Object.prototype.hasOwnProperty.call(chunk, "encoder")) return value;
  return "";
}

function logicalOperator(chunk: any): "and" | "or" | null {
  const text = chunkText(chunk).trim().toLowerCase();
  if (text === "and" || text === "or") return text;
  return null;
}

function meaningfulChunks(chunks: any[]) {
  return chunks.filter((chunk) => {
    const text = chunkText(chunk).trim();
    if (text === "(" || text === ")") return false;
    if (text !== "") return true;
    return Boolean(chunk?.queryChunks || columnName(chunk) || paramValue(chunk) !== undefined);
  });
}

function splitByOperator(chunks: any[], op: "and" | "or") {
  const groups: any[][] = [[]];
  for (const chunk of chunks) {
    if (logicalOperator(chunk) === op) {
      groups.push([]);
      continue;
    }
    groups[groups.length - 1].push(chunk);
  }
  return groups.map(meaningfulChunks).filter((group) => group.length > 0);
}

function columnName(chunk: any): string | null {
  if (!chunk) return null;
  if (typeof chunk.name === "string") return chunk.name;
  if (typeof chunk.keyAsName === "string") return chunk.keyAsName;
  if (typeof chunk.config?.name === "string") return chunk.config.name;
  return null;
}

function paramValue(chunk: any): any {
  if (!chunk || !Object.prototype.hasOwnProperty.call(chunk, "value")) return undefined;
  if (Array.isArray(chunk.value)) return undefined;
  return chunk.value;
}

function conditionMatches(row: any, condition: any): boolean {
  if (!condition) return true;
  const chunks = meaningfulChunks(condition.queryChunks ?? []);
  if (chunks.length === 0) return true;
  if (chunks.length === 1 && chunks[0]?.queryChunks) return conditionMatches(row, chunks[0]);

  if (chunks.some((chunk) => logicalOperator(chunk) === "or")) {
    return splitByOperator(chunks, "or").some((group) => conditionMatches(row, { queryChunks: group }));
  }
  if (chunks.some((chunk) => logicalOperator(chunk) === "and")) {
    return splitByOperator(chunks, "and").every((group) => conditionMatches(row, { queryChunks: group }));
  }

  const col = chunks.map(columnName).find(Boolean);
  const val = chunks.map(paramValue).find((v) => v !== undefined);
  if (!col) return true;
  return String(row[col]) === String(val);
}

function queryResult(rows: any[]) {
  const promise: any = Promise.resolve(rows);
  promise.limit = async (n: number) => rows.slice(0, n);
  return promise;
}

function runtimeMarket() {
  return {
    id: 1,
    symbol: "BTCUSDT",
    base: "BTC",
    quote: "USDT",
    priceTick: "0.010000000000000000",
    amountStep: "0.000001000000000000",
    minNotional: "10.000000000000000000",
    takerFee: "0.001000000000000000",
    makerFee: "0.000800000000000000",
    allowMarketOrder: testState.allowMarketOrder,
    allowLimitOrder: testState.allowLimitOrder,
    allowRealTrade: testState.allowRealTrade,
    marketMode: testState.marketMode,
    isActive: testState.isActive,
  };
}

vi.mock("../../db", () => ({
  getDb: async () => ({
    select: (_projection?: any) => ({
      from: (_table: any) => ({
        where: (condition: any) => {
          const rows = Array.from(testState.orders.values()).filter((row) => conditionMatches(row, condition));
          return queryResult(rows);
        },
        limit: async (_n: number) => [],
      }),
    }),
    insert: (_table: any) => ({
      values: async (value: any) => {
        if (Object.prototype.hasOwnProperty.call(value, "clientOrderId")) {
          const id = testState.nextOrderId++;
          testState.currentOrderId = id;
          testState.orders.set(id, { id, ...value });
          return { insertId: id };
        }
        testState.trades.push(value);
        return { insertId: testState.trades.length };
      },
    }),
    update: (_table: any) => ({
      set: (patch: any) => ({
        where: async (condition: any) => {
          for (const [id, row] of testState.orders.entries()) {
            if (conditionMatches(row, condition)) {
              testState.orders.set(id, { ...row, ...patch });
            }
          }
        },
      }),
    }),
  }),
}));

vi.mock("../accounts/ledger", () => ({
  applyLedgerChanges: async (changes: any[]) => {
    testState.ledgerChanges.push(...changes);
    for (const change of changes) {
      const key = balanceKey(change.userId, change.subAccountId, change.asset);
      const before = testState.balances.get(key) ?? { available: ZERO, locked: ZERO };
      const after = {
        available: before.available + change.delta,
        locked: before.locked + change.lockedDelta,
      };
      if (after.available < ZERO || after.locked < ZERO) {
        throw new Error(`Insufficient ${change.asset}: available=${formatDec(after.available)} locked=${formatDec(after.locked)}`);
      }
      testState.balances.set(key, after);
    }
  },
}));

vi.mock("../notifications/service", () => ({
  createNotification: async (notification: any) => {
    testState.notifications.push(notification);
  },
}));

vi.mock("../markets/registry", () => ({
  ensureMarketsLoaded: async () => [runtimeMarket()],
  allMarketsCached: () => [runtimeMarket()],
  getMarket: (symbol: string) => (symbol === "BTCUSDT" ? runtimeMarket() : undefined),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async () => {
    const next = testState.bookTickers.shift();
    if (!next || next.ok === false) {
      return { ok: false, json: async () => ({}) };
    }
    return {
      ok: true,
      json: async () => ({ bidPrice: next.bidPrice, askPrice: next.askPrice }),
    };
  })
);

import { __resetMatchingEngineForTests, getMatchingEngine } from "../matching/engine";

async function flushAsyncEngineWork() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForCondition(label: string, predicate: () => boolean) {
  for (let i = 0; i < 30; i += 1) {
    await flushAsyncEngineWork();
    if (predicate()) return;
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForOrderStatus(orderId: number, statuses: string[]) {
  await waitForCondition(`order ${orderId} status in ${statuses.join(",")}`, () => statuses.includes(testState.orders.get(orderId)?.status));
}

describe("E2E-RUNTIME: matching engine asset-safe trade execution", () => {
  beforeEach(() => {
    resetRuntimeState();
    __resetMatchingEngineForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    assertNoNegativeBalances(testState.balances);
    assertTradeQuoteMath(testState.trades);
    assertAllOrderAggregatesMatchTrades(testState.orders.values(), testState.trades);
  });

  it("TC-E2E-MKT-01: 连续市价买入必须按每次实时 best ask 成交，不能固定使用旧 lastPrices 缓存价", async () => {
    const engine = await getMatchingEngine();

    await engine.onTicker("BTCUSDT", "78722");
    testState.bookTickers.push(
      { bidPrice: "79990", askPrice: "80000" },
      { bidPrice: "80090", askPrice: "80100" }
    );

    const first = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "market", quantity: "1000" });
    const second = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "market", quantity: "1000" });

    expect(first.order.status).toBe("filled");
    expect(second.order.status).toBe("filled");
    expect(testState.trades.map((t) => t.price)).toEqual(["80000", "80100"]);
    expect(testState.trades.map((t) => t.price)).not.toContain("78722");
  });

  it("TC-E2E-MKT-02: 市价卖出必须按每次实时 best bid 成交，不能固定使用旧 lastPrices 缓存价", async () => {
    const engine = await getMatchingEngine();

    await engine.onTicker("BTCUSDT", "78722");
    testState.bookTickers.push(
      { bidPrice: "79900", askPrice: "79910" },
      { bidPrice: "79800", askPrice: "79810" }
    );

    await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "market", quantity: "0.01" });
    await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "market", quantity: "0.01" });

    expect(testState.trades.map((t) => t.price)).toEqual(["79900", "79800"]);
    expect(testState.trades.map((t) => t.price)).not.toContain("78722");
  });

  it("TC-E2E-MKT-03: 市价买入 1000 USDT 必须是总成本上限，成交额加手续费不得超过 1000 USDT", async () => {
    const engine = await getMatchingEngine();

    testState.bookTickers.push({ bidPrice: "79990", askPrice: "80000" });
    await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "market", quantity: "1000" });

    const totalCost = assertMarketBuyTotalCostWithinBudget(testState.currentOrderId, testState.trades, "1000");
    expect(totalCost).toBeGreaterThan(parseDec("999"));

    const usdt = getBalance(101, 1, "USDT");
    assertTerminalOrderHasNoLockedBalance(usdt, "USDT");
    expect(usdt.available).toBe(parseDec("10000") - totalCost);
  });

  it("TC-E2E-MKT-04: 实时盘口不可用时必须取消并全额解冻，不能回退到旧缓存价成交", async () => {
    const engine = await getMatchingEngine();

    await engine.onTicker("BTCUSDT", "78722");
    testState.bookTickers.push({ ok: false });

    const result = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "market", quantity: "1000" });

    expect(result.order.status).toBe("canceled");
    expect(testState.trades).toHaveLength(0);
    expect(formatDec(getBalance(101, 1, "USDT").available)).toBe("10000");
    assertTerminalOrderHasNoLockedBalance(getBalance(101, 1, "USDT"), "USDT");
  });

  it("TC-E2E-LMT-01: 未触发的限价买单必须冻结成交本金和 taker 费缓冲，不能多冻或少冻", async () => {
    const engine = await getMatchingEngine();

    const result = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "70000", quantity: "0.01" });

    expect(result.order.status).toBe("new");
    expectBalance(101, "USDT", "9299.3", "700.7");
    expect(testState.trades).toHaveLength(0);
  });

  it("TC-E2E-LMT-02: 未触发的限价卖单只冻结基础币数量，计价币手续费应从成交收入中扣除", async () => {
    const engine = await getMatchingEngine();

    const result = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "90000", quantity: "0.01" });

    expect(result.order.status).toBe("new");
    expectBalance(101, "BTC", "1.99", "0.01");
    expect(testState.trades).toHaveLength(0);
  });

  it("TC-E2E-LMT-03: 限价买单与限价卖单内部撮合后 maker/taker 双方余额、手续费和订单聚合必须可对账", async () => {
    setMarketMode("orderbook");
    setBalance(101, 1, "BTC", "0");
    setBalance(102, 1, "BTC", "1");
    setBalance(102, 1, "USDT", "0");
    const engine = await getMatchingEngine();

    const seller = await engine.submitOrder({ userId: 102, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "80000", quantity: "0.01" });
    await waitForOrderStatus(seller.order.id, ["new"]);
    const buyer = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01" });
    await waitForOrderStatus(seller.order.id, ["filled"]);
    await waitForOrderStatus(buyer.order.id, ["filled"]);

    expect(testState.trades).toHaveLength(1);
    expect(testState.trades[0]).toMatchObject({ buyerOrderId: buyer.order.id, sellerOrderId: seller.order.id, buyerIsMaker: false, buyerFee: "0.8", sellerFee: "0.64" });
    expectBalance(101, "USDT", "9199.2", "0");
    expectBalance(101, "BTC", "0.01", "0");
    expectBalance(102, "BTC", "0.99", "0");
    expectBalance(102, "USDT", "799.36", "0");
  });

  it("TC-E2E-PARTIAL-01: 限价卖单部分成交后状态为 partial，剩余基础币冻结量必须等于未成交数量", async () => {
    setMarketMode("orderbook");
    setBalance(101, 1, "BTC", "0");
    setBalance(102, 1, "BTC", "1");
    setBalance(102, 1, "USDT", "0");
    const engine = await getMatchingEngine();

    const seller = await engine.submitOrder({ userId: 102, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "80000", quantity: "0.02" });
    await waitForOrderStatus(seller.order.id, ["new"]);
    const buyer = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.005" });
    await waitForOrderStatus(buyer.order.id, ["filled"]);
    await waitForOrderStatus(seller.order.id, ["partial"]);

    const sellerRow = testState.orders.get(seller.order.id);
    expect(sellerRow.filledQty).toBe("0.005");
    expect(sellerRow.quoteFilled).toBe("400");
    expectBalance(102, "BTC", "0.98", "0.015");
    expectBalance(102, "USDT", "399.68", "0");
  });

  it("TC-E2E-PARTIAL-02: 部分成交后撤单必须只释放剩余冻结，已成交资产和手续费不得回滚", async () => {
    setMarketMode("orderbook");
    setBalance(101, 1, "BTC", "0");
    setBalance(102, 1, "BTC", "1");
    setBalance(102, 1, "USDT", "0");
    const engine = await getMatchingEngine();

    const seller = await engine.submitOrder({ userId: 102, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "80000", quantity: "0.02" });
    await waitForOrderStatus(seller.order.id, ["new"]);
    await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.005" });
    await waitForOrderStatus(seller.order.id, ["partial"]);

    const canceled = await engine.cancelOrder(102, seller.order.id);
    expect(canceled.status).toBe("canceled");
    await waitForOrderStatus(seller.order.id, ["canceled"]);

    expectBalance(102, "BTC", "0.995", "0");
    expectBalance(102, "USDT", "399.68", "0");
  });

  it("TC-E2E-MULTI-01: 跨两个卖盘价格档位成交时，成交明细、均价和终态冻结余额必须一致", async () => {
    setMarketMode("orderbook");
    setBalance(101, 1, "BTC", "0");
    setBalance(102, 1, "BTC", "1");
    setBalance(102, 1, "USDT", "0");
    setBalance(103, 1, "BTC", "1");
    setBalance(103, 1, "USDT", "0");
    const engine = await getMatchingEngine();

    const ask1 = await engine.submitOrder({ userId: 102, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "79000", quantity: "0.01" });
    await waitForOrderStatus(ask1.order.id, ["new"]);
    const ask2 = await engine.submitOrder({ userId: 103, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "80000", quantity: "0.02" });
    await waitForOrderStatus(ask2.order.id, ["new"]);
    const buyer = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.03" });
    await waitForOrderStatus(buyer.order.id, ["filled"]);
    await waitForOrderStatus(ask1.order.id, ["filled"]);
    await waitForOrderStatus(ask2.order.id, ["filled"]);

    expect(testState.trades.map((t) => [t.price, t.quantity, t.quoteQty])).toEqual([
      ["79000", "0.01", "790"],
      ["80000", "0.02", "1600"],
    ]);
    expect(testState.orders.get(buyer.order.id).avgPrice).toBe(formatDec((parseDec("2390") * 10n ** 18n) / parseDec("0.03")));
    expectBalance(101, "BTC", "0.03", "0");
    assertTerminalOrderHasNoLockedBalance(getBalance(101, 1, "USDT"), "USDT");
  });

  it("TC-E2E-LMT-07: 内部盘口中低于买一的限价卖单必须按最优买一及价格优先档位成交", async () => {
    setMarketMode("orderbook");
    setBalance(101, 1, "BTC", "2");
    setBalance(101, 1, "USDT", "10000");
    setBalance(102, 1, "BTC", "0");
    setBalance(102, 1, "USDT", "10000");
    setBalance(103, 1, "BTC", "0");
    setBalance(103, 1, "USDT", "10000");
    const engine = await getMatchingEngine();

    const bid1 = await engine.submitOrder({ userId: 102, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "81000", quantity: "0.01" });
    await waitForOrderStatus(bid1.order.id, ["new"]);
    const bid2 = await engine.submitOrder({ userId: 103, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.02" });
    await waitForOrderStatus(bid2.order.id, ["new"]);

    const seller = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "79000", quantity: "0.03" });
    await waitForOrderStatus(seller.order.id, ["filled"]);
    await waitForOrderStatus(bid1.order.id, ["filled"]);
    await waitForOrderStatus(bid2.order.id, ["filled"]);

    expect(testState.trades.map((t) => [t.price, t.quantity, t.quoteQty, t.buyerIsMaker])).toEqual([
      ["81000", "0.01", "810", true],
      ["80000", "0.02", "1600", true],
    ]);
    expect(testState.orders.get(seller.order.id).price).toBe("79000");
    expect(testState.orders.get(seller.order.id).quoteFilled).toBe("2410");
    expect(testState.orders.get(seller.order.id).avgPrice).toBe(formatDec((parseDec("2410") * 10n ** 18n) / parseDec("0.03")));
    expectBalance(101, "BTC", "1.97", "0");
    expectBalance(101, "USDT", "12407.59", "0");
    expectBalance(102, "USDT", "9189.352", "0");
    expectBalance(102, "BTC", "0.01", "0");
    expectBalance(103, "USDT", "8398.72", "0");
    expectBalance(103, "BTC", "0.02", "0");
    assertNoNegativeBalances(testState.balances);
  });

  it("TC-E2E-CANCEL-01: 未成交限价买单撤单必须全额释放计价币冻结", async () => {
    const engine = await getMatchingEngine();

    const order = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "70000", quantity: "0.01" });
    expectBalance(101, "USDT", "9299.3", "700.7");

    await engine.cancelOrder(101, order.order.id);
    await waitForOrderStatus(order.order.id, ["canceled"]);
    expectBalance(101, "USDT", "10000", "0");
  });

  it("TC-E2E-CANCEL-02: 未成交限价卖单撤单必须全额释放基础币冻结，不得释放并未冻结的手续费缓冲", async () => {
    const engine = await getMatchingEngine();

    const order = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "90000", quantity: "0.01" });
    expectBalance(101, "BTC", "1.99", "0.01");

    await engine.cancelOrder(101, order.order.id);
    await waitForOrderStatus(order.order.id, ["canceled"]);
    expectBalance(101, "BTC", "2", "0");
  });

  it("TC-E2E-TICKER-01: ticker 跌破买入限价时，限价买单应按市场价成交并退回未使用冻结", async () => {
    const engine = await getMatchingEngine();

    const order = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01" });
    expect(order.order.status).toBe("new");
    await engine.onTicker("BTCUSDT", "79000");
    await waitForOrderStatus(order.order.id, ["filled"]);

    expect(testState.trades[0]).toMatchObject({ price: "79000", quantity: "0.01", quoteQty: "790", buyerOrderId: order.order.id, sellerOrderId: 0, buyerFee: "0.79" });
    expectBalance(101, "BTC", "2.01", "0");
    expectBalance(101, "USDT", "9209.21", "0");
  });

  it("TC-E2E-TICKER-02: ticker 涨破卖出限价时，限价卖单应按市场价成交且手续费从 USDT 收入中扣除", async () => {
    const engine = await getMatchingEngine();

    const order = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "80000", quantity: "0.01" });
    expect(order.order.status).toBe("new");
    await engine.onTicker("BTCUSDT", "81000");
    await waitForOrderStatus(order.order.id, ["filled"]);

    expect(testState.trades[0]).toMatchObject({ price: "81000", quantity: "0.01", quoteQty: "810", buyerOrderId: 0, sellerOrderId: order.order.id, sellerFee: "0.81" });
    expectBalance(101, "BTC", "1.99", "0");
    expectBalance(101, "USDT", "10809.19", "0");
  });

  it("TC-E2E-BOUNDARY-01: 余额不足时下单必须拒绝并将新建订单标记为 canceled", async () => {
    setBalance(101, 1, "USDT", "100");
    const engine = await getMatchingEngine();

    await expect(engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01" })).rejects.toThrow(/Insufficient USDT/);
    expect(testState.orders.get(testState.currentOrderId).status).toBe("canceled");
    expectBalance(101, "USDT", "100", "0");
  });

  it("TC-E2E-BOUNDARY-02: 小于最小名义价值或不符合数量步进的限价单必须在冻结前被拒绝", async () => {
    const engine = await getMatchingEngine();

    await expect(engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.0001" })).rejects.toThrow(/最小下单额/);
    await expect(engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.0000001" })).rejects.toThrow(/数量精度错误/);
    expect(testState.orders.size).toBe(0);
    expectBalance(101, "USDT", "10000", "0");
  });

  it("TC-E2E-LMT-04: 限价买单不得仅因外部 best ask 低于限价而立刻成交，必须等待可见 ticker 触发", async () => {
    const engine = await getMatchingEngine();

    testState.bookTickers.push({ bidPrice: "79990", askPrice: "80000" });
    const result = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "81000", quantity: "0.01" });

    expect(result.order.status).toBe("new");
    expect(result.order.price).toBe("81000");
    expect(result.order.avgPrice).toBe("0");
    expect(testState.trades).toHaveLength(0);
    expectBalance(101, "USDT", "9189.19", "810.81");
    expectBalance(101, "BTC", "2", "0");

    await engine.onTicker("BTCUSDT", "80000");
    await waitForOrderStatus(result.order.id, ["filled"]);
    expect(testState.trades[0]).toMatchObject({ price: "80000", quantity: "0.01", quoteQty: "800", buyerOrderId: result.order.id, sellerOrderId: 0, buyerFee: "0.8" });
    expectBalance(101, "USDT", "9199.2", "0");
    expectBalance(101, "BTC", "2.01", "0");
  });

  it("TC-E2E-LMT-05: 限价卖单不得仅因外部 best bid 高于限价而立刻成交，必须等待可见 ticker 触发", async () => {
    const engine = await getMatchingEngine();

    testState.bookTickers.push({ bidPrice: "80000", askPrice: "80010" });
    const result = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "79000", quantity: "0.01" });

    expect(result.order.status).toBe("new");
    expect(result.order.price).toBe("79000");
    expect(result.order.avgPrice).toBe("0");
    expect(testState.trades).toHaveLength(0);
    expectBalance(101, "BTC", "1.99", "0.01");
    expectBalance(101, "USDT", "10000", "0");

    await engine.onTicker("BTCUSDT", "80000");
    await waitForOrderStatus(result.order.id, ["filled"]);
    expect(testState.trades[0]).toMatchObject({ price: "80000", quantity: "0.01", quoteQty: "800", buyerOrderId: 0, sellerOrderId: result.order.id, sellerFee: "0.8" });
    expectBalance(101, "BTC", "1.99", "0");
    expectBalance(101, "USDT", "10799.2", "0");
  });

  it("TC-E2E-LMT-06: 平台流动性不可成交的限价买卖单必须留在订单簿并保持正确冻结", async () => {
    const engine = await getMatchingEngine();

    testState.bookTickers.push({ bidPrice: "79990", askPrice: "80000" }, { bidPrice: "80000", askPrice: "80010" });
    const buy = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "79000", quantity: "0.01" });
    const sell = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "81000", quantity: "0.01" });

    expect(buy.order.status).toBe("new");
    expect(sell.order.status).toBe("new");
    expect(testState.trades).toHaveLength(0);
    expectBalance(101, "USDT", "9209.21", "790.79");
    expectBalance(101, "BTC", "1.99", "0.01");
  });

  it("TC-E2E-BOUNDARY-03: 刚好等于最小名义价值的限价单允许冻结并进入订单簿", async () => {
    const engine = await getMatchingEngine();

    const result = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.000125" });

    expect(result.order.status).toBe("new");
    expect(testState.trades).toHaveLength(0);
    expectBalance(101, "USDT", "9989.99", "10.01");
  });

  it("TC-E2E-BOUNDARY-04: 买单余额刚好等于含费冻结额可下单，少 1 wei 必须拒绝且无残留冻结", async () => {
    const engine = await getMatchingEngine();

    setBalance(101, 1, "USDT", "800.8");
    const accepted = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01" });
    expect(accepted.order.status).toBe("new");
    expectBalance(101, "USDT", "0", "800.8");

    resetRuntimeState();
    const engineAfterReset = await getMatchingEngine();
    setBalance(101, 1, "USDT", "800.799999999999999999");
    await expect(engineAfterReset.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01" })).rejects.toThrow(/Insufficient USDT/);
    expect(testState.orders.get(testState.currentOrderId).status).toBe("canceled");
    expectBalance(101, "USDT", "800.799999999999999999", "0");
  });

  it("TC-E2E-BOUNDARY-05: 卖单基础币余额刚好等于数量可挂单，少 1 wei 必须拒绝且无残留冻结", async () => {
    const engine = await getMatchingEngine();

    setBalance(101, 1, "BTC", "0.01");
    const accepted = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "90000", quantity: "0.01" });
    expect(accepted.order.status).toBe("new");
    expectBalance(101, "BTC", "0", "0.01");

    resetRuntimeState();
    const engineAfterReset = await getMatchingEngine();
    setBalance(101, 1, "BTC", "0.009999999999999999");
    await expect(engineAfterReset.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "90000", quantity: "0.01" })).rejects.toThrow(/Insufficient BTC/);
    expect(testState.orders.get(testState.currentOrderId).status).toBe("canceled");
    expectBalance(101, "BTC", "0.009999999999999999", "0");
  });

  it("TC-E2E-SWITCH-01: 交易对暂停、市价单关闭、限价单关闭和仅展示行情必须在冻结前拒绝", async () => {
    const engine = await getMatchingEngine();

    configureMarket({ isActive: false });
    await expect(engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01" })).rejects.toThrow(/已下架或暂停交易/);

    configureMarket({ isActive: true, allowRealTrade: false });
    await expect(engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01" })).rejects.toThrow(/仅展示行情|暂不允许真实成交/);

    configureMarket({ allowRealTrade: true, allowMarketOrder: false });
    await expect(engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "market", quantity: "100" })).rejects.toThrow(/暂不支持市价单/);

    configureMarket({ allowMarketOrder: true, allowLimitOrder: false });
    await expect(engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01" })).rejects.toThrow(/暂不支持限价单/);
    expect(testState.orders.size).toBe(0);
    expectBalance(101, "USDT", "10000", "0");
    expectBalance(101, "BTC", "2", "0");
  });

  it("TC-E2E-VALIDATION-02: 非法订单方向、类型和过长 clientOrderId 必须在冻结前拒绝", async () => {
    const engine = await getMatchingEngine();

    await expect(engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "hold" as any, type: "limit", price: "80000", quantity: "0.01" })).rejects.toThrow(/订单方向非法/);
    await expect(engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "stop_loss" as any, price: "80000", quantity: "0.01" })).rejects.toThrow(/订单类型非法/);
    await expect(engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01", clientOrderId: "x".repeat(65) })).rejects.toThrow(/clientOrderId 长度/);

    expect(testState.orders.size).toBe(0);
    expectBalance(101, "USDT", "10000", "0");
    expectBalance(101, "BTC", "2", "0");
  });

  it("TC-E2E-RACE-01: 同一用户反向限价单不得自成交制造虚假成交量", async () => {
    const engine = await getMatchingEngine();

    const sell = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "sell", type: "limit", price: "80000", quantity: "0.01" });
    const buy = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01" });

    expect(sell.order.status).toBe("new");
    expect(buy.order.status).toBe("new");
    expect(testState.trades).toHaveLength(0);
    expectBalance(101, "BTC", "1.99", "0.01");
    expectBalance(101, "USDT", "9199.2", "800.8");
  });

  it("TC-E2E-IDEMP-01: 相同 clientOrderId 重复提交必须返回原订单且不得重复冻结", async () => {
    const engine = await getMatchingEngine();

    const first = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01", source: "api", clientOrderId: "idem-buy-001" });
    const second = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01", source: "api", clientOrderId: "idem-buy-001" });

    expect(second.order.id).toBe(first.order.id);
    expect(testState.orders.size).toBe(1);
    expect(testState.ledgerChanges.filter((entry) => entry.reason === "order_freeze")).toHaveLength(1);
    expectBalance(101, "USDT", "9199.2", "800.8");
  });

  it("TC-E2E-RACE-02: 重复撤单不得因异步清理窗口造成二次退款或负冻结", async () => {
    const engine = await getMatchingEngine();

    const order = await engine.submitOrder({ userId: 101, subAccountId: 1, symbol: "BTCUSDT", side: "buy", type: "limit", price: "80000", quantity: "0.01" });
    expectBalance(101, "USDT", "9199.2", "800.8");

    const first = await engine.cancelOrder(101, order.order.id);
    const second = await engine.cancelOrder(101, order.order.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.status).toBe("canceled");
    expect(second.status).toBe("canceled");
    expectBalance(101, "USDT", "10000", "0");
    assertNoNegativeBalances(testState.balances);
  });
});
