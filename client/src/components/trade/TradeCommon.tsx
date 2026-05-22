import { Link, useLocation } from "wouter";
import { ChevronDown, ChevronLeft, Search, TrendingUp, TrendingDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtPct, fmtPrice, fmtQuantity, splitSymbol } from "@/lib/format";
import { AssetIcon } from "@/components/AssetIcon";
import { useRef, useEffect, useMemo, useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";

/**
 * Shared header used by both Quote (行情页) and Trade (交易下单页).
 * backHref lets Quote point back to /market and Trade point back to /quote/:symbol.
 */
export function PairHeader({
  symbol,
  pct,
  backHref,
  rightSlot,
  switchMode = "quote",
}: {
  symbol: string;
  pct: number;
  backHref: string;
  rightSlot?: ReactNode;
  switchMode?: "quote" | "trade";
}) {
  const { base, quote } = splitSymbol(symbol);
  const up = pct >= 0;
  return (
    <header className="sticky top-0 z-40 flex items-center justify-between px-3 py-2.5 border-b border-border bg-background/95 backdrop-blur-xl">
      <div className="flex items-center gap-2 min-w-0">
        <Link href={backHref}>
          <button className="p-1 -ml-1 text-muted-foreground active:scale-95 transition-transform" aria-label="返回">
            <ChevronLeft className="w-6 h-6" />
          </button>
        </Link>
        <AssetIcon asset={base} size={30} />
        <div className="min-w-0">
          <div className="font-semibold leading-tight truncate">
            {base}/{quote}
          </div>
          <div
            className={cn(
              "text-[11px] leading-tight font-mono",
              up ? "text-up" : "text-down"
            )}
          >
            {fmtPct(pct)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground">
        {rightSlot}
        <PairSwitcher currentSymbol={symbol} mode={switchMode} />
      </div>
    </header>
  );
}

function PairSwitcher({ currentSymbol, mode }: { currentSymbol: string; mode: "quote" | "trade" }) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [, setLocation] = useLocation();
  const { data: markets } = trpc.exchange.listMarkets.useQuery(undefined, {
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const filtered = useMemo(() => {
    const q = keyword.trim().toUpperCase();
    return (markets ?? [])
      .filter((m) => {
        if (!q) return true;
        const { base, quote } = splitSymbol(m.symbol);
        return m.symbol.includes(q) || base.includes(q) || quote.includes(q);
      })
      .slice(0, 60);
  }, [markets, keyword]);

  const basePath = mode === "trade" ? "/trade" : "/quote";

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setKeyword("");
          setOpen(true);
        }}
        className="inline-flex items-center gap-1 h-8 px-2.5 rounded-full bg-secondary/80 border border-border text-[12px] font-medium text-foreground active:scale-95 transition-transform"
        aria-label="切换交易对"
      >
        切换
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="fixed inset-0 z-[80] bg-black/45 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div
            className="absolute left-1/2 bottom-0 w-full max-w-[520px] -translate-x-1/2 rounded-t-[26px] bg-background border border-border shadow-2xl p-4 pb-[calc(16px+env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-base font-semibold">切换交易对</div>
                <div className="text-xs text-muted-foreground mt-0.5">选择后会进入对应的{mode === "trade" ? "下单" : "行情"}页面</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center text-muted-foreground" aria-label="关闭">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="h-10 rounded-xl bg-secondary/70 border border-border flex items-center gap-2 px-3 mb-3">
              <Search className="w-4 h-4 text-muted-foreground" />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索 BTC、ETH 或交易对"
                className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
              />
            </div>

            <div className="max-h-[50vh] overflow-y-auto space-y-1 pr-1">
              {filtered.map((m) => {
                const { base, quote } = splitSymbol(m.symbol);
                const selected = m.symbol === currentSymbol;
                return (
                  <button
                    key={m.symbol}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      if (!selected) setLocation(`${basePath}/${encodeURIComponent(m.symbol)}`);
                    }}
                    className={cn(
                      "w-full flex items-center justify-between gap-3 rounded-2xl px-3 py-3 text-left transition-colors",
                      selected ? "bg-primary/12 border border-primary/25" : "bg-card/60 border border-transparent hover:border-border"
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <AssetIcon asset={base} size={30} />
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{base}/{quote}</div>
                        <div className="text-[11px] text-muted-foreground font-mono truncate">{m.symbol}</div>
                      </div>
                    </div>
                    <span className={cn("text-xs", selected ? "text-primary" : "text-muted-foreground")}>{selected ? "当前" : "切换"}</span>
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className="py-10 text-center text-xs text-muted-foreground">未找到匹配交易对</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

export function OrderBookBlock({
  asks,
  bids,
  lastPrice,
  pctPositive,
  onPick,
  rows = 8,
  compact = false,
}: {
  asks: { price: string; quantity: string }[];
  bids: { price: string; quantity: string }[];
  lastPrice: number;
  pctPositive: boolean;
  /** Called with (price, side) when user clicks a row. side='ask' means user wants to BUY at that price. */
  onPick: (price: string, side: "ask" | "bid") => void;
  rows?: number;
  compact?: boolean;
}) {
  // Track real-time price direction (up/down/neutral) for mid-price color
  const prevPriceRef = useRef<number>(lastPrice);
  const [priceDir, setPriceDir] = useState<"up" | "down" | "neutral">("neutral");
  useEffect(() => {
    if (lastPrice === 0) return;
    if (prevPriceRef.current === 0) { prevPriceRef.current = lastPrice; return; }
    if (lastPrice > prevPriceRef.current) setPriceDir("up");
    else if (lastPrice < prevPriceRef.current) setPriceDir("down");
    prevPriceRef.current = lastPrice;
  }, [lastPrice]);
  // Effective color: real-time direction takes priority, fall back to 24h pct
  const isUp = priceDir === "up" ? true : priceDir === "down" ? false : pctPositive;
  const maxQty = Math.max(
    ...asks.map((a) => Number(a.quantity)),
    ...bids.map((b) => Number(b.quantity)),
    1
  );
  // asks come sorted low→high from API; show highest ask at top (closest to mid)
  const topAsks = asks.slice(0, rows).reverse();
  const topBids = bids.slice(0, rows);
  const rowH = compact ? 18 : 22;
  const fontSize = compact ? "text-[10px]" : "text-[12px]";

  return (
    <div className={cn("flex flex-col font-mono", fontSize)}>
      {/* Column headers */}
      {!compact && (
        <div className="flex justify-between px-2 pb-1 text-[10px] text-muted-foreground">
          <span>价格(USDT)</span>
          <span>数量</span>
        </div>
      )}
      {compact && (
        <div className="flex justify-between px-1 pb-0.5 text-[9px] text-muted-foreground">
          <span>价格</span>
          <span>量</span>
        </div>
      )}

      {/* Ask rows (sell orders - red) */}
      {Array.from({ length: rows }).map((_, i) => {
        const a = topAsks[i];
        if (!a)
          return <div key={`a-empty-${i}`} style={{ height: rowH }} />;
        return (
          <Row
            key={`a-${a.price}`}
            price={a.price}
            qty={a.quantity}
            maxQty={maxQty}
            side="ask"
            onPick={(p) => onPick(p, "ask")}
            rowH={rowH}
          />
        );
      })}

      {/* Mid price — Binance style */}
      <div
        className={cn(
          "flex items-center justify-between px-2 my-0.5 rounded",
          compact ? "py-0.5" : "py-1.5",
          isUp
            ? "bg-green-500/10 border border-green-500/20"
            : "bg-red-500/10 border border-red-500/20"
        )}
      >
        {/* Left: price + direction arrow */}
        <div className="flex items-center gap-1">
          <span
            className={cn(
              "font-bold tracking-tight",
              compact ? "text-[12px]" : "text-[16px]",
              isUp ? "text-green-400" : "text-red-400"
            )}
          >
            {fmtPrice(lastPrice)}
          </span>
          {!compact && (
            isUp
              ? <TrendingUp className="w-3.5 h-3.5 text-green-400" />
              : <TrendingDown className="w-3.5 h-3.5 text-red-400" />
          )}
        </div>
        {/* Right: ≈ USD value */}
        {!compact && (
          <span className="text-[11px] text-muted-foreground font-mono">
            ≈ ${fmtPrice(lastPrice)}
          </span>
        )}
      </div>

      {/* Bid rows (buy orders - green) */}
      {Array.from({ length: rows }).map((_, i) => {
        const b = topBids[i];
        if (!b)
          return <div key={`b-empty-${i}`} style={{ height: rowH }} />;
        return (
          <Row
            key={`b-${b.price}`}
            price={b.price}
            qty={b.quantity}
            maxQty={maxQty}
            side="bid"
            onPick={(p) => onPick(p, "bid")}
            rowH={rowH}
          />
        );
      })}
    </div>
  );
}

function Row({
  price,
  qty,
  maxQty,
  side,
  onPick,
  rowH,
}: {
  price: string;
  qty: string;
  maxQty: number;
  side: "ask" | "bid";
  onPick: (p: string) => void;
  rowH: number;
}) {
  const pct = Math.min(100, (Number(qty) / maxQty) * 100);
  const isAsk = side === "ask";
  return (
    <button
      onClick={() => onPick(price)}
      className="relative flex justify-between items-center px-2 w-full hover:bg-white/5 transition-colors"
      style={{ height: rowH }}
    >
      {/* depth background bar */}
      <span
        className="absolute top-0 bottom-0 right-0 rounded-sm"
        style={{
          width: `${pct}%`,
          background: isAsk
            ? "rgba(239,68,68,0.12)"
            : "rgba(34,197,94,0.12)",
        }}
      />
      {/* price */}
      <span
        className="relative font-medium"
        style={{ color: isAsk ? "#f87171" : "#4ade80" }}
      >
        {fmtPrice(price)}
      </span>
      {/* quantity */}
      <span className="relative text-slate-400">
        {fmtQuantity(qty)}
      </span>
    </button>
  );
}

export function TradesList({
  trades,
  quote,
  base,
}: {
  trades: {
    price: string;
    quantity: string;
    timestamp: number;
    isBuyerMaker: boolean;
  }[];
  quote: string;
  base: string;
}) {
  return (
    <div className="text-[11px] font-mono">
      <div className="flex justify-between text-[10px] text-muted-foreground px-1 pb-1">
        <span>价格({quote})</span>
        <span>数量({base})</span>
        <span>时间</span>
      </div>
      <ul className="flex flex-col">
        {trades.slice(0, 30).map((t) => (
          <li
            key={`${t.timestamp}-${t.price}-${t.quantity}`}
            className="flex items-center justify-between py-[3px] px-1"
          >
            <span className={cn(!t.isBuyerMaker ? "text-up" : "text-down")}>
              {fmtPrice(t.price)}
            </span>
            <span className="text-muted-foreground">
              {fmtQuantity(t.quantity)}
            </span>
            <span className="text-muted-foreground">
              {new Date(t.timestamp).toLocaleTimeString()}
            </span>
          </li>
        ))}
        {trades.length === 0 && (
          <li className="text-center py-6 text-muted-foreground">暂无成交</li>
        )}
      </ul>
    </div>
  );
}
