import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(join(__dirname, "engine.ts"), "utf8");

describe("Limit order platform AMM executable-price guard", () => {
  it("filters ticker-triggered platform fills by executable ask/bid instead of ticker lastPrice", () => {
    const filterStart = engineSource.indexOf("// Platform AMM fills must be gated by executable bookTicker quotes");
    const filterEnd = engineSource.indexOf("for (const order of toFill)", filterStart);
    expect(filterStart).toBeGreaterThan(-1);
    expect(filterEnd).toBeGreaterThan(filterStart);

    const filterBlock = engineSource.slice(filterStart, filterEnd);
    expect(filterBlock).toContain('await this.fetchFreshBookTickerPrice(symbol, "buy")');
    expect(filterBlock).toContain('await this.fetchFreshBookTickerPrice(symbol, "sell")');
    expect(filterBlock).toContain("return executableAskPrice !== null && executableAskPrice <= limitPrice");
    expect(filterBlock).toContain("return executableBidPrice !== null && executableBidPrice >= limitPrice");
    expect(filterBlock).not.toContain("return price <= limitPrice");
    expect(filterBlock).not.toContain("return price >= limitPrice");
  });

  it("records platform fills at the executable quote, never at ticker lastPrice or limitPrice", () => {
    const fillStart = engineSource.indexOf("// Fill at the executable platform quote, not ticker lastPrice or limitPrice.");
    const fillEnd = engineSource.indexOf("const fillQty = remaining;", fillStart);
    expect(fillStart).toBeGreaterThan(-1);
    expect(fillEnd).toBeGreaterThan(fillStart);

    const fillBlock = engineSource.slice(fillStart, fillEnd);
    expect(fillBlock).toContain('const freshFillPrice = await this.fetchFreshBookTickerPrice(symbol, fresh.side as "buy" | "sell")');
    expect(fillBlock).toContain("fillPrice = freshFillPrice");
    expect(fillBlock).toContain('if (fresh.side === "buy" && fillPrice > limitPrice) return;');
    expect(fillBlock).toContain('if (fresh.side === "sell" && fillPrice < limitPrice) return;');
    expect(fillBlock).not.toContain("const fillPrice = price");
    expect(fillBlock).not.toContain("const fillPrice = limitPrice");
  });

  it("keeps temporary quote-fetch failures non-destructive for resting orders", () => {
    const fillStart = engineSource.indexOf("let fillPrice: bigint;");
    const fillEnd = engineSource.indexOf("if (fresh.side === \"buy\" && fillPrice > limitPrice) return;", fillStart);
    expect(fillStart).toBeGreaterThan(-1);
    expect(fillEnd).toBeGreaterThan(fillStart);

    const quoteBlock = engineSource.slice(fillStart, fillEnd);
    expect(quoteBlock).toContain("catch (quoteErr)");
    expect(quoteBlock).toContain("skip platform fill");
    expect(quoteBlock).toContain("return;");
    expect(quoteBlock).not.toContain("eng.book.cancel");
    expect(quoteBlock).not.toContain('status: "canceled"');
  });

  it("keeps binance_mirror submitOrder limit orders out of the internal order book", () => {
    const ammStart = engineSource.indexOf("// ── AUTO MARKET-MAKING LIMIT PATH");
    const ammEnd = engineSource.indexOf("// ── ORDERBOOK PATH", ammStart);
    expect(ammStart).toBeGreaterThan(-1);
    expect(ammEnd).toBeGreaterThan(ammStart);

    const ammSubmitBlock = engineSource.slice(ammStart, ammEnd);
    expect(ammSubmitBlock).toContain("platform-counterparty trading only");
    expect(ammSubmitBlock).toContain("platform userId=0");
    expect(ammSubmitBlock).not.toContain("eng.book.submit");
    expect(ammSubmitBlock).not.toContain("settleFills");
    expect(ammSubmitBlock).not.toContain("selfFills");
  });

  it("keeps ticker-triggered binance_mirror fills out of the internal order book", () => {
    const tickerStart = engineSource.indexOf("// binance_mirror ticker execution is platform-counterparty only.");
    const tickerEnd = engineSource.indexOf("this.lastPrices.set(symbol, fillPrice);", tickerStart);
    expect(tickerStart).toBeGreaterThan(-1);
    expect(tickerEnd).toBeGreaterThan(tickerStart);

    const tickerBlock = engineSource.slice(tickerStart, tickerEnd);
    expect(tickerBlock).toContain("platform userId=0");
    expect(tickerBlock).not.toContain("eng.book.submit");
    expect(tickerBlock).not.toContain("eng.book.cancel");
    expect(tickerBlock).not.toContain("settleFills");
  });

  it("loads resident orders into memory only for pure orderbook markets", () => {
    const loadStart = engineSource.indexOf("const currentMarket = getMarket(symbol);");
    const loadEnd = engineSource.indexOf("eng.book.load", loadStart) + "eng.book.load".length;
    expect(loadStart).toBeGreaterThan(-1);
    expect(loadEnd).toBeGreaterThan(loadStart);

    const loadBlock = engineSource.slice(loadStart, loadEnd);
    expect(loadBlock).toContain('(currentMarket?.marketMode ?? "binance_mirror") !== "orderbook"');
    expect(loadBlock).toContain("skipped in-memory order book load");
    expect(loadBlock).toContain("continue;");
  });
});
