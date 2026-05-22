import { memo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtAmount, fmtPct, fmtPrice, fmtQuantity, splitSymbol } from "@/lib/format";
import { MarketLiveChart } from "@/components/MarketLiveChart";
import { DepthChart } from "@/components/DepthChart";
import {
  OrderBookBlock,
  PairHeader,
  TradesList,
} from "@/components/trade/TradeCommon";

const MemoChart = memo(function MemoChart({
  symbol,
  enabled,
  disabledReason,
}: {
  symbol: string;
  enabled: boolean;
  disabledReason: string;
}) {
  return <MarketLiveChart symbol={symbol} height={340} enabled={enabled} disabledReason={disabledReason} />;
});

type Tab = "book" | "depth" | "trades" | "info";

export default function QuotePair() {
  const [, params] = useRoute("/quote/:symbol");
  const [, setLocation] = useLocation();
  const symbol = (params?.symbol ?? "BTCUSDT").toUpperCase();
  const { base, quote } = splitSymbol(symbol);

  const [tab, setTab] = useState<Tab>("book");
  const { data: marketInfo } = trpc.exchange.listMarkets.useQuery(undefined, {
    staleTime: 30_000,
  });
  const market = marketInfo?.find((m) => m.symbol === symbol);
  const marketMode = market?.marketMode ?? "binance_mirror";
  const marketDataSource = market?.marketDataSource ?? "binance";
  const backendChartEnabled = marketMode === "binance_mirror" && marketDataSource === "binance";
  const tradingEnabled = market?.isActive !== false;
  const allowMarketOrder = market?.allowMarketOrder !== false;
  const chartDisabledReason = marketMode === "orderbook"
    ? "该交易对暂未接入专业 K 线服务，盘口与最新成交请以实时订单簿为准"
    : "该交易对暂未接入专业 K 线服务";
  const projectDescription = market?.description?.trim();
  const projectLinks = [
    ["官网", market?.websiteUrl],
    ["白皮书", market?.whitepaperUrl],
    ["区块浏览器", market?.explorerUrl],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  const { data: ticker } = trpc.exchange.ticker.useQuery(
    { symbol },
    { refetchInterval: 2000 }
  );
  const { data: depth, isError: depthError, refetch: refetchDepth } = trpc.exchange.orderBook.useQuery(
    { symbol, depth: 15 },
    {
      refetchInterval: 1500,
      retry: 3,
      retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
    }
  );
  const { data: trades } = trpc.exchange.recentTrades.useQuery(
    { symbol, limit: 30 },
    { refetchInterval: 2000 }
  );

  const lastPrice = Number(ticker?.lastPrice ?? 0);
  const pct = Number(ticker?.changePct24h ?? 0);
  const high24 = Number(ticker?.high24h ?? 0);
  const low24 = Number(ticker?.low24h ?? 0);
  const vol24 = Number(ticker?.volume24h ?? 0);
  const up = pct >= 0;

  const goTrade = (side: "buy" | "sell") =>
    setLocation(`/trade/${symbol}?side=${side}${lastPrice ? `&price=${lastPrice}` : ``}`);

  return (
    <div
      className="w-full min-h-screen flex flex-col bg-background"
      style={{ paddingBottom: "calc(72px + env(safe-area-inset-bottom))" }}
    >
      {/* Header */}
      <PairHeader symbol={symbol} pct={pct} backHref="/market" />

      {/* Price summary */}
      <section className="mx-3 mt-2 mb-2 overflow-hidden rounded-[22px] border border-border/70 bg-card/95 shadow-sm">
        <div className="px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div
                className={cn(
                  "font-mono text-[28px] font-bold leading-none tracking-tight",
                  up ? "text-up" : "text-down"
                )}
              >
                {fmtPrice(lastPrice)}
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
                <span>≈ ¥{fmtPrice(lastPrice * 7.2, 2)}</span>
                <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                <span>{base}/{quote}</span>
              </div>
            </div>
            <div
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold font-mono",
                up ? "bg-up/10 text-up" : "bg-down/10 text-down"
              )}
            >
              {fmtPct(pct)}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-3 overflow-hidden rounded-2xl border border-border/60 bg-muted/35 text-center font-mono">
            {[
              ["24h 高", fmtPrice(high24)],
              ["24h 低", fmtPrice(low24)],
              [`24h 量(${base})`, fmtQuantity(vol24)],
            ].map(([label, value]) => (
              <div key={label} className="px-2.5 py-2.5 [&:not(:last-child)]:border-r [&:not(:last-child)]:border-border/60">
                <div className="text-[10px] text-muted-foreground">{label}</div>
                <div className="mt-1 truncate text-[11px] font-semibold text-foreground">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Chart */}
      <div className="mx-3 mt-2 overflow-hidden rounded-[22px] border border-border/70 bg-card shadow-sm">
        <MemoChart key={symbol} symbol={symbol} enabled={backendChartEnabled} disabledReason={chartDisabledReason} />
      </div>

      {/* Tabs */}
      <div className="px-3 pt-3">
        <div className="mb-3 rounded-[18px] border border-border/70 bg-card/95 p-1 shadow-sm">
          <div className="grid grid-cols-4 gap-1">
            {(
              [
                { k: "book" as const, label: "订单簿" },
                { k: "depth" as const, label: "深度图" },
                { k: "trades" as const, label: "最新成交" },
                { k: "info" as const, label: "资料" },
              ]
            ).map((t) => (
              <button
                key={t.k}
                onClick={() => setTab(t.k)}
                className={cn(
                  "h-9 rounded-[14px] text-xs font-semibold transition-all duration-150",
                  tab === t.k
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-foreground/70 hover:bg-muted/70 hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {tab === "book" && (
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground px-1 pb-1.5 font-mono">
              <span>价格({quote})</span>
              <span>数量({base})</span>
            </div>
            {depthError && !depth ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <span className="text-xs text-muted-foreground">订单簿加载失败</span>
                <button onClick={() => refetchDepth()} className="text-xs text-primary hover:underline">点击重试</button>
              </div>
            ) : !depth ? (
              <div className="flex flex-col gap-0.5 p-1 animate-pulse">
                {Array.from({ length: 15 }).map((_, i) => (
                  <div key={i} className="h-[22px] rounded bg-muted" style={{ width: `${50 + Math.random() * 40}%`, marginLeft: i < 7 ? 'auto' : undefined }} />
                ))}
              </div>
            ) : (
              <OrderBookBlock
                asks={(depth.asks ?? []).map(([p, q]) => ({ price: p, quantity: q }))}
                bids={(depth.bids ?? []).map(([p, q]) => ({ price: p, quantity: q }))}
                lastPrice={lastPrice}
                pctPositive={up}
                onPick={(p, side) => setLocation(`/trade/${symbol}?side=${side === "ask" ? "buy" : "sell"}&price=${p}`)}
              />
            )}
          </div>
        )}

        {tab === "depth" && (
          <div className="rounded-2xl overflow-hidden ui-surface">
            {!depth ? (
              <div className="flex items-center justify-center py-10 text-xs text-muted-foreground animate-pulse">加载深度数据…</div>
            ) : (
              <DepthChart
                asks={(depth.asks ?? []).map(([p, q]) => ({ price: p, quantity: q }))}
                bids={(depth.bids ?? []).map(([p, q]) => ({ price: p, quantity: q }))}
                lastPrice={lastPrice}
                height={220}
              />
            )}
          </div>
        )}

        {tab === "trades" && (
          <TradesList trades={trades ?? []} base={base} quote={quote} />
        )}

        {tab === "info" && (
          <div className="p-4 rounded-2xl text-[12px] text-muted-foreground space-y-3 leading-relaxed ui-surface">
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">About {base}</div>
              <h3 className="mt-1 text-base font-semibold text-foreground">关于 {base}</h3>
              <p className="mt-2">
                {projectDescription || `${base} 是 ${base}/${quote} 现货交易对的基础资产，${quote} 为报价资产。你可以在本页面查看实时 K 线、盘口深度、最近成交以及关键交易规则。`}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                ["现货交易对", `${base}/${quote}`],
                ["报价资产", quote],
                ["基础资产", base],
                ["交易状态", tradingEnabled ? "可交易" : "暂停"],
                ["最小下单量", `${market?.amountStep ?? "--"} ${base}`],
                ["最小下单额", `${market?.minNotional ?? "--"} ${quote}`],
                ["Maker 手续费", market?.makerFee ? `${(Number(market.makerFee) * 100).toFixed(3)}%` : "--"],
                ["Taker 手续费", market?.takerFee ? `${(Number(market.takerFee) * 100).toFixed(3)}%` : "--"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl p-3 ui-surface-soft">
                  <div className="text-[10px] text-muted-foreground">{k}</div>
                  <div className="mt-1 text-foreground font-mono truncate">{v}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                ["24h 成交额", `$${fmtAmount(vol24 * lastPrice, 2)}`],
                ["24h 成交量", `${fmtQuantity(vol24)} ${base}`],
                ["24h 最高价", `$${fmtAmount(high24, 2)}`],
                ["24h 最低价", `$${fmtAmount(low24, 2)}`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl p-3 ui-surface-soft">
                  <div className="text-[10px] text-muted-foreground">{k}</div>
                  <div className="mt-1 text-foreground font-mono truncate">{v}</div>
                </div>
              ))}
            </div>
            {(projectLinks.length > 0 || market?.contractAddress) && (
              <div className="space-y-2 rounded-xl p-3 ui-surface-soft">
                {projectLinks.map(([label, url]) => (
                  <a key={label} href={url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 text-primary hover:underline">
                    <span>{label}</span><span className="truncate text-right max-w-[220px]">{url}</span>
                  </a>
                ))}
                {market?.contractAddress && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">合约地址</span><span className="text-foreground font-mono text-right break-all">{market.contractAddress}</span>
                  </div>
                )}
              </div>
            )}
            <div className="mt-3 pt-3 border-t border-border/70 text-[11px] text-muted-foreground/70">
              以上信息仅用于展示交易对规则与市场数据，不构成投资建议。
            </div>
          </div>
        )}
      </div>

      {/* Sticky bottom CTA */}
      <div
        className="fixed bottom-0 left-1/2 z-50 w-full max-w-[520px] -translate-x-1/2 border-t border-border/70 bg-background/92 px-3 py-2.5 shadow-[0_-10px_30px_rgba(15,23,42,0.08)] backdrop-blur-xl"
        style={{ paddingBottom: "calc(10px + env(safe-area-inset-bottom))" }}
      >
        <div className="grid grid-cols-2 gap-2 rounded-[22px] bg-card/80 p-1.5 ring-1 ring-border/60">
          <button
            onClick={() => tradingEnabled && allowMarketOrder && goTrade("buy")}
            disabled={!tradingEnabled || !allowMarketOrder}
            className="h-11 rounded-[18px] font-semibold text-sm text-white shadow-sm transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, oklch(0.74 0.18 152), oklch(0.66 0.16 158))" }}
          >
            {!tradingEnabled ? "交易暂停" : !allowMarketOrder ? "市价关闭" : `买入 ${base}`}
          </button>
          <button
            onClick={() => tradingEnabled && allowMarketOrder && goTrade("sell")}
            disabled={!tradingEnabled || !allowMarketOrder}
            className="h-11 rounded-[18px] font-semibold text-sm text-white shadow-sm transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, oklch(0.67 0.22 20), oklch(0.62 0.2 12))" }}
          >
            {!tradingEnabled ? "交易暂停" : !allowMarketOrder ? "市价关闭" : `卖出 ${base}`}
          </button>
        </div>
      </div>
    </div>
  );
}
