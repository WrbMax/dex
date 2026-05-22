import { useEffect, useRef, useState, useCallback } from "react";

export type OrderBookLevel = [string, string]; // [price, quantity]

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

/**
 * useOrderBookWs — 订单簿实时 WebSocket 钩子
 *
 * 使用 Binance Combined Stream 同时订阅：
 *   - @depth@100ms  增量买卖盘更新（本地维护完整快照）
 *   - @trade        最新成交流（实时更新 lastPrice）
 *
 * 这样深度档位和中间最新成交价来自同一 WebSocket 连接，时间完全同步。
 *
 * 协议（Binance Combined Diff Depth Stream）：
 * 1. 首先获取 REST 快照（/api/v3/depth?limit=20）
 * 2. 订阅 @depth@100ms 流，缓冲快照前的事件
 * 3. 快照到达后，丢弃 lastUpdateId < snapshot.lastUpdateId 的事件
 * 4. 应用剩余增量：qty=0 表示删除该价位
 *
 * 如果 WebSocket 不可用（网络限制），自动降级为轮询模式（每 1.5s）。
 */
export function useOrderBookWs(
  symbol: string,
  depth: number = 15,
  /** Optional: merge internal exchange orders into the book */
  internalBook?: OrderBook | null,
  enabled: boolean = true
): { book: OrderBook | null; connected: boolean; error: boolean; lastPrice: number | null } {
  const [book, setBook] = useState<OrderBook | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(false);
  const [lastPrice, setLastPrice] = useState<number | null>(null);

  // Local order book state maintained in refs to avoid stale closures
  const bidsMapRef = useRef<Map<string, string>>(new Map());
  const asksMapRef = useRef<Map<string, string>>(new Map());
  const snapshotIdRef = useRef<number>(0);
  const bufferedEventsRef = useRef<Array<{
    U: number; u: number;
    b: OrderBookLevel[]; a: OrderBookLevel[];
  }>>([]);
  const snapshotLoadedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const wsDestroyedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fallbackModeRef = useRef(false);

  const applyUpdate = useCallback((bids: OrderBookLevel[], asks: OrderBookLevel[]) => {
    for (const [price, qty] of bids) {
      if (parseFloat(qty) === 0) bidsMapRef.current.delete(price);
      else bidsMapRef.current.set(price, qty);
    }
    for (const [price, qty] of asks) {
      if (parseFloat(qty) === 0) asksMapRef.current.delete(price);
      else asksMapRef.current.set(price, qty);
    }
  }, []);

  const publishBook = useCallback((internal?: OrderBook | null) => {
    // Sort bids descending, asks ascending; take top N
    const bids: OrderBookLevel[] = Array.from(bidsMapRef.current.entries())
      .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
      .slice(0, depth);
    const asks: OrderBookLevel[] = Array.from(asksMapRef.current.entries())
      .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
      .slice(0, depth);

    // Merge internal orders if provided
    if (internal) {
      const mergeInto = (levels: OrderBookLevel[], internalLevels: OrderBookLevel[], desc: boolean) => {
        const map = new Map<string, number>(levels.map(([p, q]) => [p, parseFloat(q)]));
        for (const [p, q] of internalLevels) {
          const existing = map.get(p) ?? 0;
          map.set(p, existing + parseFloat(q));
        }
        return Array.from(map.entries())
          .sort((a, b) => desc ? parseFloat(b[0]) - parseFloat(a[0]) : parseFloat(a[0]) - parseFloat(b[0]))
          .slice(0, depth)
          .map(([p, q]) => [p, q.toFixed(8)] as OrderBookLevel);
      };
      setBook({
        bids: mergeInto(bids, internal.bids, true),
        asks: mergeInto(asks, internal.asks, false),
      });
    } else {
      setBook({ bids, asks });
    }
  }, [depth]);

  const loadSnapshot = useCallback(async (sym: string, signal: AbortSignal) => {
    try {
      const res = await fetch(
        `https://api.binance.com/api/v3/depth?symbol=${sym}&limit=20`,
        { signal }
      );
      if (!res.ok) throw new Error("depth snapshot " + res.status);
      const data = await res.json() as {
        lastUpdateId: number;
        bids: OrderBookLevel[];
        asks: OrderBookLevel[];
      };
      if (signal.aborted) return;

      snapshotIdRef.current = data.lastUpdateId;
      bidsMapRef.current.clear();
      asksMapRef.current.clear();

      for (const [p, q] of data.bids) bidsMapRef.current.set(p, q);
      for (const [p, q] of data.asks) asksMapRef.current.set(p, q);

      // Apply buffered events that arrived after snapshot
      for (const ev of bufferedEventsRef.current) {
        if (ev.u <= data.lastUpdateId) continue; // stale, skip
        applyUpdate(ev.b, ev.a);
        snapshotIdRef.current = ev.u;
      }
      bufferedEventsRef.current = [];
      snapshotLoadedRef.current = true;
      publishBook();
    } catch (e) {
      if (signal.aborted) return;
      console.warn("depth snapshot failed", e);
    }
  }, [applyUpdate, publishBook]);

  useEffect(() => {
    wsDestroyedRef.current = false;
    snapshotLoadedRef.current = false;
    bufferedEventsRef.current = [];
    bidsMapRef.current.clear();
    asksMapRef.current.clear();
    reconnectAttemptsRef.current = 0;
    fallbackModeRef.current = false;
    setBook(null);
    setLastPrice(null);

    const abortCtrl = new AbortController();

    if (!enabled) {
      setConnected(false);
      setError(false);
      return () => {
        wsDestroyedRef.current = true;
        abortCtrl.abort();
        if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
        if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
        if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
        setConnected(false);
      };
    }

    const startWs = () => {
      if (wsDestroyedRef.current) return;

      const sym = symbol.toLowerCase();
      // Combined stream: depth@100ms + trade（同一连接，时间完全同步）
      const streams = `${sym}@depth@100ms/${sym}@trade`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
      } catch {
        enterFallback();
        return;
      }
      wsRef.current = ws;

      // Start snapshot load in parallel with WS connection
      loadSnapshot(symbol, abortCtrl.signal);

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setConnected(true);
        setError(false);
      };

      ws.onmessage = (ev) => {
        try {
          // Combined stream 格式: { stream: "btcusdt@depth@100ms", data: {...} }
          const wrapper = JSON.parse(ev.data as string) as {
            stream: string;
            data: Record<string, unknown>;
          };
          const { stream, data } = wrapper;

          if (stream.endsWith("@trade")) {
            // @trade 消息: { e: "trade", p: "price", ... }
            const price = parseFloat(data.p as string);
            if (!isNaN(price) && price > 0) setLastPrice(price);
            return;
          }

          // depth 消息
          const msg = data as {
            U: number; u: number;
            b: OrderBookLevel[]; a: OrderBookLevel[];
          };
          if (!snapshotLoadedRef.current) {
            bufferedEventsRef.current.push(msg);
            return;
          }
          if (msg.u <= snapshotIdRef.current) return;
          applyUpdate(msg.b, msg.a);
          snapshotIdRef.current = msg.u;
          publishBook(internalBook);
        } catch { /* ignore */ }
      };

      ws.onerror = () => { /* handled by onclose */ };
      ws.onclose = () => {
        setConnected(false);
        if (wsDestroyedRef.current) return;
        const attempt = reconnectAttemptsRef.current;
        if (attempt >= 5) {
          enterFallback();
          return;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt), 16000);
        reconnectAttemptsRef.current = attempt + 1;
        reconnectTimerRef.current = setTimeout(startWs, delay);
      };

      // If WS doesn't open within 5s, fall back to polling
      const openTimeout = setTimeout(() => {
        if (!connected && !wsDestroyedRef.current) {
          ws.close();
          enterFallback();
        }
      }, 5000);
      ws.addEventListener("open", () => clearTimeout(openTimeout));
    };

    const enterFallback = () => {
      if (wsDestroyedRef.current || fallbackModeRef.current) return;
      fallbackModeRef.current = true;
      setConnected(false);
      // Poll via REST snapshot every 1.5s
      const poll = async () => {
        try {
          const res = await fetch(
            `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`,
            { signal: abortCtrl.signal }
          );
          if (!res.ok) return;
          const data = await res.json() as { bids: OrderBookLevel[]; asks: OrderBookLevel[] };
          bidsMapRef.current.clear();
          asksMapRef.current.clear();
          for (const [p, q] of data.bids) bidsMapRef.current.set(p, q);
          for (const [p, q] of data.asks) asksMapRef.current.set(p, q);
          publishBook(internalBook);
          setError(false);
        } catch { /* ignore */ }
      };
      poll();
      pollTimerRef.current = setInterval(poll, 1500);
    };

    startWs();

    return () => {
      wsDestroyedRef.current = true;
      abortCtrl.abort();
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
      setConnected(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, enabled]);

  // Re-publish when internalBook changes (without resetting WS)
  useEffect(() => {
    if (book) publishBook(internalBook);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internalBook]);

  return { book, connected, error, lastPrice };
}
