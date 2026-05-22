import { describe, it, expect } from "vitest";
import {
  isHexAddress,
  normalizeAddress,
  assertSupportedChain,
} from "./address";
import {
  parseDec,
  formatDec,
  add,
  sub,
  mul,
  div,
  floorStep,
  ZERO,
  SCALE,
} from "./bigdec";

describe("address utils", () => {
  it("accepts valid 20-byte hex addresses", () => {
    expect(isHexAddress("0x" + "a".repeat(40))).toBe(true);
    expect(isHexAddress("0xAbCdEf0123456789012345678901234567890123")).toBe(true);
  });
  it("rejects malformed inputs", () => {
    expect(isHexAddress("0x123")).toBe(false);
    expect(isHexAddress("abc")).toBe(false);
    expect(isHexAddress("0xzzzz" + "a".repeat(36))).toBe(false);
  });
  it("normalizes to lowercase", () => {
    expect(normalizeAddress("0xABCDEF0123456789012345678901234567890123")).toBe(
      "0xabcdef0123456789012345678901234567890123"
    );
  });
  it("throws on unsupported chain", () => {
    expect(() => assertSupportedChain("tron")).toThrow();
    expect(() => assertSupportedChain("erc20")).not.toThrow();
    expect(() => assertSupportedChain("bep20")).not.toThrow();
  });
});

describe("bigdec — fixed-point math at scale=18", () => {
  it("round-trips parseDec / formatDec without precision loss", () => {
    expect(formatDec(parseDec("1.234567890123456789"))).toBe("1.234567890123456789");
    expect(formatDec(parseDec("0"))).toBe("0");
    expect(formatDec(parseDec("12345"))).toBe("12345");
    expect(SCALE).toBe(18);
  });
  it("adds and subtracts with full precision", () => {
    expect(formatDec(add(parseDec("1.1"), parseDec("2.2")))).toBe("3.3");
    expect(formatDec(sub(parseDec("3.3"), parseDec("1.1")))).toBe("2.2");
  });
  it("multiplies and divides as fixed-point", () => {
    expect(formatDec(mul(parseDec("2"), parseDec("3.5")))).toBe("7");
    expect(formatDec(div(parseDec("10"), parseDec("4")))).toBe("2.5");
    expect(() => div(parseDec("1"), ZERO)).toThrow();
  });
  it("floorStep rounds toward zero on positive values", () => {
    const step = parseDec("0.001");
    expect(formatDec(floorStep(parseDec("1.23456"), step))).toBe("1.234");
    expect(formatDec(floorStep(parseDec("0"), step))).toBe("0");
  });
});
