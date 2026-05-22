import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { MarketSeed } from "../../../shared/markets";

/**
 * OKX public WebSocket source. Subscribes to `tickers` and `trades` channels
 * for each configured spot symbol and emits events with the same shape that
 * the Binance source produces, so the aggregator can merge them blindly.
 *
 * OKX instId format: "BTC-USDT" (with a dash).
 */
export class OkxSource extends EventEmitter {
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

  private okxInstId(symbol: string) {
    return symbol.replace("USDT", "-USDT");
  }

  private connect() {
    if (this.closed) return;
    try {
      const ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public", {
        handshakeTimeout: 5000,
      });
      this.ws = ws;
      ws.on("open", () => {
        this.reconnectAttempts = 0;
        this.live = true;
        const args: { channel: string; instId: string }[] = [];
        for (const s of this.seeds) {
          const inst = this.okxInstId(s.symbol);
          args.push({ channel: "tickers", instId: inst });
          args.push({ channel: "trades", instId: inst });
        }
        // OKX caps 4096 bytes per subscribe; batch in chunks of ~40 args.
        for (let i = 0; i < args.length; i += 40) {
          ws.send(
            JSON.stringify({ op: "subscribe", args: args.slice(i, i + 40) })
          );
        }
        console.log("[marketdata.okx] WS connected");
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
        arg?: { channel?: string; instId?: string };
        data?: any[];
      };
      if (!msg.arg || !msg.data) return;
      const channel = msg.arg.channel;
      const inst = msg.arg.instId ?? "";
      const symbol = inst.replace("-", ""); // "BTC-USDT" → "BTCUSDT"
      if (channel === "tickers") {
        for (const d of msg.data) {
          // OKX tickers: { last, open24h, high24h, low24h, volCcy24h, vol24h }
          this.emit("ticker", {
            source: "okx" as const,
            symbol,
            lastPrice: String(d.last),
            high24h: String(d.high24h),
            low24h: String(d.low24h),
            open24h: d.open24h ? String(d.open24h) : undefined,
            volume24h: String(d.vol24h ?? "0"),
            quoteVolume24h: String(d.volCcy24h ?? "0"),
            ts: Number(d.ts ?? Date.now()),
          });
        }
      } else if (channel === "trades") {
        for (const d of msg.data) {
          this.emit("trade", {
            source: "okx" as const,
            symbol,
            price: String(d.px),
            quantity: String(d.sz),
            isBuyerMaker: d.side === "sell", // taker=buy → maker=seller
            timestamp: Number(d.ts ?? Date.now()),
          });
        }
      }
    } catch {
      // ignore malformed frames
    }
  }
}
