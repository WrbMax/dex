/**
 * External REST API — Walldex market data and trading API.
 *
 * Public (no auth):
 *   GET /api/v1/ping
 *   GET /api/v1/time
 *   GET /api/v1/exchangeInfo
 *   GET /api/v1/ticker/24hr?symbol=
 *   GET /api/v1/klines?symbol=&interval=1m
 *   GET /api/v1/depth?symbol=&limit=
 *   GET /api/v1/trades?symbol=&limit=
 *
 * Authenticated via API key (HMAC-SHA256):
 *   POST /api/v1/order           (place)
 *   DELETE /api/v1/order         (cancel)
 *   GET /api/v1/openOrders
 *   GET /api/v1/account          (balances)
 *
 * Signing scheme: `X-WALLDEX-APIKEY` header + `signature` query param computed as
 * HMAC_SHA256(secret, queryString). The queryString MUST include a `timestamp`
 * within the last 60s.
 */

import type { Express, Request, Response, NextFunction } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { decryptApiSecret } from "../apikeys/service";
import { getDb } from "../../db";
import { apiKeys, orders as ordersTable, trades as tradesTable, users } from "../../../drizzle/schema";
import { getMarketDataHub } from "../marketdata/hub";
import { getMatchingEngine } from "../matching/engine";
import { allMarketsCached, ensureMarketsLoaded, getMarket } from "../markets/registry";
import { getUserBalances, ensureDefaultSubAccount } from "../accounts/ledger";
import { rateLimit } from "./ratelimit";
import { getBinanceDepth } from "../marketdata/depth_mirror";
import { getBinance24hrTicker, getBinanceRecentTrades } from "../marketdata/binance_rest";

type AuthedReq = Request & { exchangeUserId?: number; apiKeyPermissions?: { read: boolean; trade: boolean; withdraw: boolean } };

function clientIp(req: Request) {
  const forwarded = String(req.header("x-forwarded-for") || "").split(",")[0]?.trim();
  return forwarded || req.ip || req.socket.remoteAddress || "";
}

function ipAllowed(req: Request, whitelist: unknown) {
  const entries = Array.isArray(whitelist) ? whitelist.map(String).filter(Boolean) : [];
  if (entries.length === 0) return true;
  const ip = clientIp(req).replace(/^::ffff:/, "");
  return entries.includes(ip);
}

const WINDOW_MS = 60_000;

async function requireApiKey(req: AuthedReq, res: Response, next: NextFunction) {
  try {
    const apiKey = req.header("X-WALLDEX-APIKEY") || req.header("x-walldex-apikey") || req.header("X-MBX-APIKEY") || req.header("x-mbx-apikey");
    const signature = String(req.query.signature ?? "");
    const timestamp = Number(req.query.timestamp ?? 0);
    if (!apiKey) return res.status(401).json({ code: -2014, msg: "API-key required" });
    if (!signature) return res.status(401).json({ code: -1022, msg: "Signature required" });
    if (!timestamp || Math.abs(Date.now() - timestamp) > WINDOW_MS) {
      return res.status(401).json({ code: -1021, msg: "Timestamp outside recv window" });
    }

    const db = await getDb();
    if (!db) return res.status(500).json({ code: -1000, msg: "DB unavailable" });
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.publicKey, apiKey));
    if (!key || key.revokedAt)
      return res.status(401).json({ code: -2015, msg: "Invalid API key" });
    if (!ipAllowed(req, key.ipWhitelist)) {
      return res.status(403).json({ code: -2015, msg: "API key IP whitelist rejected" });
    }

    const [owner] = await db
      .select({ id: users.id, isBanned: users.isBanned })
      .from(users)
      .where(eq(users.id, key.userId))
      .limit(1);
    if (!owner || owner.isBanned) {
      return res.status(403).json({ code: -2015, msg: "API key user is disabled" });
    }

    // Recompute signature over the original query string (minus `signature`)
    const qs = new URL(req.url, "http://x").search.replace(/^\?/, "");
    const canonical = qs
      .split("&")
      .filter((p) => !p.startsWith("signature="))
      .join("&");
    const expected = createHmac("sha256", decryptApiSecret(String(key.secretHash))).update(canonical).digest("hex");
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return res.status(401).json({ code: -1022, msg: "Signature mismatch" });
    }

    req.exchangeUserId = key.userId;
    req.apiKeyPermissions = key.permissions as { read: boolean; trade: boolean; withdraw: boolean };
    // Update lastUsedAt
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
    next();
  } catch (err) {
    console.error("[api] auth error", err);
    res.status(500).json({ code: -1000, msg: "Internal error" });
  }
}

export function registerExchangeRestApi(app: Express) {
  const hub = getMarketDataHub();

  const rlPub = rateLimit("public");
  const rlPriv = rateLimit("private");

  app.get("/api/v1/ping", rlPub, (_req, res) => res.json({}));
  app.get("/api/v1/time", rlPub, (_req, res) => res.json({ serverTime: Date.now() }));

  app.get("/api/v1/exchangeInfo", rlPub, async (_req, res) => {
    await ensureMarketsLoaded();
    const symbols = allMarketsCached().map((m) => ({
      symbol: m.symbol,
      status: m.isActive ? "TRADING" : "HALT",
      baseAsset: m.base,
      quoteAsset: m.quote,
      baseAssetPrecision: m.amountPrecision,
      quoteAssetPrecision: m.pricePrecision,
      logoUrl: m.logoUrl ?? null,
      description: m.description ?? null,
      websiteUrl: m.websiteUrl ?? null,
      whitepaperUrl: m.whitepaperUrl ?? null,
      explorerUrl: m.explorerUrl ?? null,
      contractAddress: m.contractAddress ?? null,
      filters: [
        { filterType: "PRICE_FILTER", tickSize: m.priceTick },
        { filterType: "LOT_SIZE", stepSize: m.amountStep },
        { filterType: "MIN_NOTIONAL", minNotional: m.minNotional },
      ],
    }));
    res.json({ timezone: "UTC", serverTime: Date.now(), symbols });
  });

  app.get("/api/v1/ticker/24hr", rlPub, async (req, res) => {
    await ensureMarketsLoaded();
    const symbol = String(req.query.symbol ?? "");
    if (symbol) {
      const market = getMarket(symbol);
      if (!market) return res.status(404).json({ code: -1121, msg: "Invalid symbol" });
      const upstreamSymbol = (market.externalSymbol || market.symbol).toUpperCase();
      if (market.marketMode === "binance_mirror" && market.marketDataSource === "binance") {
        const bt = await getBinance24hrTicker(upstreamSymbol).catch(() => null);
        if (bt) return res.json(formatBinanceTicker(bt));
      }
      const t = hub.getTicker(symbol);
      if (!t) return res.status(404).json({ code: -1121, msg: "Invalid symbol" });
      return res.json(formatTicker(t));
    }
    res.json(hub.listTickers().map(formatTicker));
  });

  app.get("/api/v1/klines", rlPub, (req, res) => {
    const symbol = String(req.query.symbol ?? "");
    const interval = String(req.query.interval ?? "1m");
    if (interval !== "1m")
      return res.status(400).json({ code: -1121, msg: "Only 1m is supported in v1" });
    const rows = hub.getKlines(symbol);
    res.json(
      rows.map((k) => [k.openTime, k.open, k.high, k.low, k.close, k.volume])
    );
  });

  app.get("/api/v1/depth", rlPub, async (req, res) => {
    await ensureMarketsLoaded();
    const symbol = String(req.query.symbol ?? "");
    // FIX: Clamp limit to [1, 50]. Math.min(NaN, 50) = NaN and Math.min(-1, 50) = -1,
    // both of which would pass a negative/NaN value into eng.depth() and cause
    // Array.slice(0, NaN) to return [] (empty depth) or unexpected behaviour.
    const rawLimit = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 50)) : 20;
    const market = getMarket(symbol);
    if (!market) return res.status(404).json({ code: -1121, msg: "Invalid symbol" });
    if (market.marketMode === "binance_mirror" && market.marketDataSource === "binance") {
      const upstreamSymbol = (market.externalSymbol || market.symbol).toUpperCase();
      const mirror = await getBinanceDepth(upstreamSymbol, limit).catch(() => null);
      if (mirror) return res.json({ lastUpdateId: Date.now(), bids: mirror.bids, asks: mirror.asks });
    }
    const eng = await getMatchingEngine();
    const d = eng.depth(symbol, limit);
    res.json({ lastUpdateId: Date.now(), bids: d.bids, asks: d.asks });
  });

  app.get("/api/v1/trades", rlPub, async (req, res) => {
    await ensureMarketsLoaded();
    const symbol = String(req.query.symbol ?? "");
    const rawLimit = Number(req.query.limit ?? 30);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 30;
    const market = getMarket(symbol);
    if (!market) return res.status(404).json({ code: -1121, msg: "Invalid symbol" });
    if (market.marketMode === "binance_mirror" && market.marketDataSource === "binance") {
      const upstreamSymbol = (market.externalSymbol || market.symbol).toUpperCase();
      const binanceTrades = await getBinanceRecentTrades(upstreamSymbol, limit).catch(() => null);
      if (binanceTrades) {
        return res.json(binanceTrades.map((t) => ({
          id: t.id,
          price: t.price,
          qty: t.qty,
          quoteQty: t.quoteQty,
          time: t.time,
          isBuyerMaker: t.isBuyerMaker,
          isBestMatch: t.isBestMatch,
        })));
      }
    }
    const rows = hub.getRecentTrades(symbol).slice(0, limit);
    res.json(
      rows.map((t) => ({
        id: t.timestamp,
        price: t.price,
        qty: t.quantity,
        time: t.timestamp,
        isBuyerMaker: t.isBuyerMaker,
      }))
    );
  });

  /* ------------ private ------------ */
  app.get("/api/v1/account", rlPriv, requireApiKey, async (req: AuthedReq, res) => {
    const balances = await getUserBalances(req.exchangeUserId!);
    res.json({
      canTrade: req.apiKeyPermissions?.trade ?? false,
      canWithdraw: false,
      canDeposit: false,
      updateTime: Date.now(),
      balances: balances.map((b) => ({
        asset: b.asset,
        free: b.available,
        locked: b.locked,
      })),
    });
  });

  app.get("/api/v1/openOrders", rlPriv, requireApiKey, async (req: AuthedReq, res) => {
    const db = await getDb();
    if (!db) return res.json([]);
    // FIX B004: Push status filter into SQL before LIMIT to avoid silently
    // dropping older open orders when a user has >200 historical orders.
    const { or } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(ordersTable)
      .where(and(
        eq(ordersTable.userId, req.exchangeUserId!),
        or(eq(ordersTable.status, "new"), eq(ordersTable.status, "partial"))
      ))
      .orderBy(desc(ordersTable.createdAt))
      .limit(500);
    res.json(rows.map(toBinanceOrder));
  });

  app.post("/api/v1/order", rlPriv, requireApiKey, async (req: AuthedReq, res) => {
    if (!req.apiKeyPermissions?.trade)
      return res.status(403).json({ code: -2010, msg: "This API key does not have trade permission" });
    const q = req.query as any;
    const symbol = String(q.symbol ?? "");
    const side = String(q.side ?? "").toLowerCase() as "buy" | "sell";
    const type = String(q.type ?? "LIMIT").toLowerCase() as "limit" | "market";
    const price = q.price != null ? String(q.price) : undefined;
    const quantity = String(q.quantity ?? "");
    const clientOrderId = q.newClientOrderId ? String(q.newClientOrderId) : undefined;
    if (!symbol || !quantity)
      return res.status(400).json({ code: -1102, msg: "Missing required fields" });
    const market = getMarket(symbol);
    if (!market) return res.status(400).json({ code: -1121, msg: "Invalid symbol" });

    try {
      const subId = await ensureDefaultSubAccount(req.exchangeUserId!);
      const eng = await getMatchingEngine();
      const r = await eng.submitOrder({
        userId: req.exchangeUserId!,
        subAccountId: subId,
        symbol,
        side,
        type,
        price,
        quantity,
        source: "api",
        clientOrderId,
      });
      res.json(toBinanceOrder(r.order!));
    } catch (err) {
      res.status(400).json({ code: -2010, msg: (err as Error).message });
    }
  });

  app.get("/api/v1/order", rlPriv, requireApiKey, async (req: AuthedReq, res) => {
    const db = await getDb();
    if (!db) return res.status(500).json({ code: -1000, msg: "DB unavailable" });
    const orderId = Number(req.query.orderId ?? 0);
    const origClientOrderId = req.query.origClientOrderId ? String(req.query.origClientOrderId) : undefined;
    if (!orderId && !origClientOrderId) {
      return res.status(400).json({ code: -1102, msg: "orderId or origClientOrderId required" });
    }
    const conds: any[] = [eq(ordersTable.userId, req.exchangeUserId!)];
    if (orderId) conds.push(eq(ordersTable.id, orderId));
    if (origClientOrderId) conds.push(eq(ordersTable.clientOrderId, origClientOrderId));
    const [row] = await db.select().from(ordersTable).where(and(...conds)).limit(1);
    if (!row) return res.status(404).json({ code: -2013, msg: "Order does not exist" });
    res.json(toBinanceOrder(row));
  });

  app.get("/api/v1/myTrades", rlPriv, requireApiKey, async (req: AuthedReq, res) => {
    const db = await getDb();
    if (!db) return res.json([]);
    const symbol = req.query.symbol ? String(req.query.symbol) : undefined;
    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;
    const userCondition = sql`(${tradesTable.buyerUserId} = ${req.exchangeUserId!} OR ${tradesTable.sellerUserId} = ${req.exchangeUserId!})`;
    const whereClause = symbol ? and(userCondition, eq(tradesTable.symbol, symbol)) : userCondition;
    const rows = await db
      .select()
      .from(tradesTable)
      .where(whereClause)
      .orderBy(desc(tradesTable.createdAt))
      .limit(limit);
    res.json(rows.map((t) => ({
      id: t.id,
      orderId: t.buyerUserId === req.exchangeUserId ? t.buyerOrderId : t.sellerOrderId,
      symbol: t.symbol,
      price: t.price,
      qty: t.quantity,
      quoteQty: t.quoteQty,
      commission: t.buyerUserId === req.exchangeUserId ? t.buyerFee : t.sellerFee,
      commissionAsset: t.symbol.endsWith("USDT") ? "USDT" : "",
      time: t.createdAt ? new Date(t.createdAt).getTime() : Date.now(),
      isBuyer: t.buyerUserId === req.exchangeUserId,
      isMaker: t.buyerUserId === req.exchangeUserId ? t.buyerIsMaker : !t.buyerIsMaker,
    })));
  });


  app.delete("/api/v1/order", rlPriv, requireApiKey, async (req: AuthedReq, res) => {
    if (!req.apiKeyPermissions?.trade)
      return res.status(403).json({ code: -2010, msg: "This API key does not have trade permission" });
    const q = req.query as any;
    const orderId = Number(q.orderId ?? 0);
    if (!orderId) return res.status(400).json({ code: -1102, msg: "orderId required" });
    try {
      const eng = await getMatchingEngine();
      const r = await eng.cancelOrder(req.exchangeUserId!, orderId);
      res.json(toBinanceOrder(r));
    } catch (err) {
      res.status(400).json({ code: -2011, msg: (err as Error).message });
    }
  });
}

function formatTicker(t: ReturnType<ReturnType<typeof getMarketDataHub>["getTicker"]> | any) {
  return {
    symbol: t.symbol,
    priceChange: t.change24h,
    priceChangePercent: t.changePct24h,
    lastPrice: t.lastPrice,
    highPrice: t.high24h,
    lowPrice: t.low24h,
    volume: t.volume24h,
    quoteVolume: t.quoteVolume24h,
    closeTime: t.updatedAt,
  };
}

function formatBinanceTicker(t: any) {
  return {
    symbol: t.symbol,
    priceChange: t.priceChange ?? "0",
    priceChangePercent: t.priceChangePercent ?? "0",
    lastPrice: t.lastPrice ?? "0",
    highPrice: t.highPrice ?? "0",
    lowPrice: t.lowPrice ?? "0",
    volume: t.volume ?? "0",
    quoteVolume: t.quoteVolume ?? "0",
    closeTime: t.closeTime ?? Date.now(),
  };
}

function toBinanceOrder(row: any) {
  return {
    symbol: row.symbol,
    orderId: row.id,
    clientOrderId: row.clientOrderId ?? `${row.id}`,
    price: row.price ?? "0",
    origQty: row.quantity,
    executedQty: row.filledQty,
    cummulativeQuoteQty: row.quoteFilled,
    status: row.status.toUpperCase(),
    type: row.type.toUpperCase(),
    side: row.side.toUpperCase(),
    time: row.createdAt ? new Date(row.createdAt).getTime() : Date.now(),
  };
}

