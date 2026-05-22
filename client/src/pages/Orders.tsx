import { Link } from "wouter";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { splitSymbol } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmtPrice, fmtQuantity } from "@/lib/format";
import { toast } from "sonner";

type Tab = "open" | "history";

const STATUS_LABEL: Record<string, string> = {
  new: "待成交", partial: "部分成交", filled: "已全成", canceled: "已撤销", cancelled: "已撤销",
};
const STATUS_COLOR: Record<string, string> = {
  new: "text-muted-foreground bg-muted/30",
  partial: "text-amber-400 bg-amber-400/10",
  filled: "text-up bg-up/10",
  canceled: "text-muted-foreground bg-muted/20",
  cancelled: "text-muted-foreground bg-muted/20",
};

export default function Orders() {
  const [tab, setTab] = useState<Tab>("open");
  const { data: open, refetch: refetchOpen } = trpc.exchange.openOrders.useQuery(
    {},
    { refetchInterval: 2500, placeholderData: (prev) => prev }
  );
  const { data: history } = trpc.exchange.orderHistory.useQuery(
    {},
    { placeholderData: (prev) => prev }
  );

  const cancel = trpc.exchange.cancelOrder.useMutation({
    onSuccess: () => { toast.success("已撤单"); refetchOpen(); },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  const rows = tab === "open" ? open ?? [] : history ?? [];

  return (
    <div className="w-full px-4 pt-4 pb-8">
      {/* Header */}
      <header className="flex items-center gap-2 mb-5">
        <Link href="/">
          <button
            className="tap-target p-1.5 -ml-1.5 rounded-xl ui-secondary-button transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        </Link>
        <h1 className="text-lg font-semibold">订单</h1>
      </header>

      {/* Tabs */}
      <div
        className="flex gap-1 p-1 rounded-xl mb-4 ui-segment"
      >
        {(["open", "history"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-150",
              tab === t
                ? "bg-primary text-primary-foreground"
                : "ui-segment-option"
            )}
          >
            {t === "open" ? "当前委托" : "历史订单"}
          </button>
        ))}
      </div>

      {/* Order list */}
      <ul className="flex flex-col gap-2">
        {rows.map((o) => {
          const { base, quote } = splitSymbol(o.symbol);
          const isMarketBuy = o.type === "market" && o.side === "buy";
          const fillNumerator = isMarketBuy ? Number(o.quoteFilled ?? 0) : Number(o.filledQty ?? 0);
          const fillDenominator = Number(o.quantity ?? 0);
          const fillPct = fillDenominator > 0
            ? Math.min(100, Math.round((fillNumerator / fillDenominator) * 100))
            : 0;
          const quantityLabel = isMarketBuy ? `花费 ${fmtPrice(o.quantity)} ${quote || "USDT"}` : `数量 ${fmtQuantity(o.quantity)} ${base}`;
          const filledLabel = isMarketBuy
            ? `已用 ${fmtPrice(o.quoteFilled ?? "0")} ${quote || "USDT"} / 已得 ${fmtQuantity(o.filledQty)} ${base}`
            : `已成 ${fmtQuantity(o.filledQty)} ${base}`;
          const avgPriceNumber = Number(o.avgPrice ?? 0);
          const hasFill = Number(o.filledQty ?? 0) > 0 && avgPriceNumber > 0;
          const priceLabel = o.type === "limit"
            ? `委托价 ${fmtPrice(o.price ?? "0")}`
            : "市价";
          const avgPriceLabel = hasFill ? `成交均价 ${fmtPrice(o.avgPrice ?? "0")} ${quote || "USDT"}` : null;
          const canCancel = tab === "open" && (o.status === "new" || o.status === "partial");

          return (
            <li
              key={o.id}
              className="px-4 py-3.5 rounded-2xl ui-surface"
            >
              <div className="flex justify-between items-start gap-2">
                <div className="flex-1 min-w-0">
                  {/* Top row: side + symbol + status badge */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("text-sm font-bold", o.side === "buy" ? "text-up" : "text-down")}>
                      {o.side === "buy" ? "买入" : "卖出"}
                    </span>
                    <span className="text-sm font-semibold">{o.symbol}</span>
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                      STATUS_COLOR[o.status] ?? "text-muted-foreground bg-muted/30"
                    )}>
                      {STATUS_LABEL[o.status] ?? o.status}
                    </span>
                  </div>

                  {/* Details row */}
                  <div className="text-xs text-muted-foreground font-mono mt-1.5 flex gap-3 flex-wrap">
                    <span>{priceLabel}</span>
                    {avgPriceLabel && <span className="text-up">{avgPriceLabel}</span>}
                    <span>{quantityLabel}</span>
                    <span>{filledLabel} <span className="text-foreground/60">({fillPct}%)</span></span>
                  </div>

                  {/* Fill progress bar */}
                  {fillPct > 0 && (
                    <div className="mt-2 h-1 rounded-full overflow-hidden bg-muted/70">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${fillPct}%`,
                          background: o.side === "buy"
                            ? "oklch(0.76 0.18 152)"
                            : "oklch(0.66 0.22 20)",
                        }}
                      />
                    </div>
                  )}

                  <div className="text-[10px] text-muted-foreground mt-1.5">
                    {new Date(o.createdAt).toLocaleString("zh-CN", {
                      month: "2-digit", day: "2-digit",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </div>
                </div>

                {canCancel && (
                  <button
                    className="px-3 py-1.5 rounded-xl text-xs font-medium ui-secondary-button transition-colors shrink-0 ml-1"
                    
                    onClick={() => cancel.mutate({ orderId: o.id })}
                  >
                    撤单
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="text-center py-14 text-muted-foreground text-sm">暂无订单</li>
        )}
      </ul>
    </div>
  );
}
