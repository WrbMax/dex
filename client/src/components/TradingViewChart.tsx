import { useEffect, useRef } from "react";

/**
 * Embeds TradingView's official Advanced Chart widget.
 *
 * Docs: https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/
 *
 * - Uses Binance as the price source (BINANCE:{SYMBOL})
 * - Dark theme tuned to match the wallet's navy palette
 * - Full periods + 100+ indicators + drawing tools out of the box
 * - Re-creates the widget whenever the symbol changes
 *
 * If the TradingView script fails to load (e.g. blocked network), the caller
 * is responsible for rendering a fallback. We expose `onError` for that.
 */
export function TradingViewChart({
  symbol,
  height = 420,
  onError,
}: {
  /** e.g. "BTCUSDT" */
  symbol: string;
  height?: number;
  onError?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    host.innerHTML = "";

    // container div TradingView will inject into
    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.height = "100%";
    inner.style.width = "100%";
    host.appendChild(inner);

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.onerror = () => {
      onError?.();
    };

    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: `BINANCE:${symbol.toUpperCase()}`,
      interval: "15",
      timezone: "Asia/Singapore",
      theme: "dark",
      style: "1",
      locale: "zh_CN",
      backgroundColor: "#0b1026",
      gridColor: "rgba(255,255,255,0.06)",
      hide_top_toolbar: false,
      hide_legend: false,
      hide_side_toolbar: false,
      allow_symbol_change: false,
      withdateranges: true,
      save_image: false,
      studies: ["STD;MA%1Cross", "STD;MACD", "STD;RSI"],
      support_host: "https://www.tradingview.com",
    });

    host.appendChild(script);

    // If the script takes too long (>8s) to inject the iframe, fall back.
    const timeout = window.setTimeout(() => {
      if (!host.querySelector("iframe")) {
        onError?.();
      }
    }, 8000);

    return () => {
      window.clearTimeout(timeout);
      host.innerHTML = "";
    };
  }, [symbol, onError]);

  return (
    <div
      ref={hostRef}
      className="tradingview-widget-container w-full rounded-xl overflow-hidden"
      style={{ height }}
    />
  );
}
