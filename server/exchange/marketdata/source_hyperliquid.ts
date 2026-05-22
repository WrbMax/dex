import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { MarketSeed } from "../../../shared/markets";

/**
 * Hyperliquid public WebSocket source. Hyperliquid's spot API exposes trades
 * and an order-book L2 stream per "coin" (their symbol, without a quote
 * suffix). We subscribe to `trades` for the 30 seeded USDT pairs that have
 * Hyperliquid listings; symbols without a listing are silently ignored.
 *
 * Outbound event shape matches the Binance + OKX sources so the aggregator
 * can consume them uniformly.
 *
 * Hyperliquid subscribe message:
 *   { "method": "subscribe", "subscription": { "type": "trades", "coin": "BTC" } }
 */

// Coins that Hyperliquid historically lists on spot. The hub filters; if a
// coin isn't listed, we just get no messages for it — which is fine.
const HYPERLIQUID_COINS = new Set([
  "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT",
  "MATIC", "TRX", "TON", "SHIB", "LTC", "UNI", "ATOM", "BCH", "NEAR", "APT",
  "ARB", "OP", "PEPE", "SUI", "FIL", "IMX", "RNDR", "TIA", "HBAR", "INJ",
]);

export class HyperliquidSource extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private seeds: MarketSeed[];
  private live = false;

  constructor(seeds: MarketSeed[]) {
    super();
    this.seeds = seeds;
  }

  start() {
    this.connect();
  }

  stop() {
    this.closed = true;
    this.ws?.close();
  }

  isLive() {
    return this.live && this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.closed) return;
    try {
      const ws = new WebSocket("wss://api.hyperliquid.xyz/ws", {
        handshakeTimeout: 5000,
      });
      this.ws = ws;
      ws.on("open", () => {
        this.reconnectAttempts = 0;
        this.live = true;
        for (const s of this.seeds) {
          const coin = s.base;
          if (!HYPERLIQUID_COINS.has(coin)) continue;
          ws.send(
            JSON.stringify({
              method: "subscribe",
              subscription: { type: "trades", coin },
            })
          );
        }
        console.log("[marketdata.hyperliquid] WS connected");
      });
      ws.on("message", (raw) => this.onMessage(raw));
      ws.on("close", () => {
        this.live = false;
        this.scheduleReconnect();
      });
      ws.on("error", () => ws.close());
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const backoff = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), backoff);
  }

  private onMessage(raw: WebSocket.RawData) {
    try {
      const msg = JSON.parse(raw.toString()) as {
        channel?: string;
        data?: any;
      };
      if (msg.channel !== "trades" || !Array.isArray(msg.data)) return;
      // msg.data is an array of { coin, side, px, sz, time, ... }
      for (const d of msg.data) {
        const coin = String(d.coin ?? "");
        if (!coin) continue;
        const symbol = `${coin}USDT`;
        this.emit("trade", {
          source: "hyperliquid" as const,
          symbol,
          price: String(d.px),
          quantity: String(d.sz),
          isBuyerMaker: d.side === "A", // "A" = ask-hit (seller was taker)
          timestamp: Number(d.time ?? Date.now()),
        });
      }
    } catch {
      // ignore malformed frames
    }
  }
}
