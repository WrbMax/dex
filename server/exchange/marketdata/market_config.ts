import type { Market } from "../../../drizzle/schema";

export type PriceConfig = Pick<Market, "priceRatio" | "priceOffset" | "maxPriceJumpPct" | "spreadPct" | "maxDepthLevels">;

export function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function transformReferencePrice(price: string | number, market?: Partial<PriceConfig> | null, previousPrice?: string | number | null): string {
  const raw = Number(price);
  if (!Number.isFinite(raw) || raw <= 0) return String(price);
  const ratio = Math.max(0, toNumber(market?.priceRatio, 1));
  const offset = toNumber(market?.priceOffset, 0);
  let next = Math.max(0, raw * ratio + offset);
  const prev = previousPrice == null ? 0 : Number(previousPrice);
  const maxJump = Math.max(0, toNumber(market?.maxPriceJumpPct, 0.05));
  if (prev > 0 && maxJump > 0) {
    const upper = prev * (1 + maxJump);
    const lower = prev * Math.max(0, 1 - maxJump);
    next = Math.min(upper, Math.max(lower, next));
  }
  return formatConfigPrice(next);
}

export function formatConfigPrice(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(12).replace(/\.?0+$/, "") || "0";
}

export function transformDepthLevels(levels: [string, string][], market?: Partial<PriceConfig> | null, previousPrice?: string | number | null): [string, string][] {
  const limit = Math.max(1, Math.min(50, Math.floor(toNumber(market?.maxDepthLevels, levels.length || 15))));
  return levels.slice(0, limit).map(([price, qty]) => [transformReferencePrice(price, market, previousPrice), qty]);
}

export function syntheticDepthAround(midPrice: string | number, market?: Partial<PriceConfig> | null, depth = 15): { bids: [string, string][]; asks: [string, string][] } {
  const mid = Math.max(1e-12, Number(midPrice) || 1);
  const limit = Math.max(1, Math.min(50, Math.floor(toNumber(market?.maxDepthLevels, depth))));
  const spread = Math.max(0, toNumber(market?.spreadPct, 0.002));
  const half = spread / 2;
  const bids: [string, string][] = [];
  const asks: [string, string][] = [];
  for (let i = 0; i < limit; i++) {
    const step = half + i * Math.max(0.0001, spread / Math.max(1, limit));
    const qty = (2 + i * 0.37).toFixed(6);
    bids.push([formatConfigPrice(mid * (1 - step)), qty]);
    asks.push([formatConfigPrice(mid * (1 + step)), qty]);
  }
  return { bids, asks };
}

export function transformTickerLike<
  T extends {
    lastPrice: string;
    change24h?: string;
    high24h?: string;
    low24h?: string;
    sparkline?: Array<number | string>;
  }
>(ticker: T, market?: Partial<PriceConfig> | null): T {
  const lastPrice = transformReferencePrice(ticker.lastPrice, market);
  const ratio = Math.max(0, toNumber(market?.priceRatio, 1));
  const offset = toNumber(market?.priceOffset, 0);
  const transformSimple = (v: string | undefined) => v == null ? v : formatConfigPrice(Math.max(0, Number(v) * ratio + offset));
  const change = ticker.change24h == null ? ticker.change24h : formatConfigPrice(Number(ticker.change24h) * ratio);
  return {
    ...ticker,
    lastPrice,
    change24h: change,
    high24h: transformSimple(ticker.high24h),
    low24h: transformSimple(ticker.low24h),
    sparkline: ticker.sparkline?.map((p) => Number(formatConfigPrice(Math.max(0, Number(p) * ratio + offset)))),
  } as T;
}
