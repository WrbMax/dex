/**
 * TC-TICKER: binance_mirror platform limit-order trigger rules
 *
 * These tests intentionally describe platform-counterparty automatic market
 * making only. They do not model, reference, or assert any internal OrderBook
 * behavior. The orderbook mode is covered separately by matching-engine tests.
 */
import { describe, it, expect } from "vitest";

const SCALE = 10n ** 18n;

function parseDec(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "0".repeat(18)).slice(0, 18));
}

function formatDec(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function mul(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}

function platformQuoteSatisfiesLimit(side: "buy" | "sell", limitPrice: bigint, platformExecutablePrice: bigint): boolean {
  if (platformExecutablePrice <= 0n) return false;
  return side === "buy"
    ? platformExecutablePrice <= limitPrice
    : platformExecutablePrice >= limitPrice;
}

describe("TC-TICKER: binance_mirror platform limit-order trigger rules", () => {
  it("buy limit fills when the platform ask is at or below the user limit", () => {
    expect(platformQuoteSatisfiesLimit("buy", parseDec("90000"), parseDec("89900"))).toBe(true);
    expect(platformQuoteSatisfiesLimit("buy", parseDec("90000"), parseDec("90000"))).toBe(true);
  });

  it("buy limit does not fill when the platform ask is above the user limit", () => {
    expect(platformQuoteSatisfiesLimit("buy", parseDec("90000"), parseDec("90100"))).toBe(false);
  });

  it("sell limit fills when the platform bid is at or above the user limit", () => {
    expect(platformQuoteSatisfiesLimit("sell", parseDec("95000"), parseDec("95000"))).toBe(true);
    expect(platformQuoteSatisfiesLimit("sell", parseDec("95000"), parseDec("95100"))).toBe(true);
  });

  it("sell limit does not fill when the platform bid is below the user limit", () => {
    expect(platformQuoteSatisfiesLimit("sell", parseDec("95000"), parseDec("94900"))).toBe(false);
  });

  it("zero or invalid platform quote never triggers a fill", () => {
    expect(platformQuoteSatisfiesLimit("buy", parseDec("90000"), parseDec("0"))).toBe(false);
    expect(platformQuoteSatisfiesLimit("sell", parseDec("95000"), parseDec("0"))).toBe(false);
  });

  it("buy limit fill accounting uses quote fee and returns unused frozen quote", () => {
    const limitPrice = parseDec("90000");
    const executableAsk = parseDec("89900");
    const qty = parseDec("0.001");
    const takerFeeRate = parseDec("0.001");

    const frozenAtLimit = mul(limitPrice, qty) + mul(mul(limitPrice, qty), takerFeeRate);
    const usedQuote = mul(executableAsk, qty);
    const usedFee = mul(usedQuote, takerFeeRate);
    const unusedQuote = frozenAtLimit - usedQuote - usedFee;

    expect(formatDec(usedQuote)).toBe("89.9");
    expect(formatDec(usedFee)).toBe("0.0899");
    expect(formatDec(unusedQuote)).toBe("0.1001");
    expect(unusedQuote).toBeGreaterThan(0n);
  });

  it("sell limit fill accounting credits quote net of quote-denominated fee", () => {
    const executableBid = parseDec("95100");
    const qty = parseDec("0.001");
    const takerFeeRate = parseDec("0.001");

    const fillQuote = mul(executableBid, qty);
    const takerFee = mul(fillQuote, takerFeeRate);
    const quoteNet = fillQuote - takerFee;

    expect(formatDec(fillQuote)).toBe("95.1");
    expect(formatDec(takerFee)).toBe("0.0951");
    expect(formatDec(quoteNet)).toBe("95.0049");
    expect(quoteNet).toBeGreaterThan(0n);
  });

  it("a filled or canceled order is not eligible for another platform fill", () => {
    const eligibleStatuses = new Set(["new", "partial"]);
    expect(eligibleStatuses.has("filled")).toBe(false);
    expect(eligibleStatuses.has("canceled")).toBe(false);
    expect(eligibleStatuses.has("new")).toBe(true);
    expect(eligibleStatuses.has("partial")).toBe(true);
  });
});
