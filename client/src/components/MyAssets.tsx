import { trpc } from "@/lib/trpc";
import { fmtPrice, fmtQuantity, splitSymbol } from "@/lib/format";
import { useMemo } from "react";
import { Link } from "wouter";
import { AssetIcon } from "./AssetIcon";

export function MyAssets() {
  const { data: balances } = trpc.exchange.balances.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const { data: markets } = trpc.exchange.listMarkets.useQuery(undefined, {
    refetchInterval: 5000,
  });

  const priceOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of markets ?? []) {
      const { base, quote } = splitSymbol(row.symbol);
      if (quote === "USDT") m.set(base, Number(row.lastPrice));
      m.set(quote, quote === "USDT" ? 1 : (m.get(quote) ?? 0));
    }
    m.set("USDT", 1);
    return m;
  }, [markets]);

  const assetRows = useMemo(() => {
    const balanceMap = new Map((balances ?? []).map((b) => [b.asset, b]));
    const assetSet = new Set<string>(["USDT"]);
    for (const b of balances ?? []) assetSet.add(b.asset);
    for (const row of markets ?? []) {
      const { base, quote } = splitSymbol(row.symbol);
      if (base) assetSet.add(base);
      if (quote) assetSet.add(quote);
    }
    return Array.from(assetSet).map((asset) => {
      const b = balanceMap.get(asset);
      const available = Number(b?.available ?? 0);
      const locked = Number(b?.locked ?? 0);
      const total = available + locked;
      const price = priceOf.get(asset) ?? 0;
      return { asset, available, locked, total, valuation: total * price };
    }).sort((a, b) => {
      const aHas = a.total > 0 ? 1 : 0;
      const bHas = b.total > 0 ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (b.valuation !== a.valuation) return b.valuation - a.valuation;
      if (a.asset === "USDT") return -1;
      if (b.asset === "USDT") return 1;
      return a.asset.localeCompare(b.asset);
    });
  }, [balances, markets, priceOf]);

  const totalUsdt = useMemo(() => {
    return assetRows.reduce((sum, b) => sum + b.valuation, 0);
  }, [assetRows]);

  if (!balances || !markets) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        正在加载资产明细...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-card rounded-2xl px-5 py-4">
        <div className="text-xs text-muted-foreground">总资产估值</div>
        <div className="text-2xl font-semibold mt-1">
          ${fmtPrice(totalUsdt, 2)}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          ≈ ¥{fmtPrice(totalUsdt * 7.2, 2)}
        </div>
      </div>

      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
        <span>资产明细</span>
        <span>显示持有资产与当前支持交易资产</span>
      </div>

      <ul className="flex flex-col gap-2">
        {assetRows.map((b) => {
          const hasBalance = b.total > 0;
          return (
            <li key={b.asset} className="bg-card rounded-2xl px-4 py-3 flex items-center">
              <AssetIcon asset={b.asset} size={40} />
              <div className="flex-1 ml-3">
                <div className="font-semibold flex items-center gap-2">
                  {b.asset}
                  {!hasBalance && <span className="text-[10px] text-muted-foreground font-normal">未持有</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  可用 {fmtQuantity(b.available)} · 冻结 {fmtQuantity(b.locked)}
                  {b.locked > 0 && (
                    <Link href="/orders">
                      <span className="ml-2 text-primary hover:underline cursor-pointer">查看全部委托</span>
                    </Link>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold">{fmtQuantity(b.total)}</div>
                <div className="text-xs text-muted-foreground">
                  ≈ ${fmtPrice(b.valuation, 2)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
