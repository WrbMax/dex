/**
 * Minimal fixed-point decimal helpers using native BigInt.
 *
 * All amounts in the exchange are stored in the DB as DECIMAL(36,18).
 * Internal arithmetic uses BigInt at scale = 18 to avoid float rounding errors.
 */

export const SCALE = 18;
const SCALE_FACTOR = BigInt(10) ** BigInt(SCALE);

/** Parse a decimal string like "12.345" to a scaled BigInt (scale=18). */
export function parseDec(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  const s = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) throw new Error(`Invalid decimal: ${value}`);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart = ""] = body.split(".");
  const frac = (fracPart + "0".repeat(SCALE)).slice(0, SCALE);
  const raw = BigInt(intPart) * SCALE_FACTOR + BigInt(frac || "0");
  return neg ? -raw : raw;
}

/** Format a scaled BigInt back to a decimal string with optional precision trimming. */
export function formatDec(raw: bigint, precision = SCALE): string {
  const neg = raw < BigInt(0);
  const abs = neg ? -raw : raw;
  const intPart = abs / SCALE_FACTOR;
  const fracRaw = (abs % SCALE_FACTOR).toString().padStart(SCALE, "0");
  const trimmed = precision >= SCALE ? fracRaw : fracRaw.slice(0, precision);
  const result =
    trimmed.length > 0 ? `${intPart.toString()}.${trimmed}` : intPart.toString();
  // Drop trailing zeros past decimal point but keep at least 1 digit
  const cleaned = result
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return neg ? "-" + cleaned : cleaned;
}

export function add(a: bigint, b: bigint): bigint {
  return a + b;
}
export function sub(a: bigint, b: bigint): bigint {
  return a - b;
}
/** Fixed-point multiplication: (a/1e18) * (b/1e18) = a*b/1e18 */
export function mul(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE_FACTOR;
}
/** Fixed-point division: a / b, both scaled. */
export function div(a: bigint, b: bigint): bigint {
  if (b === BigInt(0)) throw new Error("div by zero");
  return (a * SCALE_FACTOR) / b;
}

export const ZERO = BigInt(0);

export function gt(a: bigint, b: bigint) {
  return a > b;
}
export function gte(a: bigint, b: bigint) {
  return a >= b;
}
export function lt(a: bigint, b: bigint) {
  return a < b;
}
export function lte(a: bigint, b: bigint) {
  return a <= b;
}
export function eq(a: bigint, b: bigint) {
  return a === b;
}

/** Round down to a multiple of `step` (both scaled BigInt). */
export function floorStep(value: bigint, step: bigint): bigint {
  if (step <= BigInt(0)) return value;
  return (value / step) * step;
}
