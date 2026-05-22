/**
 * Hedging & platform mode switch.
 *
 * Modes stored in `system_settings` (JSON value):
 *   - "internal_only" : pure peer-to-peer matching among real users
 *   - "hedged"        : platform acts as liquidity provider; filled volume
 *                       triggers a mirror hedge on the external venue. The
 *                       hedge itself is logged here; the live network call is
 *                       a drop-in replacement in `recordHedgeIntent`.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { systemSettings } from "../../../drizzle/schema";
export type PlatformMode = "internal_only" | "hedged";
const MODE_KEY = "platform_mode";
const HEDGE_LOG_KEY = "hedge_log";

// PERF FIX: Cache platformMode in memory to avoid DB round-trip on every order/ticker event.
// The mode changes rarely (manual admin action), so a 2-second TTL is safe.
// setPlatformMode() invalidates the cache immediately so changes take effect instantly.
let _cachedMode: PlatformMode | null = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 2000; // 2 seconds

export async function getPlatformMode(): Promise<PlatformMode> {
  const now = Date.now();
  if (_cachedMode !== null && now < _cacheExpiry) {
    return _cachedMode;
  }
  const db = await getDb();
  if (!db) return "internal_only";
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, MODE_KEY));
  const v = row?.value as unknown;
  let mode: PlatformMode;
  if (typeof v === "string") {
    mode = v === "hedged" ? "hedged" : "internal_only";
  } else if (v && typeof v === "object" && (v as any).mode === "hedged") {
    mode = "hedged";
  } else {
    mode = "internal_only";
  }
  _cachedMode = mode;
  _cacheExpiry = now + CACHE_TTL_MS;
  return mode;
}

export async function setPlatformMode(mode: PlatformMode) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db
    .insert(systemSettings)
    .values({ key: MODE_KEY, value: mode })
    .onDuplicateKeyUpdate({ set: { value: mode } });
  // Invalidate cache immediately so the new mode takes effect right away.
  _cachedMode = mode;
  _cacheExpiry = Date.now() + CACHE_TTL_MS;
}

export async function recordHedgeIntent(intent: {
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
  price: string;
  userOrderId: number;
  venue?: "binance" | "okx";
}) {
  const mode = await getPlatformMode();
  if (mode !== "hedged") return { skipped: true };
  const db = await getDb();
  if (!db) return { skipped: true };
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, HEDGE_LOG_KEY));
  const log: any[] = Array.isArray(row?.value) ? (row!.value as any[]) : [];
  log.unshift({ ...intent, ts: Date.now(), venue: intent.venue ?? "binance" });
  if (log.length > 100) log.length = 100;
  await db
    .insert(systemSettings)
    .values({ key: HEDGE_LOG_KEY, value: log })
    .onDuplicateKeyUpdate({ set: { value: log } });
  return { skipped: false };
}

export async function recentHedgeLog(): Promise<any[]> {
  const db = await getDb();
  if (!db) return [];
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, HEDGE_LOG_KEY));
  return Array.isArray(row?.value) ? (row!.value as any[]) : [];
}
