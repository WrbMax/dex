type Kline = {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

export function CandleChart({ data, height = 220 }: { data: Kline[]; height?: number }) {
  if (!data || data.length === 0) {
    return (
      <div
        className="w-full flex items-center justify-center text-muted-foreground text-xs"
        style={{ height }}
      >
        加载 K 线中...
      </div>
    );
  }
  const W = 600;
  const H = height;
  const padding = 8;
  const innerW = W - padding * 2;
  const innerH = H - padding * 2;
  const n = data.length;
  const highs = data.map((d) => Number(d.high));
  const lows = data.map((d) => Number(d.low));
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const range = max - min || 1;
  const barW = innerW / n;
  const bodyW = Math.max(1.2, barW * 0.7);

  const scaleY = (v: number) => padding + ((max - v) / range) * innerH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
      {data.map((d, i) => {
        const o = Number(d.open);
        const c = Number(d.close);
        const h = Number(d.high);
        const l = Number(d.low);
        const x = padding + i * barW + barW / 2;
        const up = c >= o;
        const color = up ? "var(--up)" : "var(--down)";
        const yH = scaleY(h);
        const yL = scaleY(l);
        const yO = scaleY(o);
        const yC = scaleY(c);
        const bodyY = Math.min(yO, yC);
        const bodyH = Math.max(Math.abs(yC - yO), 1);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={yH} y2={yL} stroke={color} strokeWidth={1} />
            <rect
              x={x - bodyW / 2}
              y={bodyY}
              width={bodyW}
              height={bodyH}
              fill={color}
              opacity={up ? 0.9 : 0.9}
            />
          </g>
        );
      })}
    </svg>
  );
}
