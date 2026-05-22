/**
 * MarketDataHub — aggregates external tickers/klines/trades for the 30 seeded
 * symbols.
 *
 * Primary source: Binance public WebSocket (no auth required). For each symbol
 * we subscribe to:
 *   - <lower>@ticker    : 24h price change + last price + volume
 *   - <lower>@trade     : individual trades (for tape display)
 *   - <lower>@kline_1m  : 1-minute candles (for mini sparkline + chart)
 *
 * If the WS connection drops we reconnect with exponential backoff. If Binance
 * is unreachable (e.g. restricted network), we fall back to a deterministic
 * synthetic walk around the seed price so the UI stays populated.
 */

import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { MARKET_SEEDS } from "../../../shared/markets";
import { ENV } from "../../_core/env";
import { OkxSource } from "./source_okx";
import { HyperliquidSource } from "./source_hyperliquid";
import { allMarketsCached, getMarket } from "../markets/registry";
import { formatConfigPrice, transformReferencePrice } from "./market_config";

type SecondaryTickerSample = {
  source: "okx" | "hyperliquid";
  symbol: string;
  lastPrice: string;
  high24h?: string;
  low24h?: string;
  open24h?: string;
  volume24h?: string;
  quoteVolume24h?: string;
  ts: number;
};
type SecondaryTradeSample = {
  source: "okx" | "hyperliquid";
  symbol: string;
  price: string;
  quantity: string;
  isBuyerMaker: boolean;
  timestamp: number;
};
type ConfiguredMarket = {
  symbol: string;
  seedPrice?: string;
  externalSymbol?: string | null;
  marketMode?: "binance_mirror" | "orderbook";
  marketDataSource?: "binance" | "internal" | "manual";
  refExchange?: "binance" | "okx" | "bybit" | "manual";
  priceRatio?: string;
  priceOffset?: string;
  spreadPct?: string;
  maxDepthLevels?: number;
  updateIntervalSec?: number;
  maxPriceJumpPct?: string;
  klineFollowMode?: "scaled" | "synthetic";
  allowRealTrade?: boolean;
};

function configuredMarkets(): ConfiguredMarket[] {
  const dbMarkets = allMarketsCached();
  if (dbMarkets.length > 0) {
    const seedBySymbol = new Map(MARKET_SEEDS.map((m) => [m.symbol, m.seedPrice]));
    return dbMarkets.map((m) => ({
      symbol: m.symbol,
      seedPrice: seedBySymbol.get(m.symbol) ?? "1",
      externalSymbol: m.externalSymbol || m.symbol,
      marketMode: m.marketMode,
      marketDataSource: m.marketDataSource,
      refExchange: m.refExchange,
      priceRatio: m.priceRatio,
      priceOffset: m.priceOffset,
      spreadPct: m.spreadPct,
      maxDepthLevels: m.maxDepthLevels,
      updateIntervalSec: m.updateIntervalSec,
      maxPriceJumpPct: m.maxPriceJumpPct,
      klineFollowMode: m.klineFollowMode,
      allowRealTrade: m.allowRealTrade,
    }));
  }
  return MARKET_SEEDS.map((m) => ({
    symbol: m.symbol,
    seedPrice: m.seedPrice,
    externalSymbol: m.symbol,
    marketMode: "binance_mirror",
    marketDataSource: "binance",
  }));
}

function binanceMirrorMarkets(): ConfiguredMarket[] {
  return configuredMarkets().filter((m) =>
    (m.marketMode ?? "binance_mirror") === "binance_mirror" &&
    (m.marketDataSource ?? "binance") === "binance"
  );
}

function localSymbolForUpstream(upstream: string): string {
  const upper = upstream.toUpperCase();
  const found = configuredMarkets().find((m) => (m.externalSymbol || m.symbol).toUpperCase() === upper);
  return found?.symbol ?? upper;
}

export type TickerSnapshot = {
  symbol: string;
  lastPrice: string;
  change24h: string;
  changePct24h: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  quoteVolume24h: string;
  updatedAt: number;
  /** mini kline used by the market list sparkline */
  sparkline: number[];
};

export type TradePrint = {
  symbol: string;
  price: string;
  quantity: string;
  isBuyerMaker: boolean;
  timestamp: number;
};

export type Kline = {
  symbol: string;
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  interval: string;
};

export class MarketDataHub extends EventEmitter {
  private tickers = new Map<string, TickerSnapshot>();
  private klines = new Map<string, Kline[]>(); // last 60 1-minute candles
  private recentTrades = new Map<string, TradePrint[]>(); // last 50 per symbol
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private syntheticTimer: NodeJS.Timeout | null = null;
  private usingSynthetic = false;
  private okx: OkxSource | null = null;
  private hyperliquid: HyperliquidSource | null = null;
  private sourceLastPrice = new Map<string, Map<string, number>>();

  constructor() {
    super();
    this.seed();
  }

  private seed() {
    for (const m of configuredMarkets()) {
      const p = Number(m.seedPrice ?? "1");
      const hist: number[] = [];
      for (let i = 0; i < 30; i++) hist.push(p * (1 + (Math.random() - 0.5) * 0.01));
      this.tickers.set(m.symbol, {
        symbol: m.symbol,
        lastPrice: String(p),
        change24h: "0",
        changePct24h: "0",
        high24h: String(p * 1.03),
        low24h: String(p * 0.97),
        volume24h: "0",
        quoteVolume24h: "0",
        updatedAt: Date.now(),
        sparkline: hist,
      });
      this.klines.set(m.symbol, []);
      this.recentTrades.set(m.symbol, []);
    }
  }

  start() {
    const enabled = new Set(ENV.exchange.marketDataSources);
    if (enabled.has("binance")) this.connect();
    if (enabled.has("okx")) {
      this.okx = new OkxSource(MARKET_SEEDS);
      this.okx.on("ticker", (t: SecondaryTickerSample) => this.onSecondaryTicker(t));
      this.okx.on("trade", (t: SecondaryTradeSample) => this.onSecondaryTrade(t));
      this.okx.start();
    }
    if (enabled.has("hyperliquid")) {
      this.hyperliquid = new HyperliquidSource(MARKET_SEEDS);
      this.hyperliquid.on("trade", (t: SecondaryTradeSample) => this.onSecondaryTrade(t));
      this.hyperliquid.start();
    }
    // Always run a lightweight synthetic drift so the UI never looks frozen
    // when primary source data arrives slowly or not at all.
    this.syntheticTimer = setInterval(() => this.pulse(), 1500);

    // PRICE SOURCE: Use Binance REST API as the authoritative price source.
    // Poll every 3 seconds to keep prices accurate and real-time.
    void this.correctPricesFromRest();
    setInterval(() => void this.correctPricesFromRest(), 3_000);
  }

  /**
   * Fetch real-time prices from Binance REST API and correct any symbols
   * whose cached price has drifted more than 5% from the real price.
   */
  private async correctPricesFromRest(): Promise<void> {
    try {
      const markets = binanceMirrorMarkets();
      const symbols = Array.from(new Set(markets.map((m) => (m.externalSymbol || m.symbol).toUpperCase())));
      if (symbols.length === 0) return;
      // Binance supports batch price query
      const url = `https://api.binance.com/api/v3/ticker/price?symbols=[${symbols.map((s) => `%22${s}%22`).join(",")}]`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return;
      const data = (await resp.json()) as { symbol: string; price: string }[];
      for (const item of data) {
        const localSymbol = localSymbolForUpstream(item.symbol);
        const existing = this.tickers.get(localSymbol);
        if (!existing) continue;
        const realPrice = Number(item.price);
        if (realPrice <= 0) continue;
        const market = getMarket(localSymbol);
        const localPrice = Number(transformReferencePrice(item.price, market, existing.lastPrice));
        // Always update with transformed reference REST price
        const snap: TickerSnapshot = {
          ...existing,
          lastPrice: formatConfigPrice(localPrice),
          high24h: formatConfigPrice(Math.max(localPrice, Number(existing.high24h))),
          low24h: formatConfigPrice(Math.min(localPrice, Number(existing.low24h))),
          updatedAt: Date.now(),
          sparkline: [...existing.sparkline.slice(-29), localPrice],
        };
        this.tickers.set(localSymbol, snap);
        this.emit("ticker", snap);
      }
    } catch {
      // Silently ignore REST correction failures
    }
  }

  /**
   * Secondary source handlers. Binance is the source of truth for 24h stats;
   * OKX / Hyperliquid contribute only when Binance is NOT live (so we can
   * still paint a market even in restricted regions), or for cross-venue
   * trade-tape diversification. We keep a per-source last-price map used by
   * the admin diagnostic `sourceHealth()` query.
   */
  private onSecondaryTicker(t: SecondaryTickerSample) {
    const bucket = this.sourceLastPrice.get(t.symbol) ?? new Map<string, number>();
    bucket.set(t.source, Number(t.lastPrice));
    this.sourceLastPrice.set(t.symbol, bucket);
    const existing = this.tickers.get(t.symbol);
    if (!existing) return;
    // Only promote secondary feed to the authoritative snapshot when Binance
    // is offline; otherwise we just record it for diagnostics.
    if (!this.isBinanceLive()) {
      const market = getMarket(t.symbol);
      const localLast = transformReferencePrice(t.lastPrice, market, existing.lastPrice);
      const price = Number(localLast);
      const open = Number(t.open24h ? transformReferencePrice(t.open24h, market) : existing.sparkline[0] ?? price);
      const delta = price - open;
      const pct = open === 0 ? 0 : (delta / open) * 100;
      const snap: TickerSnapshot = {
        ...existing,
        lastPrice: localLast,
        change24h: delta.toFixed(8),
        changePct24h: pct.toFixed(4),
        high24h: t.high24h ? transformReferencePrice(t.high24h, market) : existing.high24h,
        low24h: t.low24h ? transformReferencePrice(t.low24h, market) : existing.low24h,
        volume24h: t.volume24h ?? existing.volume24h,
        quoteVolume24h: t.quoteVolume24h ?? existing.quoteVolume24h,
        updatedAt: t.ts,
        sparkline: [...existing.sparkline.slice(-29), price],
      };
      this.tickers.set(t.symbol, snap);
      this.emit("ticker", snap);
    }
  }

  private onSecondaryTrade(t: SecondaryTradeSample) {
    const bucket = this.sourceLastPrice.get(t.symbol) ?? new Map<string, number>();
    bucket.set(t.source, Number(t.price));
    this.sourceLastPrice.set(t.symbol, bucket);
    // Only fan out to clients when Binance is NOT the live authority (avoid
    // double-counting on the trade tape).
    if (this.isBinanceLive()) return;
    const print: TradePrint = {
      symbol: t.symbol,
      price: transformReferencePrice(t.price, getMarket(t.symbol)),
      quantity: t.quantity,
      isBuyerMaker: t.isBuyerMaker,
      timestamp: t.timestamp,
    };
    const list = this.recentTrades.get(t.symbol) ?? [];
    list.unshift(print);
    if (list.length > 50) list.length = 50;
    this.recentTrades.set(t.symbol, list);
    this.emit("trade_print", print);
  }

  private isBinanceLive() {
    return !this.usingSynthetic && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Snapshot of liveness of every configured upstream source + per-symbol
   *  count of distinct sources observed in the last price bucket. Used by
   *  the admin `marketSources` tRPC query. */
  sourceHealth() {
    return {
      binance: this.isBinanceLive(),
      okx: this.okx?.isLive() ?? false,
      hyperliquid: this.hyperliquid?.isLive() ?? false,
      distinctSourcesSeen: Array.from(this.sourceLastPrice.entries()).map(
        ([sym, m]) => ({ symbol: sym, sources: Array.from(m.keys()) })
      ),
    };
  }

  stop() {
    this.closed = true;
    this.ws?.close();
    this.okx?.stop();
    this.hyperliquid?.stop();
    if (this.syntheticTimer) clearInterval(this.syntheticTimer);
  }

  private buildStreamUrl(): string {
    const streams: string[] = [];
    for (const m of binanceMirrorMarkets()) {
      const s = (m.externalSymbol || m.symbol).toLowerCase();
      // FIX H002: Only subscribe to @ticker stream.
      // @trade and @kline_1m generate ~60 extra messages/sec across many symbols,
      // saturating the TLS decryption pipeline and causing 100% CPU usage.
      streams.push(`${s}@ticker`);
    }
    return `wss://data-stream.binance.vision/stream?streams=${streams.join("/")}`;
  }

  private connect() {
    if (this.closed) return;
    const url = this.buildStreamUrl();
    try {
      const ws = new WebSocket(url, { handshakeTimeout: 5000 });
      this.ws = ws;
      ws.on("open", () => {
        this.reconnectAttempts = 0;
        this.usingSynthetic = false;
        console.log("[marketdata] Binance WS connected");
      });
      ws.on("message", (raw) => this.onMessage(raw));
      ws.on("close", () => {
        console.log("[marketdata] WS closed, reconnecting");
        this.scheduleReconnect();
      });
      ws.on("error", (err) => {
        console.log("[marketdata] WS error:", (err as Error).message);
        ws.close();
      });
    } catch (err) {
      console.log("[marketdata] WS connect failed, using synthetic feed");
      this.usingSynthetic = true;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.usingSynthetic = true;
    const backoff = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), backoff);
  }

  private onMessage(raw: WebSocket.RawData) {
    try {
      const msg = JSON.parse(raw.toString()) as { stream?: string; data?: any };
      if (!msg.stream || !msg.data) return;
      const streamParts = msg.stream.split("@");
      const upstreamSymbol = streamParts[0].toUpperCase();
      const symbol = localSymbolForUpstream(upstreamSymbol);
      const kind = streamParts[1];
      if (kind === "ticker") this.onTicker(symbol, msg.data);
      else if (kind === "trade") this.onTrade(symbol, msg.data);
      else if (kind.startsWith("kline")) this.onKline(symbol, msg.data);
    } catch {
      // ignore malformed frames
    }
  }

  private onTicker(symbol: string, d: any) {
    const existing = this.tickers.get(symbol);
    if (!existing) return;
    const market = getMarket(symbol);
    const lastPrice = transformReferencePrice(String(d.c), market, existing.lastPrice);
    const ratio = Number(market?.priceRatio ?? 1);
    const snap: TickerSnapshot = {
      ...existing,
      symbol,
      lastPrice,
      change24h: formatConfigPrice(Number(d.p) * (Number.isFinite(ratio) ? ratio : 1)),
      changePct24h: String(d.P),
      high24h: transformReferencePrice(String(d.h), market),
      low24h: transformReferencePrice(String(d.l), market),
      volume24h: String(d.v),
      quoteVolume24h: String(d.q),
      updatedAt: Date.now(),
    };
    snap.sparkline = [...existing.sparkline.slice(-29), Number(lastPrice)];
    this.tickers.set(symbol, snap);
    this.emit("ticker", snap);
  }

  private onTrade(symbol: string, d: any) {
    const t: TradePrint = {
      symbol,
      price: transformReferencePrice(String(d.p), getMarket(symbol)),
      quantity: String(d.q),
      isBuyerMaker: !!d.m,
      timestamp: Number(d.T),
    };
    const list = this.recentTrades.get(symbol) ?? [];
    list.unshift(t);
    if (list.length > 50) list.length = 50;
    this.recentTrades.set(symbol, list);
    this.emit("trade_print", t);
  }

  private onKline(symbol: string, d: any) {
    const k = d.k;
    if (!k) return;
    const kline: Kline = {
      symbol,
      openTime: Number(k.t),
      open: transformReferencePrice(String(k.o), getMarket(symbol)),
      high: transformReferencePrice(String(k.h), getMarket(symbol)),
      low: transformReferencePrice(String(k.l), getMarket(symbol)),
      close: transformReferencePrice(String(k.c), getMarket(symbol)),
      volume: String(k.v),
      interval: String(k.i),
    };
    const list = this.klines.get(symbol) ?? [];
    if (list.length === 0 || list[list.length - 1].openTime !== kline.openTime) {
      list.push(kline);
      if (list.length > 120) list.shift();
    } else {
      list[list.length - 1] = kline;
    }
    this.klines.set(symbol, list);
    this.emit("kline", kline);
  }

  /** Keep the UI alive even when Binance is slow or blocked. */
  private pulse() {
    if (!this.usingSynthetic && (this.ws?.readyState ?? 0) === WebSocket.OPEN) return;
    for (const [symbol, snap] of this.tickers.entries()) {
      const last = Number(snap.lastPrice);
      const drift = last * (Math.random() - 0.5) * 0.003; // ±0.15%
      const next = Math.max(1e-9, last + drift);
      const delta = next - Number(snap.sparkline[0] ?? next);
      const pct = ((next - Number(snap.sparkline[0] ?? next)) / Number(snap.sparkline[0] ?? next)) * 100;
      const updated: TickerSnapshot = {
        ...snap,
        lastPrice: next.toFixed(8),
        change24h: delta.toFixed(4),
        changePct24h: pct.toFixed(3),
        high24h: Math.max(next, Number(snap.high24h)).toFixed(8),
        low24h: Math.min(next, Number(snap.low24h)).toFixed(8),
        updatedAt: Date.now(),
        sparkline: [...snap.sparkline.slice(-29), next],
      };
      this.tickers.set(symbol, updated);
      this.emit("ticker", updated);

      // Emit synthetic trade print
      const qty = (Math.random() * 2).toFixed(4);
      const print: TradePrint = {
        symbol,
        price: next.toFixed(8),
        quantity: qty,
        isBuyerMaker: Math.random() > 0.5,
        timestamp: Date.now(),
      };
      const list = this.recentTrades.get(symbol) ?? [];
      list.unshift(print);
      if (list.length > 50) list.length = 50;
      this.recentTrades.set(symbol, list);
      this.emit("trade_print", print);
    }
  }

  listTickers(): TickerSnapshot[] {
    return Array.from(this.tickers.values());
  }
  getTicker(symbol: string) {
    return this.tickers.get(symbol);
  }
  getRecentTrades(symbol: string) {
    return this.recentTrades.get(symbol) ?? [];
  }
  getKlines(symbol: string) {
    return this.klines.get(symbol) ?? [];
  }
  /** @deprecated use `sourceHealth()` for multi-source info. Kept for callers
   *  that only cared about the primary (Binance) source. */
  isLive() {
    return this.isBinanceLive();
  }
}

let _hub: MarketDataHub | null = null;
export function getMarketDataHub(): MarketDataHub {
  if (!_hub) {
    _hub = new MarketDataHub();
    _hub.start();
  }
  return _hub;
}
