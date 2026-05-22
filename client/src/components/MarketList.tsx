import { useLocation } from "wouter";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Sparkline } from "./Sparkline";
import { AssetIcon } from "./AssetIcon";
import { colorForChange, fmtPct, fmtPrice, splitSymbol } from "@/lib/format";
import { cn } from "@/lib/utils";

type Filter = "all" | "new" | "perp" | "spot";

export function MarketList() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [, setLocation] = useLocation();
  const { data } = trpc.exchange.listMarkets.useQuery(undefined, {
    refetchInterval: 3000,
    placeholderData: (prev) => prev,
  });

  const rows = useMemo(() => {
    const src = data ?? [];
    const keyword = q.trim().toUpperCase();
    const filtered = src.filter((m) => {
      if (!keyword) return true;
      const { base, quote } = splitSymbol(m.symbol);
      return base.includes(keyword) || quote.includes(keyword) || m.symbol.includes(keyword);
    });
    if (filter === "new") return filtered.slice(-10).reverse();
    if (filter === "spot") return filtered.filter((m) => m.isActive !== false);
    return filtered;
  }, [data, q, filter]);

  return (
    <div className="flex flex-col gap-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          placeholder="搜索币种"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full h-11 pl-10 pr-4 rounded-xl text-sm text-foreground placeholder:text-muted-foreground bg-card border border-border outline-none focus:ring-1 focus:ring-primary/50 transition shadow-sm"
        />
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {(
          [
            ["all", "全部"],
            ["new", "新币"],
            ["spot", "现货"],
            ["perp", "合约"],
          ] as Array<[Filter, string]>
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={cn(
              "px-3.5 py-1.5 rounded-full text-xs font-medium transition-all duration-150 border",
              filter === k
                ? "bg-primary text-primary-foreground border-primary shadow-sm"
                : "bg-secondary text-muted-foreground border-border hover:text-foreground hover:bg-accent"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
        <span>名称</span>
        <span>最新价 / 24H 涨跌</span>
      </div>

      {/* List */}
      <ul className="flex flex-col gap-2">
        {filter === "perp" ? (
          <div className="py-14 text-center text-muted-foreground text-sm">
            合约板块即将开放
          </div>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center text-muted-foreground text-sm">
            {q ? "未找到相关币种" : "暂无行情数据"}
          </div>
        ) : (
          rows.map((m) => {
            const { base, quote } = splitSymbol(m.symbol);
            const pct = Number(m.changePct24h);
            return (
              <li key={m.symbol}>
                <button
                  type="button"
                  onClick={() => setLocation(`/quote/${encodeURIComponent(m.symbol)}`)}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl bg-card border border-border shadow-sm active:opacity-75 transition-opacity duration-100 text-left"
                  aria-label={`查看 ${base}/${quote} 行情`}
                >
                    {m.logoUrl ? (
                      <img src={m.logoUrl} alt={base} className="w-10 h-10 rounded-full object-cover bg-muted" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                    ) : (
                      <AssetIcon asset={base} size={40} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm leading-tight">{base}</div>
                      <div className="text-xs text-muted-foreground leading-tight mt-0.5">/{quote}</div>
                    </div>
                    <div className="w-16 h-8 flex-shrink-0 opacity-80">
                      <Sparkline values={m.sparkline} positive={pct >= 0} />
                    </div>
                    <div className="text-right min-w-[80px]">
                      <div className="font-semibold text-sm mono">${fmtPrice(m.lastPrice, 2)}</div>
                      <div
                        className={cn(
                          "inline-block mt-1 px-2 py-0.5 rounded-lg text-xs font-medium",
                          pct >= 0
                            ? "bg-up/15 text-up"
                            : "bg-down/15 text-down"
                        )}
                      >
                        {fmtPct(pct)}
                      </div>
                    </div>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

export function _colorForChange(pct: string | number) {
  return colorForChange(pct);
}
