import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  CrosshairMode,
  LineStyle,
} from "lightweight-charts";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";

type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

const INTERVALS: { label: string; value: Interval }[] = [
  { label: "分时", value: "1m" },
  { label: "15分", value: "15m" },
  { label: "1时", value: "1h" },
  { label: "4时", value: "4h" },
  { label: "日K", value: "1d" },
  { label: "周K", value: "1w" },
];

type Kline = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type OHLCStats = { open: number; high: number; low: number; close: number };

/** Compute simple moving average series from kline data */
function computeMA(candles: Kline[], period: number): { time: UTCTimestamp; value: number }[] {
  const result: { time: UTCTimestamp; value: number }[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j]!.close;
    result.push({ time: candles[i]!.time, value: sum / period });
  }
  return result;
}

function computeVolumeMA(candles: Kline[], period: number): { time: UTCTimestamp; value: number }[] {
  const result: { time: UTCTimestamp; value: number }[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j]!.volume;
    result.push({ time: candles[i]!.time, value: sum / period });
  }
  return result;
}

/**
 * MarketLiveChart — 高性能实时 K 线组件
 *
 * 修复要点：
 * - 图表创建、历史数据加载、WS 订阅全部在同一个 useEffect 内完成，
 *   彻底消除 ref 竞态问题（之前两个独立 Effect 导致 series ref 未就绪时 loadHistory 提前返回）
 * - 切换周期时只更新数据，不销毁图表实例，无闪烁
 * - WS 消息通过 requestAnimationFrame 节流
 * - WS 断线后指数退避自动重连（最多 6 次）
 * - 叠加 MA5/MA20 均线 + 成交量 MA5
 */
export function MarketLiveChart({
  symbol,
  height = 360,
  enabled = true,
  disabledReason,
}: {
  symbol: string;
  height?: number;
  enabled?: boolean;
  disabledReason?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // All chart state lives in refs so we don't trigger re-renders from WS messages
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ma5Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ma20Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const volMa5Ref = useRef<ISeriesApi<"Line"> | null>(null);

  // 后端已统一处理参考交易所、价格倍率和偏移，因此图表不再直连 Binance WebSocket，避免与 ticker/orderbook 价格不一致。
  const candleBufferRef = useRef<Kline[]>([]);

  const [interval, setIntervalState] = useState<Interval>("15m");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<OHLCStats | null>(null);
  const [hover, setHover] = useState<OHLCStats | null>(null);
  const stats = hover ?? live;
  const { data: backendKlines, isError } = trpc.exchange.klines.useQuery(
    { symbol, interval, limit: 500 },
    { enabled, refetchInterval: 3000 }
  );

  useEffect(() => {
    candleBufferRef.current = [];
    setLoading(enabled);
    setErr(null);
    setLive(null);
    setHover(null);
    try {
      candleSeriesRef.current?.setData([]);
      volumeSeriesRef.current?.setData([]);
      ma5Ref.current?.setData([]);
      ma20Ref.current?.setData([]);
      volMa5Ref.current?.setData([]);
    } catch { /* ignore chart clear errors */ }
  }, [enabled, interval, symbol]);

  // ── Single unified effect: create chart and paint backend K lines ────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;

    let chart = chartRef.current;
    if (!chart) {
      chart = createChart(el, {
        width: el.clientWidth,
        height,
        layout: {
          background: { color: "transparent" },
          textColor: "#94a3b8",
          fontSize: 11,
          fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(148,163,184,0.07)" },
          horzLines: { color: "rgba(148,163,184,0.07)" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "#3b82f6", style: LineStyle.Dashed, width: 1 },
          horzLine: { color: "#3b82f6", style: LineStyle.Dashed, width: 1 },
        },
        rightPriceScale: {
          borderColor: "rgba(148,163,184,0.12)",
          scaleMargins: { top: 0.06, bottom: 0.32 },
        },
        timeScale: {
          borderColor: "rgba(148,163,184,0.12)",
          timeVisible: true,
          secondsVisible: false,
        },
        autoSize: false,
      });
      chartRef.current = chart;

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderUpColor: "#22c55e",
        borderDownColor: "#ef4444",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
      });
      candleSeriesRef.current = candleSeries;

      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      volumeSeriesRef.current = volumeSeries;

      ma5Ref.current = chart.addSeries(LineSeries, {
        color: "#f59e0b",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      ma20Ref.current = chart.addSeries(LineSeries, {
        color: "#818cf8",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      volMa5Ref.current = chart.addSeries(LineSeries, {
        color: "rgba(251,191,36,0.6)",
        lineWidth: 1,
        priceScaleId: "vol",
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

      chart.subscribeCrosshairMove((param) => {
        if (!param.point || !param.seriesData) {
          setHover(null);
          return;
        }
        const cd = param.seriesData.get(candleSeries) as OHLCStats | undefined;
        setHover(cd ?? null);
      });

      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const ro = new ResizeObserver(() => {
        if (resizeTimer) return;
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          chartRef.current?.applyOptions({ width: el.clientWidth, height });
        }, 120);
      });
      ro.observe(el);
      (chart as unknown as { _ro: ResizeObserver })._ro = ro;
    }

    if (!enabled) {
      candleBufferRef.current = [];
      setLoading(false);
      setErr(disabledReason ?? "该市场未启用后端 K 线数据");
      setLive(null);
      setHover(null);
      try {
        candleSeriesRef.current?.setData([]);
        volumeSeriesRef.current?.setData([]);
        ma5Ref.current?.setData([]);
        ma20Ref.current?.setData([]);
        volMa5Ref.current?.setData([]);
      } catch { /* ignore chart clear errors */ }
      return;
    }

    setLoading(!backendKlines);
    setErr(isError ? "行情加载失败，请检查后端行情服务" : null);
    if (!backendKlines) return;

    const candles: Kline[] = backendKlines.map((k) => ({
      time: Math.floor(Number(k.openTime) / 1000) as UTCTimestamp,
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    })).filter((k) => Number.isFinite(k.time) && Number.isFinite(k.open) && Number.isFinite(k.high) && Number.isFinite(k.low) && Number.isFinite(k.close));

    candleBufferRef.current = candles;
    candleSeriesRef.current?.setData(candles);
    volumeSeriesRef.current?.setData(candles.map((c) => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)",
    })));
    ma5Ref.current?.setData(computeMA(candles, 5));
    ma20Ref.current?.setData(computeMA(candles, 20));
    volMa5Ref.current?.setData(computeVolumeMA(candles, 5));
    chartRef.current?.timeScale().fitContent();
    setLoading(false);
    if (candles.length) {
      const last = candles[candles.length - 1]!;
      setLive({ open: last.open, high: last.high, low: last.low, close: last.close });
    }
  }, [backendKlines, disabledReason, enabled, height, interval, isError, symbol]);

  // Destroy chart only when component unmounts
  useEffect(() => {
    return () => {
      const chart = chartRef.current;
      if (chart) {
        const ro = (chart as unknown as { _ro?: ResizeObserver })._ro;
        if (ro) ro.disconnect();
        chart.remove();
        chartRef.current = null;
        candleSeriesRef.current = null;
        volumeSeriesRef.current = null;
        ma5Ref.current = null;
        ma20Ref.current = null;
        volMa5Ref.current = null;
      }
    };
  }, []);

  const changePct = useMemo(() => {
    if (!stats || stats.open === 0) return null;
    return ((stats.close - stats.open) / stats.open) * 100;
  }, [stats]);

  return (
    <div className="flex flex-col bg-card">
      {/* Period tabs + MA legend */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border/70 overflow-x-auto no-scrollbar">
        {INTERVALS.map((it) => (
          <button
            key={it.value}
            onClick={() => setIntervalState(it.value)}
            className={cn(
              "px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors",
              interval === it.value
                ? "bg-primary/15 text-primary font-semibold"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
          >
            {it.label}
          </button>
        ))}
        {/* MA legend */}
        <div className="ml-auto flex items-center gap-2 text-[9px] font-mono whitespace-nowrap">
          <span className="flex items-center gap-0.5">
            <span className="inline-block w-3 h-0.5 rounded" style={{ background: "#f59e0b" }} />
            <span className="text-muted-foreground">MA5</span>
          </span>
          <span className="flex items-center gap-0.5">
            <span className="inline-block w-3 h-0.5 rounded" style={{ background: "#818cf8" }} />
            <span className="text-muted-foreground">MA20</span>
          </span>
          {!loading && !err && (
            <span className="relative flex h-1.5 w-1.5 ml-1">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
            </span>
          )}
        </div>
      </div>

      {/* OHLC row */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] font-mono text-muted-foreground h-[26px]">
        {stats ? (
          <>
            <span>开 <span className="text-foreground">{stats.open}</span></span>
            <span>高 <span className="text-green-400">{stats.high}</span></span>
            <span>低 <span className="text-red-400">{stats.low}</span></span>
            <span>
              收{" "}
              <span className={cn(changePct != null && changePct >= 0 ? "text-green-400" : "text-red-400")}>
                {stats.close}
              </span>
            </span>
            {changePct != null && (
              <span className={cn(changePct >= 0 ? "text-green-400" : "text-red-400")}>
                {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
              </span>
            )}
          </>
        ) : (
          <span className="opacity-0">placeholder</span>
        )}
      </div>

      {/* Chart canvas */}
      <div className="relative w-full" style={{ height }}>
        <div ref={containerRef} className="absolute inset-0" />
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noreferrer"
          className="absolute bottom-2 left-3 z-[2] rounded-full bg-background/80 px-2 py-0.5 text-[9px] font-medium text-muted-foreground shadow-sm ring-1 ring-border/60 backdrop-blur-sm"
        >
          TradingView Charts
        </a>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/80 z-10">
            <div className="flex flex-col items-center gap-2">
              <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <span className="text-xs text-muted-foreground">正在加载 K 线…</span>
            </div>
          </div>
        )}
        {err && !loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/80 z-10">
            <div className="flex flex-col items-center gap-2">
              <span className="text-amber-400 text-sm text-center px-4">{err}</span>
              <button
                className="text-xs text-primary hover:underline"
                onClick={() => setIntervalState((iv) => iv)} // trigger re-run
              >
                点击重试
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
