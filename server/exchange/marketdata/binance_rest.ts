type BinanceTicker24hr = {
  symbol: string;
  priceChange?: string;
  priceChangePercent?: string;
  lastPrice?: string;
  highPrice?: string;
  lowPrice?: string;
  volume?: string;
  quoteVolume?: string;
  closeTime?: number;
};

type BinanceTrade = {
  id: number;
  price: string;
  qty: string;
  quoteQty?: string;
  time: number;
  isBuyerMaker: boolean;
  isBestMatch?: boolean;
};

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

type CacheEntry<T> = { value: T; fetchedAt: number };

const FETCH_TIMEOUT_MS = 3000;
const TICKER_TTL_MS = 1000;
const TRADES_TTL_MS = 1000;
const KLINES_TTL_MS = 2000;

const tickerCache = new Map<string, CacheEntry<BinanceTicker24hr>>();
const tradesCache = new Map<string, CacheEntry<BinanceTrade[]>>();
const klinesCache = new Map<string, CacheEntry<BinanceKline[]>>();
const inflightTicker = new Map<string, Promise<BinanceTicker24hr | null>>();
const inflightTrades = new Map<string, Promise<BinanceTrade[] | null>>();
const inflightKlines = new Map<string, Promise<BinanceKline[] | null>>();

function cacheFresh<T>(entry: CacheEntry<T> | undefined, ttl: number): T | null {
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ttl) return null;
  return entry.value;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getBinance24hrTicker(symbol: string): Promise<BinanceTicker24hr | null> {
  const key = symbol.toUpperCase();
  const fresh = cacheFresh(tickerCache.get(key), TICKER_TTL_MS);
  if (fresh) return fresh;
  const existing = inflightTicker.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(key)}`;
    const got = await fetchJson<BinanceTicker24hr>(url);
    if (got?.symbol) tickerCache.set(key, { value: got, fetchedAt: Date.now() });
    inflightTicker.delete(key);
    return got?.symbol ? got : null;
  })();
  inflightTicker.set(key, promise);
  return promise;
}

export async function getBinanceKlines(symbol: string, interval: string, limit: number): Promise<BinanceKline[] | null> {
  const safeInterval = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"].includes(interval) ? interval : "1m";
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const key = `${symbol.toUpperCase()}:${safeInterval}:${safeLimit}`;
  const fresh = cacheFresh(klinesCache.get(key), KLINES_TTL_MS);
  if (fresh) return fresh;
  const existing = inflightKlines.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${encodeURIComponent(safeInterval)}&limit=${safeLimit}`;
    const got = await fetchJson<BinanceKline[]>(url);
    if (Array.isArray(got)) klinesCache.set(key, { value: got, fetchedAt: Date.now() });
    inflightKlines.delete(key);
    return Array.isArray(got) ? got : null;
  })();
  inflightKlines.set(key, promise);
  return promise;
}

export async function getBinanceRecentTrades(symbol: string, limit: number): Promise<BinanceTrade[] | null> {
  const key = `${symbol.toUpperCase()}:${limit}`;
  const fresh = cacheFresh(tradesCache.get(key), TRADES_TTL_MS);
  if (fresh) return fresh;
  const existing = inflightTrades.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const url = `https://api.binance.com/api/v3/trades?symbol=${encodeURIComponent(symbol.toUpperCase())}&limit=${safeLimit}`;
    const got = await fetchJson<BinanceTrade[]>(url);
    if (Array.isArray(got)) tradesCache.set(key, { value: got, fetchedAt: Date.now() });
    inflightTrades.delete(key);
    return Array.isArray(got) ? got : null;
  })();
  inflightTrades.set(key, promise);
  return promise;
}

export function toHubTickerShape(t: BinanceTicker24hr) {
  return {
    symbol: t.symbol,
    lastPrice: t.lastPrice ?? "0",
    change24h: t.priceChange ?? "0",
    changePct24h: t.priceChangePercent ?? "0",
    high24h: t.highPrice ?? "0",
    low24h: t.lowPrice ?? "0",
    volume24h: t.volume ?? "0",
    quoteVolume24h: t.quoteVolume ?? "0",
    updatedAt: t.closeTime ?? Date.now(),
    sparkline: [] as string[],
  };
}

export function toHubTradeShape(t: BinanceTrade, symbol: string) {
  return {
    source: "binance",
    symbol: symbol.toUpperCase(),
    price: t.price,
    quantity: t.qty,
    isBuyerMaker: t.isBuyerMaker,
    timestamp: t.time,
  };
}
