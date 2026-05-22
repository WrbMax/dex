import { useEffect, useRef, useState } from "react";

export interface BinanceTicker {
  lastPrice: number;   // 最新成交价
  changePct24h: number; // 24h 涨跌幅 %
  high24h: number;     // 24h 最高价
  low24h: number;      // 24h 最低价
  volume24h: number;   // 24h 成交量
}

/**
 * useBinanceTicker — 直接订阅币安现货 WebSocket miniTicker 流
 *
 * 使用 wss://stream.binance.com:9443/ws/<symbol>@miniTicker
 * 推送频率约 1 秒，延迟极低，与币安现货完全同步。
 *
 * 当 WebSocket 断开时自动重连（指数退避，最长 30s）。
 */
export function useBinanceTicker(symbol: string, enabled: boolean = true): BinanceTicker | null {
  const [ticker, setTicker] = useState<BinanceTicker | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    retryCount.current = 0;
    setTicker(null);

    if (!enabled) {
      return () => {
        mountedRef.current = false;
        if (retryRef.current) clearTimeout(retryRef.current);
        if (wsRef.current) {
          wsRef.current.onclose = null;
          wsRef.current.close();
          wsRef.current = null;
        }
      };
    }

    function connect() {
      if (!mountedRef.current) return;

      const sym = symbol.toLowerCase();
      const url = `wss://stream.binance.com:9443/ws/${sym}@miniTicker`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        retryCount.current = 0; // 连接成功，重置重试计数
      };

      ws.onmessage = (evt) => {
        if (!mountedRef.current) return;
        try {
          const d = JSON.parse(evt.data as string);
          // miniTicker 字段：c=最新价, P=涨跌幅%, h=最高, l=最低, v=成交量
          if (d.e === "24hrMiniTicker") {
            setTicker({
              lastPrice: parseFloat(d.c),
              changePct24h: parseFloat(d.P ?? "0"),
              high24h: parseFloat(d.h),
              low24h: parseFloat(d.l),
              volume24h: parseFloat(d.v),
            });
          }
        } catch {
          // 忽略解析错误
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        // 指数退避重连：1s, 2s, 4s, 8s, 16s, 30s（上限）
        const delay = Math.min(1000 * Math.pow(2, retryCount.current), 30000);
        retryCount.current += 1;
        retryRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (retryRef.current) clearTimeout(retryRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // 阻止重连
        wsRef.current.close();
      }
    };
  }, [symbol, enabled]);

  return ticker;
}
