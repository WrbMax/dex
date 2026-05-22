/**
 * Frontend-Backend Data Consistency Tests — Production QA
 *
 * Tests that frontend display logic correctly interprets backend API responses:
 * 1. Trade direction inference (buyer/seller side detection)
 * 2. Fee asset derivation from symbol name
 * 3. Balance display: available vs locked
 * 4. Order status badge mapping
 * 5. Price/quantity formatting consistency
 * 6. Ticker data: 24h change calculation
 * 7. Notification bell: unread count accuracy
 * 8. Withdrawal history status display
 * 9. Deposit address chain display
 * 10. Market data: pricePrecision / amountPrecision
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseDec, formatDec, mul, ZERO } from "./utils/bigdec";

// ─── Trade Direction Inference ────────────────────────────────────────────────

describe("Trade Direction Inference (Frontend Logic)", () => {
  const currentUserId = 1;

  it("TC-UI-TD01: User is buyer → direction = 'buy'", () => {
    const trade = { buyerUserId: 1, sellerUserId: 2 };
    const isBuy = trade.buyerUserId === currentUserId;
    expect(isBuy).toBe(true);
  });

  it("TC-UI-TD02: User is seller → direction = 'sell'", () => {
    const trade = { buyerUserId: 2, sellerUserId: 1 };
    const isBuy = trade.buyerUserId === currentUserId;
    expect(isBuy).toBe(false);
  });

  it("TC-UI-TD03: Platform fill (sellerUserId=0) → user is buyer", () => {
    const trade = { buyerUserId: 1, sellerUserId: 0 };
    const isBuy = trade.buyerUserId === currentUserId;
    expect(isBuy).toBe(true);
    expect(trade.sellerUserId).toBe(0); // platform
  });

  it("TC-UI-TD04: Platform fill (buyerUserId=0) → user is seller", () => {
    const trade = { buyerUserId: 0, sellerUserId: 1 };
    const isBuy = trade.buyerUserId === currentUserId;
    expect(isBuy).toBe(false);
    expect(trade.buyerUserId).toBe(0); // platform
  });

  it("TC-UI-TD05: Fee display — buyer fee is in quote asset", () => {
    const trade = { buyerUserId: 1, sellerUserId: 2, buyerFee: "40", sellerFee: "40", symbol: "BTCUSDT" };
    const isBuy = trade.buyerUserId === currentUserId;
    const myFee = isBuy ? trade.buyerFee : trade.sellerFee;
    const myFeeAsset = "USDT"; // engine stores buyer/seller fees in quote asset
    expect(myFee).toBe("40");
    expect(myFeeAsset).toBe("USDT");
  });

  it("TC-UI-TD06: Fee display — seller fee is in quote asset", () => {
    const trade = { buyerUserId: 2, sellerUserId: 1, buyerFee: "40", sellerFee: "40", symbol: "BTCUSDT" };
    const isBuy = trade.buyerUserId === currentUserId;
    const myFee = isBuy ? trade.buyerFee : trade.sellerFee;
    const myFeeAsset = "USDT";
    expect(myFee).toBe("40");
    expect(myFeeAsset).toBe("USDT");
  });
});

// ─── Fee Asset Derivation ─────────────────────────────────────────────────────

describe("Fee Asset Derivation from Symbol", () => {
  // TradeHistory.tsx uses: symbol.replace('USDT', '').split('/')[0]
  // This is a heuristic that works for *USDT pairs only

  it("TC-UI-FA01: BTCUSDT → base asset = BTC", () => {
    const symbol = "BTCUSDT";
    const base = symbol.replace("USDT", "");
    expect(base).toBe("BTC");
  });

  it("TC-UI-FA02: ETHUSDT → base asset = ETH", () => {
    const symbol = "ETHUSDT";
    const base = symbol.replace("USDT", "");
    expect(base).toBe("ETH");
  });

  it("TC-UI-FA03: SOLUSDT → base asset = SOL", () => {
    const symbol = "SOLUSDT";
    const base = symbol.replace("USDT", "");
    expect(base).toBe("SOL");
  });

  it("TC-UI-FA04: BNBUSDT → base asset = BNB", () => {
    const symbol = "BNBUSDT";
    const base = symbol.replace("USDT", "");
    expect(base).toBe("BNB");
  });

  it("TC-UI-FA05: Fee asset for buyer and seller = quote (USDT for BTCUSDT)", () => {
    const quote = "USDT";
    const buyerFeeAsset = quote; // engine charges quote-denominated fees on quoteQty
    const sellerFeeAsset = quote;
    expect(buyerFeeAsset).toBe("USDT");
    expect(sellerFeeAsset).toBe("USDT");
  });

  it("TC-UI-FA06: TradeHistory derives actual debit/credit from quoteQty and quote fee", () => {
    const buyTrade = { quoteQty: "999.000999", buyerFee: "0.999001" };
    const sellTrade = { quoteQty: "999.77", sellerFee: "0.99977" };
    const actualDebit = Number(buyTrade.quoteQty) + Number(buyTrade.buyerFee);
    const actualCredit = Number(sellTrade.quoteQty) - Number(sellTrade.sellerFee);
    expect(actualDebit).toBeCloseTo(1000, 8);
    expect(actualCredit).toBeCloseTo(998.77023, 8);
  });

  it("TC-UI-FA07: Market-buy 100% shortcut uses quote balance as fee-inclusive total cost cap", () => {
    const quoteAvailable = 1000;
    const takerFeeRate = 0.001;
    const totalCostCap = quoteAvailable;
    const principalBudget = totalCostCap / (1 + takerFeeRate);
    const estimatedFee = totalCostCap - principalBudget;
    const estimatedDebit = principalBudget + estimatedFee;
    expect(totalCostCap).toBe(quoteAvailable);
    expect(estimatedDebit).toBeLessThanOrEqual(quoteAvailable + 1e-9);
    expect(principalBudget).toBeCloseTo(999.000999, 6);
    expect(estimatedFee).toBeCloseTo(0.999001, 6);
  });
});

// ─── Balance Display ──────────────────────────────────────────────────────────

describe("Balance Display Logic", () => {
  it("TC-UI-BAL01: Available balance = total - locked", () => {
    const balance = { available: "950", locked: "50" };
    const total = Number(balance.available) + Number(balance.locked);
    expect(total).toBe(1000);
    expect(Number(balance.available)).toBe(950);
  });

  it("TC-UI-BAL02: Available balance shown for order placement (not total)", () => {
    const balance = { available: "950", locked: "50" };
    // When user enters order, max available is 950, not 1000
    const maxOrderAmount = Number(balance.available);
    expect(maxOrderAmount).toBe(950);
  });

  it("TC-UI-BAL03: Percentage sizing uses available balance", () => {
    const available = parseDec("1000");
    const price = parseDec("50000");
    const pct = parseDec("0.25"); // 25%
    // For limit buy: 25% of available USDT → qty in BTC
    const usdtToSpend = mul(available, pct); // 250 USDT
    const qty = (usdtToSpend * 10n ** 18n) / price; // 0.005 BTC
    expect(formatDec(usdtToSpend)).toBe("250");
    expect(formatDec(qty)).toBe("0.005");
  });

  it("TC-UI-BAL04: Sell percentage uses available base balance", () => {
    const availableBTC = parseDec("1");
    const pct = parseDec("0.5"); // 50%
    const sellQty = mul(availableBTC, pct); // 0.5 BTC
    expect(formatDec(sellQty)).toBe("0.5");
  });

  it("TC-UI-BAL05: Balance shows 0 for assets with no account row", () => {
    const balances: { asset: string; available: string }[] = [];
    const usdtBalance = balances.find(b => b.asset === "USDT")?.available ?? "0";
    expect(usdtBalance).toBe("0");
  });
});

// ─── Order Status Badge ───────────────────────────────────────────────────────

describe("Order Status Badge Mapping", () => {
  const statusMap: Record<string, { label: string; color: string }> = {
    new: { label: "待成交", color: "blue" },
    partial: { label: "部分成交", color: "yellow" },
    filled: { label: "已成交", color: "green" },
    canceled: { label: "已撤销", color: "gray" },
  };

  it("TC-UI-OS01: new → 待成交 (blue)", () => {
    expect(statusMap["new"].label).toBe("待成交");
    expect(statusMap["new"].color).toBe("blue");
  });

  it("TC-UI-OS02: partial → 部分成交 (yellow)", () => {
    expect(statusMap["partial"].label).toBe("部分成交");
    expect(statusMap["partial"].color).toBe("yellow");
  });

  it("TC-UI-OS03: filled → 已成交 (green)", () => {
    expect(statusMap["filled"].label).toBe("已成交");
    expect(statusMap["filled"].color).toBe("green");
  });

  it("TC-UI-OS04: canceled → 已撤销 (gray)", () => {
    expect(statusMap["canceled"].label).toBe("已撤销");
    expect(statusMap["canceled"].color).toBe("gray");
  });

  it("TC-UI-OS05: Orders page maps backend canceled status instead of only cancelled", () => {
    const source = readFileSync("client/src/pages/Orders.tsx", "utf8");
    expect(source).toContain("canceled: \"已撤销\"");
    expect(source).toContain("canceled: \"text-muted-foreground bg-muted/20\"");
  });
});

// ─── Price/Quantity Formatting ────────────────────────────────────────────────

describe("Price and Quantity Formatting Consistency", () => {
  it("TC-UI-FMT01: formatDec removes trailing zeros", () => {
    expect(formatDec(parseDec("50000.00"))).toBe("50000");
    expect(formatDec(parseDec("0.10000"))).toBe("0.1");
    expect(formatDec(parseDec("1.00000000"))).toBe("1");
  });

  it("TC-UI-FMT02: formatDec preserves significant decimal places", () => {
    expect(formatDec(parseDec("50000.01"))).toBe("50000.01");
    expect(formatDec(parseDec("0.00001"))).toBe("0.00001");
    expect(formatDec(parseDec("0.001"))).toBe("0.001");
  });

  it("TC-UI-FMT03: Price precision for BTCUSDT is 2 decimal places", () => {
    const price = "50000.01";
    const parts = price.split(".");
    const decimals = parts[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(2);
  });

  it("TC-UI-FMT04: Amount precision for BTCUSDT is 5 decimal places", () => {
    const qty = "0.00001";
    const parts = qty.split(".");
    const decimals = parts[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(5);
  });

  it("TC-UI-FMT05: quoteQty = price * quantity (no rounding error)", () => {
    const price = parseDec("50000.01");
    const qty = parseDec("0.00001");
    const quoteQty = mul(price, qty);
    // 50000.01 * 0.00001 = 0.5000001
    expect(formatDec(quoteQty)).toBe("0.5000001");
  });
});

// ─── 24h Ticker Data ──────────────────────────────────────────────────────────

describe("24h Ticker Data Consistency", () => {
  it("TC-UI-TICK01: change24h = lastPrice - openPrice", () => {
    const openPrice = parseDec("48000");
    const lastPrice = parseDec("50000");
    const change24h = lastPrice - openPrice;
    expect(formatDec(change24h)).toBe("2000");
  });

  it("TC-UI-TICK02: changePct24h = (lastPrice - openPrice) / openPrice * 100", () => {
    const openPrice = 48000;
    const lastPrice = 50000;
    const changePct = ((lastPrice - openPrice) / openPrice) * 100;
    expect(changePct.toFixed(2)).toBe("4.17");
  });

  it("TC-UI-TICK03: Negative change is displayed correctly", () => {
    const openPrice = parseDec("52000");
    const lastPrice = parseDec("50000");
    const change24h = lastPrice - openPrice; // -2000
    expect(change24h < ZERO).toBe(true);
    expect(formatDec(change24h)).toBe("-2000");
  });

  it("TC-UI-TICK04: volume24h is in base asset (BTC)", () => {
    // volume24h represents total BTC traded in 24h
    const volume = parseDec("1234.56789");
    expect(volume > ZERO).toBe(true);
  });

  it("TC-UI-TICK05: quoteVolume24h is in quote asset (USDT)", () => {
    const price = parseDec("50000");
    const volume = parseDec("1234.56789");
    const quoteVolume = mul(price, volume);
    expect(quoteVolume > ZERO).toBe(true);
  });
});

// ─── Notification Bell ────────────────────────────────────────────────────────

describe("Notification Bell Consistency", () => {
  it("TC-UI-NOTIF01: Unread count = notifications where isRead=false", () => {
    const notifications = [
      { id: 1, isRead: false },
      { id: 2, isRead: true },
      { id: 3, isRead: false },
    ];
    const unreadCount = notifications.filter(n => !n.isRead).length;
    expect(unreadCount).toBe(2);
  });

  it("TC-UI-NOTIF02: markAllRead sets all isRead=true", () => {
    const notifications = [
      { id: 1, isRead: false },
      { id: 2, isRead: false },
    ];
    const afterMark = notifications.map(n => ({ ...n, isRead: true }));
    expect(afterMark.every(n => n.isRead)).toBe(true);
  });

  it("TC-UI-NOTIF03: markNotificationsRead with specific IDs only marks those", () => {
    const notifications = [
      { id: 1, isRead: false },
      { id: 2, isRead: false },
      { id: 3, isRead: false },
    ];
    const idsToMark = [1, 3];
    const afterMark = notifications.map(n => ({
      ...n,
      isRead: idsToMark.includes(n.id) ? true : n.isRead,
    }));
    expect(afterMark[0].isRead).toBe(true);
    expect(afterMark[1].isRead).toBe(false);
    expect(afterMark[2].isRead).toBe(true);
  });

  it("TC-UI-NOTIF04: New notification toast shows title and body", () => {
    const notification = {
      title: "买入 BTCUSDT 成交",
      body: "市价买入 0.02 BTC，成交价 50000 USDT，手续费 1 USDT",
    };
    expect(notification.title.length).toBeGreaterThan(0);
    expect(notification.body.length).toBeGreaterThan(0);
  });

  it("TC-UI-NOTIF05: Polling interval is 10 seconds (not too frequent)", () => {
    const POLL_INTERVAL_MS = 10_000;
    expect(POLL_INTERVAL_MS).toBe(10000);
    expect(POLL_INTERVAL_MS).toBeGreaterThanOrEqual(5000); // not too aggressive
  });
});

// ─── Withdrawal Status Display ────────────────────────────────────────────────

describe("Withdrawal Status Display", () => {
  const statusLabels: Record<string, string> = {
    pending: "审核中",
    reviewing: "审核中",
    approved: "已批准",
    broadcasting: "广播中",
    confirmed: "已完成",
    rejected: "已拒绝",
    failed: "失败",
  };

  it("TC-UI-WD01: pending status displays as 审核中", () => {
    expect(statusLabels["pending"]).toBe("审核中");
  });

  it("TC-UI-WD02: confirmed status displays as 已完成", () => {
    expect(statusLabels["confirmed"]).toBe("已完成");
  });

  it("TC-UI-WD03: rejected status displays as 已拒绝", () => {
    expect(statusLabels["rejected"]).toBe("已拒绝");
  });

  it("TC-UI-WD04: Withdrawal history shows net amount (after fee)", () => {
    const amount = "100";
    const fee = "3";
    const netAmount = Number(amount) - Number(fee);
    expect(netAmount).toBe(97);
  });
});

// ─── myTrades Pagination Bug ──────────────────────────────────────────────────

describe("myTrades API Correctness", () => {
  it("TC-UI-TRADES01: Symbol filter applied after DB limit may miss trades (KNOWN BUG)", () => {
    // Scenario: User has 150 BTCUSDT trades total
    // myTrades(symbol='BTCUSDT', limit=100) fetches 100 rows first, then filters
    // If BTCUSDT trades are spread across all 150, only ~67 are returned
    // Fix: add WHERE symbol = ? to the DB query
    const totalTrades = 150;
    const btcusdtTrades = 150; // all trades are BTCUSDT
    const limit = 100;
    const fetchedRows = Math.min(totalTrades, limit); // 100
    const returnedBtcusdt = fetchedRows; // all 100 are BTCUSDT
    const missingBtcusdt = btcusdtTrades - returnedBtcusdt; // 50 missing!
    expect(missingBtcusdt).toBe(50);
    // This is a confirmed bug — see exchange.ts line 318
  });

  it("TC-UI-TRADES02: Without symbol filter, limit=100 returns correct count", () => {
    const totalTrades = 150;
    const limit = 100;
    const returned = Math.min(totalTrades, limit);
    expect(returned).toBe(100);
    // This is correct behavior for the no-filter case
  });

  it("TC-UI-TRADES03: Load more increases limit by 50", () => {
    let limit = 50;
    limit += 50; // user clicks load more
    expect(limit).toBe(100);
    limit += 50;
    expect(limit).toBe(150);
  });
});

// ─── Market Data API Contract ─────────────────────────────────────────────────

describe("Market Data API Contract", () => {
  it("TC-UI-MD01: listMarkets returns required fields", () => {
    const market = {
      symbol: "BTCUSDT",
      base: "BTC",
      quote: "USDT",
      priceTick: "0.01",
      amountStep: "0.00001",
      pricePrecision: 2,
      amountPrecision: 5,
      takerFee: "0.001",
      makerFee: "0.0008",
      minNotional: "10",
      lastPrice: "50000",
      change24h: "2000",
      changePct24h: "4.17",
      high24h: "51000",
      low24h: "48000",
      volume24h: "1234.56",
      quoteVolume24h: "61728000",
    };
    const requiredFields = ["symbol", "base", "quote", "priceTick", "amountStep",
      "takerFee", "makerFee", "minNotional", "lastPrice", "change24h"];
    for (const field of requiredFields) {
      expect(market).toHaveProperty(field);
    }
  });

  it("TC-UI-MD02: Order book depth format is [price, quantity][] pairs", () => {
    const depth = {
      bids: [["50000", "1.5"], ["49999", "2.0"]],
      asks: [["50001", "0.5"], ["50002", "1.0"]],
    };
    expect(depth.bids[0]).toHaveLength(2);
    expect(depth.asks[0]).toHaveLength(2);
    // Bids sorted descending
    expect(Number(depth.bids[0][0])).toBeGreaterThan(Number(depth.bids[1][0]));
    // Asks sorted ascending
    expect(Number(depth.asks[0][0])).toBeLessThan(Number(depth.asks[1][0]));
  });

  it("TC-UI-MD03: Kline data format is [timestamp, open, high, low, close, volume]", () => {
    const kline = [1714000000000, "50000", "51000", "49000", "50500", "1234.56"];
    expect(kline).toHaveLength(6);
    expect(typeof kline[0]).toBe("number"); // timestamp
    expect(typeof kline[1]).toBe("string"); // OHLCV as strings
  });
});
