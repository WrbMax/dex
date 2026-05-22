import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { ChevronLeft, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import { splitSymbol } from "@/lib/format";

const LIMIT_STEP = 50;

function formatTime(date: Date | string | null | undefined) {
  if (!date) return "—";
  const d = new Date(date as string);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatNum(v: string | null | undefined, digits = 6) {
  if (!v) return "—";
  const n = parseFloat(v);
  if (isNaN(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export default function TradeHistory() {
  const { user } = useAuth();
  const [symbol, setSymbol] = useState<string>("");
  const [limit, setLimit] = useState(LIMIT_STEP);

  const marketsQ = trpc.exchange.listMarkets.useQuery();
  const tradesQ = trpc.exchange.myTrades.useQuery(
    { symbol: symbol || undefined, limit },
    { enabled: !!user }
  );

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-4">
        <p className="text-muted-foreground text-sm">请先登录查看成交历史</p>
        <a
          href="/"
          className="px-6 py-2 rounded-xl bg-blue-500/80 text-white text-sm font-medium"
        >
          立即登录
        </a>
      </div>
    );
  }

  const trades = tradesQ.data ?? [];
  const markets = marketsQ.data ?? [];
  const symbols = markets.map((m) => m.symbol);

  return (
    <div className="flex flex-col min-h-screen pb-24">
      {/* Header */}
      <div className="sticky top-0 z-20 flex items-center gap-3 px-4 py-3 bg-background/92 backdrop-blur-md border-b border-border/70">
        <Link href="/me">
          <button className="p-1.5 rounded-lg hover:bg-muted transition-colors">
            <ChevronLeft size={20} className="text-muted-foreground" />
          </button>
        </Link>
        <h1 className="text-sm font-semibold text-foreground flex-1">成交历史</h1>
        <button
          onClick={() => tradesQ.refetch()}
          className="p-1.5 rounded-lg hover:bg-muted transition-colors"
        >
          <RefreshCw size={16} className={`text-muted-foreground ${tradesQ.isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Filter */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
          <button
            onClick={() => { setSymbol(""); setLimit(LIMIT_STEP); }}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              symbol === ""
                ? "bg-primary text-primary-foreground"
                : "ui-secondary-button text-muted-foreground hover:text-foreground"
            }`}
          >
            全部
          </button>
          {symbols.map((s) => (
            <button
              key={s}
              onClick={() => { setSymbol(s); setLimit(LIMIT_STEP); }}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                symbol === s
                  ? "bg-primary text-primary-foreground"
                  : "ui-secondary-button text-muted-foreground hover:text-foreground"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-4">
        {tradesQ.isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-blue-400/40 border-t-blue-400 rounded-full animate-spin" />
          </div>
        ) : trades.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-1">
              <TrendingUp size={22} className="text-muted-foreground" />
            </div>
            <p className="text-muted-foreground text-sm">暂无成交记录</p>
            <p className="text-muted-foreground/70 text-xs">下单成交后将在此显示</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 pt-1">
            {trades.map((t) => {
              const isBuyer = t.buyerUserId === user.id;
              const side = isBuyer ? "buy" : "sell";
              const fee = isBuyer ? parseFloat(t.buyerFee ?? "0") : parseFloat(t.sellerFee ?? "0");
              const quoteQty = parseFloat(t.quoteQty ?? "0");
              const { base, quote } = splitSymbol(t.symbol);
              // 撮合引擎当前按成交额计收手续费，买卖双方手续费均以计价币种入账。
              const feeAsset = quote || "USDT";
              const actualQuoteAmount = isBuyer ? quoteQty + fee : Math.max(quoteQty - fee, 0);

              return (
                <div
                  key={t.id}
                  className="rounded-2xl p-3.5 ui-surface"
                >
                  {/* Row 1: symbol + side + time */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{t.symbol}</span>
                      <span
                        className="flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded-md"
                        style={{
                          background: side === "buy" ? "rgba(74,222,128,0.15)" : "rgba(248,113,113,0.15)",
                          color: side === "buy" ? "#4ade80" : "#f87171",
                        }}
                      >
                        {side === "buy" ? (
                          <TrendingUp size={11} />
                        ) : (
                          <TrendingDown size={11} />
                        )}
                        {side === "buy" ? "买入" : "卖出"}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">{formatTime(t.createdAt)}</span>
                  </div>

                  {/* Row 2: price / qty / total / fee */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">成交价</p>
                      <p className="text-sm font-medium text-foreground">{formatNum(t.price, 4)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">数量</p>
                      <p className="text-sm font-medium text-foreground">{formatNum(t.quantity, 8)} {base}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">成交额</p>
                      <p className="text-sm font-medium text-foreground">{formatNum(t.quoteQty, 2)} {quote}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">手续费</p>
                      <p className="text-sm font-medium" style={{ color: "#facc15" }}>
                        {fee > 0 ? `${fee.toLocaleString("en-US", { maximumFractionDigits: 8 })} ${feeAsset}` : "0"}
                      </p>
                    </div>
                    <div className="col-span-2 mt-1 pt-2 border-t border-border/70 flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">{isBuyer ? "实际扣款" : "实际到账"}</p>
                      <p className="text-sm font-semibold text-foreground">
                        {actualQuoteAmount.toLocaleString("en-US", { maximumFractionDigits: 8 })} {quote}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Load more */}
            {trades.length >= limit && (
              <button
                onClick={() => setLimit((l) => l + LIMIT_STEP)}
                className="w-full py-3 text-sm text-blue-400 hover:text-blue-300 transition-colors"
              >
                加载更多
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
