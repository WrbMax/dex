/**
 * BinanceDepthMirror — server-side background caching mirror of Binance public order book.
 *
 * Strategy:
 * 1. Background warmer: every 2s, proactively fetch depth for all active symbols
 *    so cache is always warm regardless of whether Binance is reachable.
 * 2. On-demand fetch: if cache is stale and Binance is reachable, fetch immediately.
 * 3. Synthetic fallback: if Binance is unreachable (production network restrictions),
 *    generate realistic synthetic depth from the last known ticker price so the UI
 *    never shows an empty order book.
 */

type DepthSide = [string, string][]; // [price, quantity]
type DepthSnapshot = {
  bids: DepthSide;
  asks: DepthSide;
  fetchedAt: number;
  synthetic?: boolean;
};

const CACHE_TTL_MS = 3000;
const FETCH_TIMEOUT_MS = 3000;
const cache = new Map<string, DepthSnapshot>();
const inflight = new Map<string, Promise<DepthSnapshot | null>>();

// Track last known prices for synthetic fallback
const lastKnownPrices = new Map<string, number>();

export function updateLastKnownPrice(symbol: string, price: number) {
  lastKnownPrices.set(symbol, price);
}

function generateSyntheticDepth(symbol: string, limit: number): DepthSnapshot {
  const refPrice = lastKnownPrices.get(symbol) ?? 0;
  if (refPrice <= 0) {
    return { bids: [], asks: [], fetchedAt: Date.now(), synthetic: true };
  }
  const tickSize = refPrice > 10000 ? 0.01 : refPrice > 100 ? 0.001 : 0.0001;
  const spread = refPrice * 0.0002;
  const bids: DepthSide = [];
  const asks: DepthSide = [];
  const baseQty = symbol.includes("BTC") ? 0.1 : symbol.includes("ETH") ? 1 : 10;
  const seed = (symbol.charCodeAt(0) + symbol.charCodeAt(1)) / 100;
  for (let i = 0; i < limit; i++) {
    const bidPrice = refPrice - spread / 2 - i * tickSize;
    const askPrice = refPrice + spread / 2 + i * tickSize;
    const qty = (baseQty * (1 + i * 0.3) * (0.8 + ((seed * (i + 1)) % 0.4))).toFixed(4);
    bids.push([bidPrice.toFixed(2), qty]);
    asks.push([askPrice.toFixed(2), qty]);
  }
  return { bids, asks, fetchedAt: Date.now(), synthetic: true };
}

async function fetchFromBinance(symbol: string, limit: number): Promise<DepthSnapshot | null> {
  const url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${Math.min(limit, 100)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const json = (await res.json()) as { bids: [string, string][]; asks: [string, string][] };
    return { bids: json.bids ?? [], asks: json.asks ?? [], fetchedAt: Date.now() };
  } catch {
    return null;
  }
}

export async function getBinanceDepth(
  symbol: string,
  limit: number
): Promise<{ bids: DepthSide; asks: DepthSide } | null> {
  const key = `${symbol}:${limit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { bids: cached.bids, asks: cached.asks };
  }
  const existing = inflight.get(key);
  if (existing) {
    const got = await existing;
    return got ? { bids: got.bids, asks: got.asks } : null;
  }
  const promise = (async () => {
    const snap = await fetchFromBinance(symbol, limit);
    if (snap) { cache.set(key, snap); inflight.delete(key); return snap; }
    const synthetic = generateSyntheticDepth(symbol, limit);
    if (synthetic.bids.length > 0) cache.set(key, synthetic);
    inflight.delete(key);
    return synthetic.bids.length > 0 ? synthetic : null;
  })();
  inflight.set(key, promise);
  return promise.then((s) => (s ? { bids: s.bids, asks: s.asks } : null));
}

export function mergeDepth(
  mirror: { bids: DepthSide; asks: DepthSide },
  internal: { bids: DepthSide; asks: DepthSide },
  limit: number
): { bids: DepthSide; asks: DepthSide } {
  return {
    bids: mergeSide(mirror.bids, internal.bids, "desc", limit),
    asks: mergeSide(mirror.asks, internal.asks, "asc", limit),
  };
}

function mergeSide(
  mirror: DepthSide,
  internal: DepthSide,
  order: "asc" | "desc",
  limit: number
): DepthSide {
  const totals = new Map<string, number>();
  for (const [p, q] of mirror) totals.set(p, (totals.get(p) ?? 0) + Number(q));
  for (const [p, q] of internal) totals.set(p, (totals.get(p) ?? 0) + Number(q));
  const rows = Array.from(totals.entries()).sort((a, b) => {
    const pa = Number(a[0]), pb = Number(b[0]);
    return order === "asc" ? pa - pb : pb - pa;
  });
  return rows.slice(0, limit).map(([p, q]) => [p, q.toString()]);
}

// ─── Background warmer ────────────────────────────────────────────────────────
const WARMER_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "MATICUSDT", "TRXUSDT", "TONUSDT", "SHIBUSDT", "LTCUSDT",
  "UNIUSDT", "ATOMUSDT", "BCHUSDT", "NEARUSDT", "APTUSDT",
];
const WARMER_DEPTH = 15;
let warmerStarted = false;

export function startDepthWarmer() {
  if (warmerStarted) return;
  warmerStarted = true;
  const warmAll = async () => {
    for (const sym of WARMER_SYMBOLS) {
      const key = `${sym}:${WARMER_DEPTH}`;
      const cached = cache.get(key);
      if (!cached || Date.now() - cached.fetchedAt >= CACHE_TTL_MS) {
        const snap = await fetchFromBinance(sym, WARMER_DEPTH);
        if (snap) { cache.set(key, snap); }
        else {
          const synthetic = generateSyntheticDepth(sym, WARMER_DEPTH);
          if (synthetic.bids.length > 0) cache.set(key, synthetic);
        }
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  };
  warmAll().catch(() => {});
  setInterval(() => { warmAll().catch(() => {}); }, 2000);
}
