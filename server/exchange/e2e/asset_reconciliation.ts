import { expect } from "vitest";
import { formatDec, mul, parseDec, ZERO } from "../utils/bigdec";

type BalanceSnapshot = { available: bigint; locked: bigint };

type RuntimeTrade = {
  price: string;
  quantity: string;
  quoteQty: string;
  buyerOrderId?: number;
  sellerOrderId?: number;
  buyerFee?: string;
  sellerFee?: string;
};

type RuntimeOrder = {
  id: number;
  side: "buy" | "sell";
  status: string;
  filledQty?: string;
  quoteFilled?: string;
  avgPrice?: string;
};

export function assertNoNegativeBalances(balances: Map<string, BalanceSnapshot>) {
  for (const [key, snapshot] of balances.entries()) {
    expect(snapshot.available, `${key} available must not be negative`).toBeGreaterThanOrEqual(ZERO);
    expect(snapshot.locked, `${key} locked must not be negative`).toBeGreaterThanOrEqual(ZERO);
  }
}

export function assertTradeQuoteMath(trades: RuntimeTrade[]) {
  for (const trade of trades) {
    const expectedQuote = mul(parseDec(trade.price), parseDec(trade.quantity));
    expect(formatDec(expectedQuote), `trade quoteQty must equal price * quantity for price=${trade.price}, quantity=${trade.quantity}`).toBe(trade.quoteQty);
  }
}

export function aggregateTradesForOrder(orderId: number, trades: RuntimeTrade[]) {
  let filledQty = ZERO;
  let quoteFilled = ZERO;
  let buyerFee = ZERO;
  let sellerFee = ZERO;

  for (const trade of trades) {
    if (trade.buyerOrderId === orderId || trade.sellerOrderId === orderId) {
      filledQty += parseDec(trade.quantity);
      quoteFilled += parseDec(trade.quoteQty);
    }
    if (trade.buyerOrderId === orderId) buyerFee += parseDec(trade.buyerFee ?? "0");
    if (trade.sellerOrderId === orderId) sellerFee += parseDec(trade.sellerFee ?? "0");
  }

  const avgPrice = filledQty > ZERO ? (quoteFilled * 10n ** 18n) / filledQty : ZERO;
  return { filledQty, quoteFilled, avgPrice, buyerFee, sellerFee };
}

export function assertOrderAggregatesMatchTrades(order: RuntimeOrder, trades: RuntimeTrade[]) {
  const aggregate = aggregateTradesForOrder(order.id, trades);
  expect(formatDec(aggregate.filledQty), `order ${order.id} filledQty must match trades`).toBe(order.filledQty ?? "0");
  expect(formatDec(aggregate.quoteFilled), `order ${order.id} quoteFilled must match trades`).toBe(order.quoteFilled ?? "0");
  if (aggregate.filledQty > ZERO) {
    expect(formatDec(aggregate.avgPrice), `order ${order.id} avgPrice must match trades`).toBe(order.avgPrice ?? "0");
  }
}

export function assertAllOrderAggregatesMatchTrades(orders: Iterable<RuntimeOrder>, trades: RuntimeTrade[]) {
  for (const order of orders) {
    if (["filled", "partial", "canceled"].includes(order.status)) {
      assertOrderAggregatesMatchTrades(order, trades);
    }
  }
}

export function assertMarketBuyTotalCostWithinBudget(orderId: number, trades: RuntimeTrade[], budget: string) {
  const aggregate = aggregateTradesForOrder(orderId, trades);
  const totalCost = aggregate.quoteFilled + aggregate.buyerFee;
  expect(totalCost, `market buy order ${orderId} quoteFilled + buyerFee must be <= input budget`).toBeLessThanOrEqual(parseDec(budget));
  return totalCost;
}

export function assertTerminalOrderHasNoLockedBalance(balance: BalanceSnapshot, assetLabel: string) {
  expect(formatDec(balance.locked), `${assetLabel} locked balance must be released after terminal order`).toBe("0");
}
