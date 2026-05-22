import { Link, useLocation, useRoute } from "wouter";
import { LineChart } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fmtAmount, fmtPrice, fmtQuantity, splitSymbol } from "@/lib/format";
import {
  OrderBookBlock,
  PairHeader,
} from "@/components/trade/TradeCommon";

type Side = "buy" | "sell";
type OrderType = "limit" | "market";

export default function TradePair() {
  const [, params] = useRoute("/trade/:symbol");
  const [location] = useLocation();
  const symbol = (params?.symbol ?? "BTCUSDT").toUpperCase();
  const { base, quote } = splitSymbol(symbol);

  const qs = useMemo(() => {
    const q = location.includes("?") ? location.split("?")[1] : "";
    return new URLSearchParams(q);
  }, [location]);

  const initialSide: Side = qs.get("side") === "sell" ? "sell" : "buy";
  const initialPrice = qs.get("price") ?? "";

  const { data: marketInfo } = trpc.exchange.listMarkets.useQuery(undefined, {
    refetchInterval: 30000,
    placeholderData: (prev) => prev,
  });
  const market = marketInfo?.find((m) => m.symbol === symbol);
  const tradingEnabled = market?.isActive !== false;
  const allowLimitOrder = market?.allowLimitOrder !== false;
  const allowMarketOrder = market?.allowMarketOrder !== false;

  // 前端统一使用后端行情接口。后端会按后台配置完成参考交易所、价格倍率、偏移、盘口档位和限价真实成交规则转换，避免前端直连外部行情造成价格不一致。
  const { data: ticker } = trpc.exchange.ticker.useQuery(
    { symbol },
    { refetchInterval: 3000 }
  );
  const { data: depthFallback, isError: depthError, refetch: refetchDepth } = trpc.exchange.orderBook.useQuery(
    { symbol, depth: 12 },
    {
      refetchInterval: 1500,
      retry: 3,
      retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
    }
  );
  const depth = depthFallback ?? null;
  const { data: balances } = trpc.exchange.balances.useQuery(undefined, {
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
  });
  const { data: openOrders, refetch: refetchOpen } =
    trpc.exchange.openOrders.useQuery(
      { symbol },
      { refetchInterval: 3000 }
    );

  const [side, setSide] = useState<Side>(initialSide);
  const [type, setType] = useState<OrderType>("limit");
  const [price, setPrice] = useState(initialPrice);
  const [amount, setAmount] = useState("");

  useEffect(() => {
    setPrice(initialPrice || "");
    setAmount("");
    setSide(initialSide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, symbol]);

  const placeOrder = trpc.exchange.submitOrder.useMutation({
    onSuccess: (order) => {
      if (!order) { toast.success("下单成功"); setAmount(""); refetchOpen(); return; }
      const isFilled = order.status === "filled";
      const isLimit = order.type === "limit";
      if (isFilled) {
        const avgPx = Number(order.avgPrice ?? 0);
        const filled = Number(order.filledQty ?? 0);
        toast.success(
          `${order.side === "buy" ? "买入" : "卖出"}成功：${filled.toFixed(6)} ${base} @ $${avgPx.toFixed(2)}`,
          { duration: 5000 }
        );
      } else if (isLimit) {
        toast.success(
          `限价单已挂出，等待市场价格到达 $${Number(order.price ?? 0).toFixed(2)} 时自动成交`,
          { duration: 5000 }
        );
      } else {
        toast.success("下单成功");
      }
      setAmount("");
      refetchOpen();
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });
  const cancelOrder = trpc.exchange.cancelOrder.useMutation({
    onSuccess: () => { toast.success("已撤单"); refetchOpen(); },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  const lastPrice = Number(ticker?.lastPrice ?? 0);
  const midPrice = lastPrice;
  const pct = Number(ticker?.changePct24h ?? 0);
  const high24 = Number(ticker?.high24h ?? 0);
  const low24 = Number(ticker?.low24h ?? 0);
  const vol24 = Number(ticker?.volume24h ?? 0);
  const pctUp = pct >= 0;

  const quoteAvail = balances?.find((b) => b.asset === quote)?.available ?? "0";
  const baseAvail = balances?.find((b) => b.asset === base)?.available ?? "0";

  // Get market config for this symbol
  const priceTick = market?.priceTick ?? "0.01";
  const amountStep = market?.amountStep ?? "0.00001";

  // Normalize a decimal string: strip 18-decimal-place trailing zeros AND
  // convert scientific notation (e.g. "1e-7") to standard decimal format.
  // This is necessary because parseFloat("0.000010000000000000").toString() = "0.00001" (OK)
  // but parseFloat("0.000000100000000000").toString() = "1e-7" (breaks split('.') logic).
  const normalizeDecimal = (s: string): string => {
    const n = parseFloat(s);
    if (isNaN(n)) return s;
    const str = n.toString();
    if (!str.includes('e')) return str;
    // Scientific notation: extract exponent and use toFixed
    const match = str.match(/e-?(\d+)/);
    if (match) {
      const decimals = parseInt(match[1]) + 10;
      return n.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
    }
    return str;
  };

  const snapToTick = (val: string, tick: string): string => {
    const v = parseFloat(val);
    const t = parseFloat(tick);
    if (!val || !v || !t || isNaN(v) || isNaN(t)) return val;
    const cleanTick = normalizeDecimal(tick); // strip trailing zeros, handle scientific notation
    const tickDecimals = (cleanTick.split(".")[1] ?? "").length;
    const factor = Math.pow(10, tickDecimals);
    const vInt = Math.round(v * factor);
    const tInt = Math.round(t * factor);
    if (!tInt) return val;
    const snapped = Math.round(vInt / tInt) * tInt;
    return (snapped / factor).toFixed(tickDecimals);
  };

  // Snap amount to nearest valid step (floor to avoid exceeding balance)
  // Uses integer arithmetic to avoid JS floating-point precision errors.
  // Normalizes step via normalizeDecimal to strip trailing zeros and handle scientific notation.
  const snapToStep = (val: string, step: string): string => {
    const v = parseFloat(val);
    const s = parseFloat(step);
    if (!val || !v || !s || isNaN(v) || isNaN(s)) return val;
    const cleanStep = normalizeDecimal(step); // strip trailing zeros, handle scientific notation
    const stepDecimals = (cleanStep.split(".")[1] ?? "").length;
    const factor = Math.pow(10, stepDecimals);
    // Use Math.floor (not Math.round) to guarantee floor semantics and avoid exceeding balance.
    // Add 1e-9 epsilon to correct for floating-point underflow (e.g. 1.23456 * 100000 = 123455.99999...).
    const vInt = Math.floor(v * factor + 1e-9);
    const sInt = Math.round(s * factor);
    if (!sInt) return val;
    const snapped = Math.floor(vInt / sInt) * sInt;
    return (snapped / factor).toFixed(stepDecimals);
  };

  const displayPrice = useMemo(
    () => price || (lastPrice ? lastPrice.toString() : ""),
    [price, lastPrice]
  );
  const estTotal = useMemo(() => {
    const p = Number(displayPrice || 0);
    const q = Number(amount || 0);
    return p * q;
  }, [displayPrice, amount]);

  const selectedTypeAllowed = type === "limit" ? allowLimitOrder : allowMarketOrder;
  const isMarketBuy = type === "market" && side === "buy";
  const amountNumber = Number(amount);
  const priceNumber = Number(price);
  const takerFeeRate = Number(market?.takerFee ?? "0");
  const safeTakerFeeRate = Number.isFinite(takerFeeRate) && takerFeeRate > 0 ? takerFeeRate : 0;
  const hasValidAmount = amount.trim() !== "" && Number.isFinite(amountNumber) && amountNumber > 0;
  const hasValidLimitPrice = type !== "limit" || (price.trim() !== "" && Number.isFinite(priceNumber) && priceNumber > 0);
  const marketBuyEstimatedPrincipal = isMarketBuy && hasValidAmount
    ? amountNumber / (1 + safeTakerFeeRate)
    : 0;
  const marketBuyEstimatedFee = isMarketBuy && hasValidAmount
    ? amountNumber - marketBuyEstimatedPrincipal
    : 0;
  const marketBuyEstimatedDebit = isMarketBuy && hasValidAmount ? amountNumber : 0;

  useEffect(() => {
    if (type === "market" && !allowMarketOrder && allowLimitOrder) setType("limit");
    if (type === "limit" && !allowLimitOrder && allowMarketOrder) setType("market");
  }, [type, allowLimitOrder, allowMarketOrder]);

  const amountLabel = isMarketBuy ? `总成本预算` : `数量`;
  const amountSuffix = isMarketBuy ? quote : base;
  const amountPlaceholder = isMarketBuy ? `0.00（含手续费）` : "0.00";

  const submitBtnColor = side === "buy"
    ? "oklch(0.76 0.18 152)"
    : "oklch(0.66 0.22 20)";

  return (
    <div className="w-full min-h-screen flex flex-col bg-background pb-8">
      <PairHeader
        symbol={symbol}
        pct={pct}
        backHref={`/quote/${symbol}`}
        rightSlot={
          <Link href={`/quote/${symbol}`}>
            <button className="flex items-center gap-1 h-8 px-2.5 rounded-full bg-secondary/80 border border-border text-[12px] text-foreground active:scale-95 transition-transform">
              <LineChart className="w-4 h-4" />
              K线
            </button>
          </Link>
        }
        switchMode="trade"
      />

      {/* Price info bar */}
      <div
        className="mx-3 mt-2 px-4 py-3 rounded-2xl ui-surface"
      >
        <div className="flex items-end gap-3">
          <span className={cn("text-xl font-bold font-mono leading-none", pctUp ? "text-up" : "text-down")}>
            {fmtPrice(lastPrice)}
          </span>
          <span className={cn("text-xs font-mono font-semibold", pctUp ? "text-up" : "text-down")}>
            {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
          </span>
        </div>
        <div className="mt-2 flex gap-4 text-[10.5px] font-mono text-muted-foreground">
          <span>高 <span className="text-foreground/80">{fmtPrice(high24)}</span></span>
          <span>低 <span className="text-foreground/80">{fmtPrice(low24)}</span></span>
          <span>量 <span className="text-foreground/80">{fmtQuantity(vol24)}</span></span>
        </div>
      </div>

      {/* Buy/Sell segmented */}
      <div className="px-3 pt-3">
        <div
          className="grid grid-cols-2 gap-1 p-1 rounded-xl ui-segment"
        >
          <button
            onClick={() => setSide("buy")}
            className={cn(
              "py-2.5 rounded-lg font-semibold text-sm transition-all duration-150",
              side === "buy"
                ? "text-white shadow-sm"
                : "ui-segment-option"
            )}
            style={side === "buy" ? { background: "oklch(0.76 0.18 152)" } : {}}
          >
            买入 {base}
          </button>
          <button
            onClick={() => setSide("sell")}
            className={cn(
              "py-2.5 rounded-lg font-semibold text-sm transition-all duration-150",
              side === "sell"
                ? "text-white shadow-sm"
                : "ui-segment-option"
            )}
            style={side === "sell" ? { background: "oklch(0.66 0.22 20)" } : {}}
          >
            卖出 {base}
          </button>
        </div>

        {/* Limit / Market tab */}
        <div className="mt-3 flex gap-1 p-1 rounded-xl w-fit ui-segment">
          {(["limit", "market"] as OrderType[]).map((t) => (
            <button
              key={t}
              disabled={t === "limit" ? !allowLimitOrder : !allowMarketOrder}
              onClick={() => setType(t)}
              className={cn(
                "px-4 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 disabled:opacity-35 disabled:cursor-not-allowed",
                type === t
                  ? "bg-primary/20 text-primary"
                  : "ui-segment-option"
              )}
            >
              {t === "limit" ? "限价" : "市价"}
            </button>
          ))}
        </div>
      </div>

      {/* Two-column: form + orderbook */}
      <div className="px-3 pt-3 grid grid-cols-2 gap-2">
        {/* Left: form */}
        <div className="flex flex-col gap-2">
          {type === "limit" && (
            <GlassInput
              label="价格"
              suffix={quote}
              value={price}
              onChange={setPrice}
              onBlur={() => {
                if (price) setPrice(snapToTick(price, priceTick));
              }}
              placeholder={lastPrice ? fmtPrice(lastPrice) : "0.00"}
            />
          )}
          <GlassInput
            label={amountLabel}
            suffix={amountSuffix}
            value={amount}
            onChange={setAmount}
            onBlur={() => {
              if (amount && !isMarketBuy) setAmount(snapToStep(amount, amountStep));
            }}
            placeholder={amountPlaceholder}
          />

          {/* Percentage quick picks */}
          <div className="flex gap-1">
            {[25, 50, 75, 100].map((p) => (
              <button
                key={p}
                className="flex-1 py-1.5 text-[11px] rounded-lg font-medium text-muted-foreground hover:text-foreground transition-colors ui-secondary-button"
                onClick={() => {
                  // Get amountStep from market info to floor correctly
                  const mkt = marketInfo?.find((m) => m.symbol === symbol);
                  const rawStep = mkt?.amountStep ?? "0.000001";
                  const stepDec = Math.max(0, rawStep.replace(/\.?0+$/, "").split(".")[1]?.length ?? 0);
                  const factor = Math.pow(10, stepDec);
                  if (isMarketBuy) {
                    // 市价买入的输入值是总成本预算，已经包含成交本金和 taker 手续费；
                    // 因此 100% 快捷输入应等于可用 quote 余额，而不是再预留额外手续费。
                    setAmount(((Number(quoteAvail) * p) / 100).toFixed(2));
                  } else if (side === "buy") {
                    const avail = Number(quoteAvail) / Number(displayPrice || lastPrice || 1);
                    setAmount((Math.floor((avail * p / 100) * factor) / factor).toFixed(stepDec));
                  } else {
                    // Use floor to avoid exceeding available balance
                    setAmount((Math.floor((Number(baseAvail) * p / 100) * factor) / factor).toFixed(stepDec));
                  }
                }}
              >
                {p}%
              </button>
            ))}
          </div>

          <div className="text-[11px] text-muted-foreground flex justify-between pt-0.5">
            <span>可用</span>
            <span className="font-mono">
              {side === "buy"
                ? `${fmtPrice(quoteAvail)} ${quote}`
                : `${fmtQuantity(baseAvail)} ${base}`}
            </span>
          </div>
          {type === "limit" && (
            <div className="text-[11px] text-muted-foreground flex justify-between">
              <span>预估成交</span>
              <span className="font-mono">{fmtPrice(estTotal)} {quote}</span>
            </div>
          )}
          {isMarketBuy && (
            <div className="text-[11px] text-amber-600 dark:text-amber-300 rounded-lg px-2.5 py-1.5 leading-relaxed"
              style={{ background: "oklch(0.75 0.18 80 / 0.08)", border: "1px solid oklch(0.75 0.18 80 / 0.15)" }}>
              市价买入：输入的是总成本预算（已包含手续费），系统按实时最优卖价成交；实际扣款不会超过输入金额。
              {hasValidAmount && (
                <span className="block mt-0.5 font-mono text-amber-700 dark:text-amber-200">
                  预计扣款上限 {marketBuyEstimatedDebit.toLocaleString("en-US", { maximumFractionDigits: 8 })} {quote}，其中预估手续费约 {marketBuyEstimatedFee.toLocaleString("en-US", { maximumFractionDigits: 8 })} {quote}
                </span>
              )}
            </div>
          )}

          <button
            className="w-full mt-1 h-12 rounded-2xl font-semibold text-white text-sm active:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: submitBtnColor }}
            disabled={
              placeOrder.isPending || !tradingEnabled || !selectedTypeAllowed || !hasValidAmount || !hasValidLimitPrice
            }
            onClick={() => {
              if (!hasValidAmount || !hasValidLimitPrice) {
                toast.error("请输入有效的价格和数量");
                return;
              }
              // For market buy orders, the user inputs a fee-inclusive quote-asset total cost cap.
              // The engine handles quote→base conversion internally using the best available price.
              // Snap price and amount one final time before submit to guard against
              // any path that bypassed onBlur (e.g. clicking orderbook then immediately submitting).
              const finalPrice = type === 'limit' && price ? snapToTick(price, priceTick) : undefined;
              const finalAmount = !isMarketBuy && amount ? snapToStep(amount, amountStep) : amount;
              if (finalPrice && finalPrice !== price) setPrice(finalPrice);
              if (finalAmount !== amount) setAmount(finalAmount);
              placeOrder.mutate({
                symbol, side, type,
                price: finalPrice,
                quantity: finalAmount,
              });
            }}
          >
            {placeOrder.isPending
              ? "提交中..."
              : !tradingEnabled
                ? "交易已暂停"
                : !selectedTypeAllowed
                  ? "该订单类型已关闭"
                  : side === "buy" ? `买入 ${base}` : `卖出 ${base}`}
          </button>
        </div>

        {/* Right: inline orderbook */}
        <div
          className="rounded-xl overflow-hidden px-1 ui-surface-soft"
        >
          {depthError && !depth ? (
            <div className="flex flex-col items-center justify-center h-full py-6 gap-2">
              <span className="text-[10px] text-muted-foreground text-center">订单簿加载失败</span>
              <button
                onClick={() => refetchDepth()}
                className="text-[10px] text-primary hover:underline"
              >
                点击重试
              </button>
            </div>
          ) : !depth ? (
            // Skeleton while loading - stable widths to avoid React hydration issues
            <div className="flex flex-col gap-0.5 p-1 animate-pulse">
              {[72,58,85,63,79,55,90,68,74,61,83,57,76].map((w, i) => (
                <div key={i} className="h-[18px] rounded bg-white/8" style={{ width: `${w}%`, marginLeft: i < 6 ? 'auto' : undefined }} />
              ))}
            </div>
          ) : (
            <OrderBookBlock
              asks={(depth.asks ?? []).map(([p, q]) => ({ price: p, quantity: q }))}
              bids={(depth.bids ?? []).map(([p, q]) => ({ price: p, quantity: q }))}
              lastPrice={midPrice}
              pctPositive={pctUp}
              onPick={(p, side) => {
                setPrice(snapToTick(p, priceTick));
                setSide(side === "ask" ? "buy" : "sell");
              }}
              rows={6}
              compact
            />
          )}
        </div>
      </div>

      {/* My open orders */}
      <div className="mt-5 px-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold text-foreground">当前委托</div>
          <Link href="/orders">
            <span className="text-xs text-primary hover:underline cursor-pointer">全部委托</span>
          </Link>
        </div>
        <div className="text-[10px] text-muted-foreground mb-2">此处仅展示 {symbol}，冻结资产请到全部委托核对所有交易对。</div>
        <div className="rounded-2xl overflow-hidden divide-y ui-surface">
          {(openOrders ?? []).map((o) => {
            const isOpenMarketBuy = o.type === "market" && o.side === "buy";
            const filledDisplay = isOpenMarketBuy ? fmtPrice(o.quoteFilled ?? "0") : fmtQuantity(o.filledQty);
            const totalDisplay = isOpenMarketBuy ? fmtPrice(o.quantity) : fmtQuantity(o.quantity);
            const unitDisplay = isOpenMarketBuy ? quote : base;
            const hasFill = Number(o.filledQty ?? 0) > 0 && Number(o.avgPrice ?? 0) > 0;
            return (
            <div
              key={o.id}
              className="py-3 px-3 flex items-center justify-between text-xs border-border"
            >
              <div>
                <div className={cn("font-semibold", o.side === "buy" ? "text-up" : "text-down")}>
                  {o.side === "buy" ? "买入" : "卖出"} {o.symbol}
                </div>
                <div className="text-muted-foreground font-mono mt-0.5">
                  {o.type === "limit" ? `委托价 ${fmtPrice(o.price ?? "0")}` : "市价"} ·{" "}
                  {hasFill ? <span className="text-up">成交均价 {fmtPrice(o.avgPrice ?? "0")} · </span> : null}
                  {filledDisplay}/{totalDisplay} {unitDisplay}
                </div>
              </div>
              <button
                className="px-3 py-1.5 rounded-lg text-xs font-medium ui-secondary-button transition-colors"
                
                onClick={() => cancelOrder.mutate({ orderId: o.id })}
              >
                撤单
              </button>
            </div>
            );
          })}
          {(!openOrders || openOrders.length === 0) && (
              <div className="text-center py-8 text-muted-foreground text-xs">
                当前交易对暂无委托，可进入全部委托核对其他交易对。
              </div>

          )}
        </div>
      </div>
    </div>
  );
}

function GlassInput({
  label, suffix, value, onChange, onBlur, placeholder,
}: {
  label: string; suffix: string; value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  return (
    <div className="px-3 py-2 rounded-xl ui-field">
      <div className="text-[10.5px] text-muted-foreground mb-0.5">{label}</div>
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (/^(?:\d+(?:\.\d*)?|\.\d*)?$/.test(v)) onChange(v);
          }}
          onBlur={onBlur}
          placeholder={placeholder}
          inputMode="decimal"
          className="flex-1 min-w-0 bg-transparent text-base font-mono text-foreground placeholder:text-muted-foreground/60 outline-none border-none"
        />
        <span className="text-xs text-muted-foreground shrink-0">{suffix}</span>
      </div>
    </div>
  );
}

