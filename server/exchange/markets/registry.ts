/**
 * Market registry — loads market definitions from DB, seeds defaults on first run,
 * and exposes a fast in-memory lookup used by the matching engine.
 */

import { eq } from "drizzle-orm";
import { getDb, getRawPool } from "../../db";
import { markets, type Market } from "../../../drizzle/schema";
import { MARKET_SEEDS } from "../../../shared/markets";

export type MarketMode = "binance_mirror" | "orderbook";
export type MarketDataSource = "binance" | "internal" | "manual";
export type RefExchange = "binance" | "okx" | "bybit" | "manual";
export type KlineFollowMode = "scaled" | "synthetic";

let cache: Map<string, Market> | null = null;
let mmColumnsEnsured = false;

async function ensureMarketMakingColumns() {
  if (mmColumnsEnsured) return;
  const pool = await getRawPool();
  if (!pool) return;
  const columnDefs: Array<[string, string]> = [
    ["logoUrl", "TEXT NULL"],
    ["description", "TEXT NULL"],
    ["websiteUrl", "VARCHAR(512) NULL"],
    ["whitepaperUrl", "VARCHAR(512) NULL"],
    ["explorerUrl", "VARCHAR(512) NULL"],
    ["contractAddress", "VARCHAR(128) NULL"],
    ["refExchange", "ENUM('binance','okx','bybit','manual') NOT NULL DEFAULT 'binance'"],
    ["priceRatio", "DECIMAL(36,18) NOT NULL DEFAULT 1"],
    ["priceOffset", "DECIMAL(36,18) NOT NULL DEFAULT 0"],
    ["spreadPct", "DECIMAL(8,6) NOT NULL DEFAULT 0.002"],
    ["maxDepthLevels", "INT NOT NULL DEFAULT 15"],
    ["updateIntervalSec", "INT NOT NULL DEFAULT 3"],
    ["maxPriceJumpPct", "DECIMAL(8,6) NOT NULL DEFAULT 0.05"],
    ["klineFollowMode", "ENUM('scaled','synthetic') NOT NULL DEFAULT 'scaled'"],
    ["allowRealTrade", "BOOLEAN NOT NULL DEFAULT TRUE"],
  ];
  for (const [name, ddl] of columnDefs) {
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'markets' AND COLUMN_NAME = ?",
      [name]
    );
    const cnt = Number((rows as Array<{ cnt: number }>)[0]?.cnt ?? 0);
    if (cnt === 0) {
      await pool.query(`ALTER TABLE markets ADD COLUMN ${name} ${ddl}`);
      console.log(`[markets] added market column ${name}`);
    }
  }
  mmColumnsEnsured = true;
}

export async function seedMarketsIfEmpty() {
  const db = await getDb();
  if (!db) return;
  await ensureMarketMakingColumns();
  const existing = await db.select().from(markets).limit(1);
  if (existing.length > 0) return;
  for (const s of MARKET_SEEDS) {
    await db.insert(markets).values({
      symbol: s.symbol,
      base: s.base,
      quote: s.quote,
      priceTick: s.priceTick,
      amountStep: s.amountStep,
      minNotional: s.minNotional,
      pricePrecision: s.pricePrecision,
      amountPrecision: s.amountPrecision,
      takerFee: "0.001",
      makerFee: "0.0008",
      marketMode: "binance_mirror",
      externalSymbol: s.symbol,
      marketDataSource: "binance",
      refExchange: "binance",
      priceRatio: "1",
      priceOffset: "0",
      spreadPct: "0.002",
      maxDepthLevels: 15,
      updateIntervalSec: 3,
      maxPriceJumpPct: "0.05",
      klineFollowMode: "scaled",
      allowRealTrade: true,
      allowMarketOrder: true,
      allowLimitOrder: true,
      isActive: true,
    });
  }
  console.log(`[markets] seeded ${MARKET_SEEDS.length} pairs`);
}

export async function loadAllMarkets(): Promise<Market[]> {
  const db = await getDb();
  if (!db) return [];
  await ensureMarketMakingColumns();
  const rows = await db.select().from(markets).where(eq(markets.isActive, true));
  cache = new Map(rows.map((r) => [r.symbol, r]));
  return rows;
}

export function getMarket(symbol: string): Market | undefined {
  return cache?.get(symbol);
}

export function getMarketMode(symbol: string): MarketMode {
  return (cache?.get(symbol)?.marketMode ?? "binance_mirror") as MarketMode;
}

export function isMirrorMarket(symbol: string): boolean {
  return getMarketMode(symbol) === "binance_mirror";
}

export function getExternalSymbol(symbol: string): string {
  return cache?.get(symbol)?.externalSymbol || symbol;
}

export async function refreshMarketCache(): Promise<Market[]> {
  return loadAllMarkets();
}

export function allMarketsCached(): Market[] {
  return Array.from(cache?.values() ?? []);
}

export async function ensureMarketsLoaded(): Promise<Market[]> {
  if (cache && cache.size > 0) return allMarketsCached();
  await seedMarketsIfEmpty();
  return loadAllMarkets();
}
