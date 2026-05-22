export function fmtPrice(v: string | number, decimals = 2): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (n >= 1) return n.toFixed(decimals);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toFixed(8);
}

export function fmtPct(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function decimalPlacesFromStep(step: string | number | null | undefined, fallback = 8): number {
  if (step === null || step === undefined || step === "") return fallback;
  const raw = String(step).trim();
  if (!raw || Number(raw) === 0) return fallback;
  if (/e-/i.test(raw)) {
    const [, exp] = raw.toLowerCase().split("e-");
    const parsed = Number.parseInt(exp, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const normalized = raw.includes(".") ? raw.replace(/0+$/, "") : raw;
  const point = normalized.indexOf(".");
  return point >= 0 ? Math.max(0, normalized.length - point - 1) : 0;
}

export function fmtAmount(v: string | number, decimals = 8): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

export function fmtQuantity(
  v: string | number | null | undefined,
  opts: { step?: string | number | null; maxDecimals?: number; minDecimals?: number } = {},
): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "-";
  const derived = opts.maxDecimals ?? decimalPlacesFromStep(opts.step, 8);
  const maximumFractionDigits = Math.min(12, Math.max(0, derived));
  const minimumFractionDigits = Math.min(maximumFractionDigits, Math.max(0, opts.minDecimals ?? 0));
  return n.toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits });
}

export function colorForChange(pct: string | number): string {
  const n = Number(pct);
  if (!Number.isFinite(n)) return "text-muted-foreground";
  if (n > 0) return "text-up";
  if (n < 0) return "text-down";
  return "text-muted-foreground";
}

export function shortenAddress(addr: string): string {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-5)}`;
}

/** Parse a ticker symbol "BTCUSDT" → { base:"BTC", quote:"USDT" } */
export function splitSymbol(symbol: string): { base: string; quote: string } {
  const quotes = ["USDT", "USDC", "BUSD", "USD", "BTC", "ETH", "BNB"];
  for (const q of quotes) {
    if (symbol.endsWith(q)) return { base: symbol.slice(0, -q.length), quote: q };
  }
  return { base: symbol, quote: "" };
}
