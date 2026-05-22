/**
 * External WebSocket push.
 *
 * Clients connect to `/ws/v1/public`. They subscribe to a set of streams with:
 *   { "method": "SUBSCRIBE", "params": ["btcusdt@ticker", "btcusdt@depth"], "id": 1 }
 *
 * Streams supported:
 *   - <symbol>@ticker      : TickerSnapshot whenever a symbol's ticker updates
 *   - <symbol>@trade       : individual trade prints
 *   - <symbol>@depth       : snapshot of top-15 book levels on every engine update
 *   - <symbol>@kline_1m    : 1-minute candle updates
 */

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getMarketDataHub } from "../marketdata/hub";
import { getMatchingEngine } from "../matching/engine";

type Client = {
  ws: WebSocket;
  subs: Set<string>;
};

const MAX_WS_CLIENTS = 1000;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 100;
const MAX_SUBSCRIBE_PARAMS_PER_MESSAGE = 100;
const STREAM_RE = /^[a-z0-9_:-]{1,32}@(ticker|trade|depth|kline_1m)$/;

function normalizeStream(value: unknown): string | null {
  const stream = String(value).trim().toLowerCase();
  return STREAM_RE.test(stream) ? stream : null;
}

export function registerExchangeWs(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: "/ws/v1/public", maxPayload: 16 * 1024 });
  const clients = new Set<Client>();

  wss.on("connection", (ws) => {
    if (clients.size >= MAX_WS_CLIENTS) {
      ws.close(1013, "too many connections");
      return;
    }

    const c: Client = { ws, subs: new Set() };
    clients.add(c);
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.method === "SUBSCRIBE") {
          const params = Array.isArray(msg.params) ? msg.params.slice(0, MAX_SUBSCRIBE_PARAMS_PER_MESSAGE) : [];
          for (const item of params) {
            if (c.subs.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) break;
            const stream = normalizeStream(item);
            if (stream) c.subs.add(stream);
          }
          ws.send(JSON.stringify({ result: null, id: msg.id ?? null }));
        } else if (msg.method === "UNSUBSCRIBE") {
          const params = Array.isArray(msg.params) ? msg.params.slice(0, MAX_SUBSCRIBE_PARAMS_PER_MESSAGE) : [];
          for (const item of params) {
            const stream = normalizeStream(item);
            if (stream) c.subs.delete(stream);
          }
          ws.send(JSON.stringify({ result: null, id: msg.id ?? null }));
        } else if (msg.method === "LIST_SUBSCRIPTIONS") {
          ws.send(JSON.stringify({ result: Array.from(c.subs), id: msg.id ?? null }));
        } else {
          ws.send(JSON.stringify({ code: -1100, msg: "Unsupported method", id: msg.id ?? null }));
        }
      } catch {
        ws.send(JSON.stringify({ code: -1100, msg: "Malformed request", id: null }));
      }
    });
    ws.on("close", () => clients.delete(c));
    ws.on("error", () => clients.delete(c));
  });

  const hub = getMarketDataHub();

  hub.on("ticker", (snap) => {
    const stream = `${snap.symbol.toLowerCase()}@ticker`;
    broadcast(stream, {
      stream,
      data: {
        e: "24hrTicker",
        s: snap.symbol,
        c: snap.lastPrice,
        p: snap.change24h,
        P: snap.changePct24h,
        h: snap.high24h,
        l: snap.low24h,
        v: snap.volume24h,
        q: snap.quoteVolume24h,
        E: snap.updatedAt,
      },
    });
  });
  hub.on("trade_print", (t) => {
    const stream = `${t.symbol.toLowerCase()}@trade`;
    broadcast(stream, {
      stream,
      data: { e: "trade", s: t.symbol, p: t.price, q: t.quantity, m: t.isBuyerMaker, T: t.timestamp },
    });
  });
  hub.on("kline", (k) => {
    const stream = `${k.symbol.toLowerCase()}@kline_1m`;
    broadcast(stream, {
      stream,
      data: {
        e: "kline",
        s: k.symbol,
        k: {
          t: k.openTime,
          o: k.open,
          h: k.high,
          l: k.low,
          c: k.close,
          v: k.volume,
          i: k.interval,
        },
      },
    });
  });

  // Push depth periodically (~2 Hz) for all subscribed symbols
  setInterval(async () => {
    if (clients.size === 0) return;
    const engine = await getMatchingEngine();
    const active = new Set<string>();
    for (const c of clients) {
      for (const s of c.subs) {
        if (s.endsWith("@depth")) active.add(s.replace("@depth", "").toUpperCase());
      }
    }
    for (const sym of active) {
      const d = engine.depth(sym, 15);
      const stream = `${sym.toLowerCase()}@depth`;
      broadcast(stream, {
        stream,
        data: { e: "depthUpdate", s: sym, b: d.bids, a: d.asks, E: Date.now() },
      });
    }
  }, 500);

  function broadcast(stream: string, payload: unknown) {
    const s = JSON.stringify(payload);
    for (const c of clients) {
      if (c.subs.has(stream) && c.ws.readyState === WebSocket.OPEN) {
        try {
          c.ws.send(s);
        } catch {
          // ignore
        }
      }
    }
  }
}
