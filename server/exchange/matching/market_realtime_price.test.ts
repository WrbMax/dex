import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(join(__dirname, "engine.ts"), "utf8");

describe("Market order realtime executable price guard", () => {
  it("uses Binance bookTicker ask for platform market buys instead of cached lastPrice", () => {
    expect(engineSource).toContain("fetchFreshBookTickerPrice(symbol: string, side: \"buy\" | \"sell\")");
    expect(engineSource).toContain("/api/v3/ticker/bookTicker?symbol=");
    expect(engineSource).toContain("const raw = side === \"buy\" ? bt.askPrice : bt.bidPrice");

    const marketBuyStart = engineSource.indexOf("if (isMarketBuy) {");
    const marketBuyEnd = engineSource.indexOf("// For market sell: AMM/binance_mirror uses platform liquidity directly.");
    expect(marketBuyStart).toBeGreaterThan(-1);
    expect(marketBuyEnd).toBeGreaterThan(marketBuyStart);

    const marketBuyBlock = engineSource.slice(marketBuyStart, marketBuyEnd);
    expect(marketBuyBlock).toContain('await this.fetchFreshBookTickerPrice(input.symbol, "buy")');
    expect(marketBuyBlock).not.toContain("this.lastPrices.get(input.symbol)");
    expect(engineSource).toContain("const quoteFeeInclusiveBudget = isMarketBuy ? qty : ZERO");
    expect(engineSource).toContain("const quotePrincipalBudget = isMarketBuy");
    expect(engineSource).toContain("? (isMarketBuy ? quoteFeeInclusiveBudget : orderNotional + mul(orderNotional, takerFeeRate))");
    expect(marketBuyBlock).toContain("bookQty = (quotePrincipalBudget * 10n ** 18n) / bestAskPrice");
    expect(marketBuyBlock).toContain("const unusedQuote = quoteFeeInclusiveBudget > consumedQuote ? quoteFeeInclusiveBudget - consumedQuote : ZERO");
  });

  it("uses Binance bookTicker bid for platform market sells instead of cached lastPrice", () => {
    const marketSellStart = engineSource.indexOf("if (isMarketSell) {");
    const marketSellEnd = engineSource.indexOf("// Try internal book matching first", marketSellStart);
    expect(marketSellStart).toBeGreaterThan(-1);
    expect(marketSellEnd).toBeGreaterThan(marketSellStart);

    const marketSellBlock = engineSource.slice(marketSellStart, marketSellEnd);
    expect(marketSellBlock).toContain('await this.fetchFreshBookTickerPrice(input.symbol, "sell")');
    expect(marketSellBlock).not.toContain("this.lastPrices.get(input.symbol)");
  });
});
