import { useMemo } from "react";
import { fmtPrice, fmtQuantity } from "@/lib/format";

type Level = { price: string; quantity: string };

interface DepthChartProps {
  asks: Level[];
  bids: Level[];
  lastPrice: number;
  height?: number;
}

/**
 * DepthChart — 买卖盘深度图
 *
 * 以面积图形式展示累计买单（绿色）和累计卖单（红色）的深度分布，
 * 中间竖线为当前市场价格。
 */
export function DepthChart({ asks, bids, lastPrice, height = 220 }: DepthChartProps) {
  const { bidPoints, askPoints, maxCumQty, minPrice, maxPrice, midPrice } = useMemo(() => {
    if (!bids.length && !asks.length) return { bidPoints: [], askPoints: [], maxCumQty: 0, minPrice: 0, maxPrice: 0, midPrice: lastPrice };

    // Sort bids descending (highest price first), asks ascending
    const sortedBids = [...bids]
      .map((b) => ({ price: parseFloat(b.price), qty: parseFloat(b.quantity) }))
      .sort((a, b) => b.price - a.price);
    const sortedAsks = [...asks]
      .map((a) => ({ price: parseFloat(a.price), qty: parseFloat(a.quantity) }))
      .sort((a, b) => a.price - b.price);

    // Build cumulative bid curve (from mid outward to left)
    const bidCum: { price: number; cumQty: number }[] = [];
    let cumBid = 0;
    for (const b of sortedBids) {
      cumBid += b.qty;
      bidCum.push({ price: b.price, cumQty: cumBid });
    }

    // Build cumulative ask curve (from mid outward to right)
    const askCum: { price: number; cumQty: number }[] = [];
    let cumAsk = 0;
    for (const a of sortedAsks) {
      cumAsk += a.qty;
      askCum.push({ price: a.price, cumQty: cumAsk });
    }

    const maxCumQty = Math.max(
      bidCum.length ? bidCum[bidCum.length - 1]!.cumQty : 0,
      askCum.length ? askCum[askCum.length - 1]!.cumQty : 0
    );

    const allPrices = [...bidCum.map((b) => b.price), ...askCum.map((a) => a.price)];
    const minPrice = allPrices.length ? Math.min(...allPrices) : 0;
    const maxPrice = allPrices.length ? Math.max(...allPrices) : 0;

    const midPrice = lastPrice ||
      (sortedBids[0] && sortedAsks[0]
        ? (sortedBids[0].price + sortedAsks[0].price) / 2
        : 0);

    return { bidPoints: bidCum, askPoints: askCum, maxCumQty, minPrice, maxPrice, midPrice };
  }, [bids, asks, lastPrice]);

  const W = 400; // SVG viewBox width
  const H = height;
  const PAD_X = 0;
  const PAD_Y = 8;
  const CHART_H = H - PAD_Y * 2;

  const priceRange = maxPrice - minPrice || 1;
  const toX = (price: number) => PAD_X + ((price - minPrice) / priceRange) * (W - PAD_X * 2);
  const toY = (cumQty: number) => PAD_Y + CHART_H - (cumQty / (maxCumQty || 1)) * CHART_H;

  // Build SVG path for bid area (left side, green)
  const bidPath = useMemo(() => {
    if (!bidPoints.length) return "";
    // Bids go from mid-price leftward; we want to draw from left to right (low price → mid)
    const reversed = [...bidPoints].reverse();
    let d = `M ${toX(reversed[0]!.price)} ${H}`;
    for (const p of reversed) {
      d += ` L ${toX(p.price)} ${toY(p.cumQty)}`;
    }
    // Close area to bottom-right (mid price)
    d += ` L ${toX(reversed[reversed.length - 1]!.price)} ${H} Z`;
    return d;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bidPoints, W, H]);

  // Build SVG path for ask area (right side, red)
  const askPath = useMemo(() => {
    if (!askPoints.length) return "";
    let d = `M ${toX(askPoints[0]!.price)} ${H}`;
    for (const p of askPoints) {
      d += ` L ${toX(p.price)} ${toY(p.cumQty)}`;
    }
    d += ` L ${toX(askPoints[askPoints.length - 1]!.price)} ${H} Z`;
    return d;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askPoints, W, H]);

  const midX = toX(midPrice);

  if (!bidPoints.length && !askPoints.length) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
        暂无深度数据
      </div>
    );
  }

  return (
    <div className="relative w-full select-none" style={{ height }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-full"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id="bidGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(34,197,94,0.35)" />
            <stop offset="100%" stopColor="rgba(34,197,94,0.04)" />
          </linearGradient>
          <linearGradient id="askGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(239,68,68,0.35)" />
            <stop offset="100%" stopColor="rgba(239,68,68,0.04)" />
          </linearGradient>
        </defs>

        {/* Bid area */}
        {bidPath && (
          <>
            <path d={bidPath} fill="url(#bidGrad)" />
            <path
              d={bidPath.replace(/ L [^ ]+ [^ ]+ Z$/, "").replace(/^M [^ ]+ [^ ]+ /, "")}
              fill="none"
              stroke="rgba(34,197,94,0.7)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}

        {/* Ask area */}
        {askPath && (
          <>
            <path d={askPath} fill="url(#askGrad)" />
            <path
              d={askPath.replace(/ L [^ ]+ [^ ]+ Z$/, "").replace(/^M [^ ]+ [^ ]+ /, "")}
              fill="none"
              stroke="rgba(239,68,68,0.7)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}

        {/* Mid price vertical line */}
        <line
          x1={midX}
          y1={PAD_Y}
          x2={midX}
          y2={H}
          stroke="rgba(148,163,184,0.4)"
          strokeWidth="1"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* Price labels */}
      <div className="absolute bottom-0 left-0 right-0 flex justify-between px-1 text-[9px] font-mono text-muted-foreground pointer-events-none">
        <span>{fmtPrice(minPrice)}</span>
        <span className="text-foreground/70">{fmtPrice(midPrice)}</span>
        <span>{fmtPrice(maxPrice)}</span>
      </div>

      {/* Legend */}
      <div className="absolute top-1 left-2 flex gap-3 text-[9px] font-mono pointer-events-none">
        <span className="text-green-400">
          买盘 {bidPoints.length ? fmtQuantity(bidPoints[bidPoints.length - 1]!.cumQty) : "0"}
        </span>
        <span className="text-red-400">
          卖盘 {askPoints.length ? fmtQuantity(askPoints[askPoints.length - 1]!.cumQty) : "0"}
        </span>
      </div>
    </div>
  );
}
