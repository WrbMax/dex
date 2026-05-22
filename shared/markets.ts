/**
 * 30 mainstream spot trading pairs, all quoted in USDT.
 * These are seeded into the `markets` table on first server start.
 */

export type MarketSeed = {
  symbol: string;
  base: string;
  quote: "USDT";
  priceTick: string;
  amountStep: string;
  minNotional: string;
  pricePrecision: number;
  amountPrecision: number;
  /** reference price only used for seeding display if upstream feed not ready */
  seedPrice: string;
};

export const MARKET_SEEDS: MarketSeed[] = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT", priceTick: "0.1", amountStep: "0.00001", minNotional: "5", pricePrecision: 2, amountPrecision: 5, seedPrice: "67500" },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT", priceTick: "0.01", amountStep: "0.0001", minNotional: "5", pricePrecision: 2, amountPrecision: 4, seedPrice: "3450" },
  { symbol: "SOLUSDT", base: "SOL", quote: "USDT", priceTick: "0.01", amountStep: "0.01", minNotional: "5", pricePrecision: 2, amountPrecision: 2, seedPrice: "160" },
  { symbol: "BNBUSDT", base: "BNB", quote: "USDT", priceTick: "0.01", amountStep: "0.001", minNotional: "5", pricePrecision: 2, amountPrecision: 3, seedPrice: "590" },
  { symbol: "XRPUSDT", base: "XRP", quote: "USDT", priceTick: "0.0001", amountStep: "1", minNotional: "5", pricePrecision: 4, amountPrecision: 0, seedPrice: "0.58" },
  { symbol: "DOGEUSDT", base: "DOGE", quote: "USDT", priceTick: "0.00001", amountStep: "1", minNotional: "5", pricePrecision: 5, amountPrecision: 0, seedPrice: "0.16" },
  { symbol: "ADAUSDT", base: "ADA", quote: "USDT", priceTick: "0.0001", amountStep: "0.1", minNotional: "5", pricePrecision: 4, amountPrecision: 1, seedPrice: "0.42" },
  { symbol: "AVAXUSDT", base: "AVAX", quote: "USDT", priceTick: "0.01", amountStep: "0.01", minNotional: "5", pricePrecision: 2, amountPrecision: 2, seedPrice: "35" },
  { symbol: "LINKUSDT", base: "LINK", quote: "USDT", priceTick: "0.01", amountStep: "0.01", minNotional: "5", pricePrecision: 2, amountPrecision: 2, seedPrice: "14.5" },
  { symbol: "DOTUSDT", base: "DOT", quote: "USDT", priceTick: "0.001", amountStep: "0.1", minNotional: "5", pricePrecision: 3, amountPrecision: 1, seedPrice: "6.8" },
  { symbol: "MATICUSDT", base: "MATIC", quote: "USDT", priceTick: "0.0001", amountStep: "1", minNotional: "5", pricePrecision: 4, amountPrecision: 0, seedPrice: "0.48" },
  { symbol: "TRXUSDT", base: "TRX", quote: "USDT", priceTick: "0.00001", amountStep: "1", minNotional: "5", pricePrecision: 5, amountPrecision: 0, seedPrice: "0.13" },
  { symbol: "TONUSDT", base: "TON", quote: "USDT", priceTick: "0.001", amountStep: "0.01", minNotional: "5", pricePrecision: 3, amountPrecision: 2, seedPrice: "6.9" },
  { symbol: "SHIBUSDT", base: "SHIB", quote: "USDT", priceTick: "0.0000001", amountStep: "1000", minNotional: "5", pricePrecision: 7, amountPrecision: 0, seedPrice: "0.000023" },
  { symbol: "LTCUSDT", base: "LTC", quote: "USDT", priceTick: "0.01", amountStep: "0.001", minNotional: "5", pricePrecision: 2, amountPrecision: 3, seedPrice: "83" },
  { symbol: "UNIUSDT", base: "UNI", quote: "USDT", priceTick: "0.001", amountStep: "0.01", minNotional: "5", pricePrecision: 3, amountPrecision: 2, seedPrice: "7.5" },
  { symbol: "ATOMUSDT", base: "ATOM", quote: "USDT", priceTick: "0.001", amountStep: "0.01", minNotional: "5", pricePrecision: 3, amountPrecision: 2, seedPrice: "6.2" },
  { symbol: "BCHUSDT", base: "BCH", quote: "USDT", priceTick: "0.01", amountStep: "0.001", minNotional: "5", pricePrecision: 2, amountPrecision: 3, seedPrice: "370" },
  { symbol: "NEARUSDT", base: "NEAR", quote: "USDT", priceTick: "0.001", amountStep: "0.01", minNotional: "5", pricePrecision: 3, amountPrecision: 2, seedPrice: "4.8" },
  { symbol: "APTUSDT", base: "APT", quote: "USDT", priceTick: "0.001", amountStep: "0.01", minNotional: "5", pricePrecision: 3, amountPrecision: 2, seedPrice: "7.8" },
  { symbol: "ARBUSDT", base: "ARB", quote: "USDT", priceTick: "0.0001", amountStep: "0.1", minNotional: "5", pricePrecision: 4, amountPrecision: 1, seedPrice: "0.7" },
  { symbol: "OPUSDT", base: "OP", quote: "USDT", priceTick: "0.0001", amountStep: "0.1", minNotional: "5", pricePrecision: 4, amountPrecision: 1, seedPrice: "1.6" },
  { symbol: "PEPEUSDT", base: "PEPE", quote: "USDT", priceTick: "0.00000001", amountStep: "100000", minNotional: "5", pricePrecision: 8, amountPrecision: 0, seedPrice: "0.0000092" },
  { symbol: "SUIUSDT", base: "SUI", quote: "USDT", priceTick: "0.0001", amountStep: "0.1", minNotional: "5", pricePrecision: 4, amountPrecision: 1, seedPrice: "1.2" },
  { symbol: "FILUSDT", base: "FIL", quote: "USDT", priceTick: "0.001", amountStep: "0.01", minNotional: "5", pricePrecision: 3, amountPrecision: 2, seedPrice: "4.3" },
  { symbol: "IMXUSDT", base: "IMX", quote: "USDT", priceTick: "0.001", amountStep: "0.1", minNotional: "5", pricePrecision: 3, amountPrecision: 1, seedPrice: "1.5" },
  { symbol: "RNDRUSDT", base: "RNDR", quote: "USDT", priceTick: "0.001", amountStep: "0.01", minNotional: "5", pricePrecision: 3, amountPrecision: 2, seedPrice: "6.1" },
  { symbol: "TIAUSDT", base: "TIA", quote: "USDT", priceTick: "0.001", amountStep: "0.01", minNotional: "5", pricePrecision: 3, amountPrecision: 2, seedPrice: "7.2" },
  { symbol: "HBARUSDT", base: "HBAR", quote: "USDT", priceTick: "0.00001", amountStep: "1", minNotional: "5", pricePrecision: 5, amountPrecision: 0, seedPrice: "0.076" },
  { symbol: "INJUSDT", base: "INJ", quote: "USDT", priceTick: "0.001", amountStep: "0.01", minNotional: "5", pricePrecision: 3, amountPrecision: 2, seedPrice: "23" },
];

/** Assets that can be deposited/withdrawn on-chain. */
export const ON_CHAIN_ASSETS = ["USDT", ...MARKET_SEEDS.map((m) => m.base)] as const;
export type OnChainAsset = (typeof ON_CHAIN_ASSETS)[number];

/** All assets recognized by the ledger (includes base currencies obtained via trading). */
export const ALL_ASSETS = ["USDT", ...MARKET_SEEDS.map((m) => m.base)] as const;

export const DEFAULT_TAKER_FEE = "0.001"; // 0.1%
export const DEFAULT_MAKER_FEE = "0.0008"; // 0.08%

/** USD→CNY display-only rate (frontend conversion). */
export const USDT_TO_CNY_RATE = 7.2;
