import type { Request, Response, NextFunction } from "express";
import { ENV } from "../../_core/env";

/**
 * Simple in-memory token bucket per identity. Identity defaults to the API
 * key provided in the `X-WALLDEX-APIKEY` header, or the client IP for
 * unauthenticated routes.
 *
 * Steady-state: ENV.exchange.apiRateLimit.perMinute requests per minute.
 * Burst: up to .burst tokens can accumulate.
 *
 * Returns Binance-style error payloads so Binance SDKs can react naturally:
 *   HTTP 429 { code: -1003, msg: "Too many requests" }
 */

type Bucket = { tokens: number; last: number };

const BUCKETS = new Map<string, Bucket>();

function takeToken(id: string, capacity: number, refillPerMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const b = BUCKETS.get(id) ?? { tokens: capacity, last: now };
  const elapsed = now - b.last;
  const refilled = Math.min(capacity, b.tokens + elapsed * refillPerMs);
  if (refilled >= 1) {
    b.tokens = refilled - 1;
    b.last = now;
    BUCKETS.set(id, b);
    return { ok: true, retryAfterMs: 0 };
  }
  b.tokens = refilled;
  b.last = now;
  BUCKETS.set(id, b);
  const needed = 1 - refilled;
  return { ok: false, retryAfterMs: Math.ceil(needed / refillPerMs) };
}

/** Middleware factory. Pass `public` for public routes so the bucket is
 *  keyed by client IP instead of API key. */
export function rateLimit(scope: "public" | "private") {
  const perMin = Math.max(1, ENV.exchange.apiRateLimit.perMinute);
  const burst = Math.max(perMin, ENV.exchange.apiRateLimit.burst + perMin);
  // burst is the bucket capacity; refill at perMin tokens / 60s
  const refillPerMs = perMin / 60_000;

  return (req: Request, res: Response, next: NextFunction) => {
    const id =
      scope === "private"
        ? `k:${req.header("X-WALLDEX-APIKEY") || req.header("x-walldex-apikey") || req.header("X-MBX-APIKEY") || req.header("x-mbx-apikey") || "anon"}`
        : `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
    const { ok, retryAfterMs } = takeToken(id, burst, refillPerMs);
    if (!ok) {
      res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000).toString());
      res.setHeader("X-RateLimit-Limit", String(perMin));
      return res.status(429).json({
        code: -1003,
        msg: `Too many requests; retry in ${Math.ceil(retryAfterMs / 1000)}s`,
      });
    }
    // Record usage in headers to help client back-off.
    res.setHeader("X-RateLimit-Limit", String(perMin));
    res.setHeader("X-RateLimit-Scope", scope);
    next();
  };
}

/** Test-only reset. */
export function _resetRateLimit() {
  BUCKETS.clear();
}
