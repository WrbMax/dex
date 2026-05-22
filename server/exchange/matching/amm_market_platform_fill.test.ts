import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");

describe("AMM/binance_mirror market order platform-liquidity routing", () => {
  const engineSource = readFileSync(resolve(ROOT, "server/exchange/matching/engine.ts"), "utf8");
  const mirrorBranchStart = engineSource.indexOf('if (marketMode === "binance_mirror")');
  const firstInternalSubmit = engineSource.indexOf("eng.book.submit", mirrorBranchStart);
  const preInternalBookBranch = engineSource.slice(mirrorBranchStart, firstInternalSubmit);

  it("routes market buys to platform liquidity before any internal order-book submission", () => {
    const marketBuyStart = preInternalBookBranch.indexOf("if (isMarketBuy)");
    const marketBuyEnd = preInternalBookBranch.indexOf("// For market sell:", marketBuyStart);
    const marketBuyBlock = preInternalBookBranch.slice(marketBuyStart, marketBuyEnd);

    expect(marketBuyStart).toBeGreaterThanOrEqual(0);
    expect(marketBuyBlock).toContain("sellerOrderId: 0");
    expect(marketBuyBlock).toContain("sellerUserId: 0");
    expect(marketBuyBlock).toContain("return { order: filledRow!, fills: [] }");
    expect(marketBuyBlock).not.toContain("eng.book.bestAsk()");
    expect(marketBuyBlock).not.toContain("eng.book.submit");
  });

  it("routes market sells to platform liquidity before any internal order-book submission", () => {
    const marketSellStart = preInternalBookBranch.indexOf('const isMarketSell = input.type === "market" && input.side === "sell"');
    const marketSellEnd = preInternalBookBranch.indexOf("// Try internal book matching first", marketSellStart);
    const marketSellBlock = preInternalBookBranch.slice(marketSellStart, marketSellEnd);

    expect(marketSellStart).toBeGreaterThanOrEqual(0);
    expect(marketSellBlock).toContain("buyerOrderId: 0");
    expect(marketSellBlock).toContain("buyerUserId: 0");
    expect(marketSellBlock).toContain("return { order: filledRow!, fills: [] }");
    expect(marketSellBlock).not.toContain("eng.book.bestBid()");
    expect(marketSellBlock).not.toContain("eng.book.submit");
  });

  it("keeps the internal order-book path after terminal market-order platform fills", () => {
    expect(mirrorBranchStart).toBeGreaterThanOrEqual(0);
    expect(firstInternalSubmit).toBeGreaterThan(mirrorBranchStart);
    expect(preInternalBookBranch).toContain("AMM/binance_mirror market orders must not consume user resting orders");
  });
});

describe("Admin platform-liquidity display", () => {
  it("labels userId=0 counterparties as platform liquidity in both admin pages", () => {
    const modernAdmin = readFileSync(resolve(ROOT, "client/src/pages/Admin.tsx"), "utf8");
    const legacyAdmin = readFileSync(resolve(ROOT, "client/src/pages/AdminPanel.tsx"), "utf8");

    expect(modernAdmin).toContain("平台流动性");
    expect(modernAdmin).toContain("t.buyerUserId === 0");
    expect(modernAdmin).toContain("t.sellerUserId === 0");
    expect(legacyAdmin).toContain("平台流动性");
  });
});
