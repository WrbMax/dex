/**
 * Nexus Wallet → WallDex user synchronization callback.
 *
 * POST /api/wallet/sync-user
 * Headers:
 *   X-Walldex-Timestamp: unix timestamp in seconds or milliseconds
 *   X-Walldex-Signature: hex HMAC-SHA256 over `${timestamp}.${stableJson(body)}`
 * Body:
 *   { "address": "0x...", "chain": "erc20" }
 *   or { "users": [{ "address": "0x...", "chain": "erc20", "walletUserId": "..." }] }
 */
import type { Express, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ENV } from "./_core/env";
import { upsertWeb3User } from "./web3auth";
import { ensureDefaultSubAccount } from "./exchange/accounts/ledger";
import { getOrCreateDepositAddress, type Chain } from "./exchange/deposits/service";
import { getHDWalletStatus } from "./exchange/hdwallet/service";
import { SUPPORTED_CHAINS } from "@shared/wallet";

const MAX_BATCH_SIZE = 100;
const VALID_CHAINS = new Set<Chain>(SUPPORTED_CHAINS);

type SyncUserInput = {
  address: string;
  chain?: Chain;
  walletUserId?: string;
  source?: string;
};

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function parseTimestamp(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n > 10_000_000_000 ? Math.trunc(n / 1000) : Math.trunc(n);
}

function readHeader(req: Request, names: string[]): string | undefined {
  for (const name of names) {
    const value = req.header(name);
    if (value) return value;
  }
  return undefined;
}

function verifySignature(req: Request): { ok: true } | { ok: false; status: number; error: string } {
  const secret = ENV.exchange.walletSync.secret;
  if (!secret) {
    return { ok: false, status: 503, error: "wallet sync secret is not configured" };
  }

  const timestampHeader = readHeader(req, ["x-walldex-timestamp", "x-wallet-sync-timestamp"]);
  const signatureHeader = readHeader(req, ["x-walldex-signature", "x-wallet-sync-signature"]);
  const timestamp = parseTimestamp(timestampHeader);
  if (!timestamp || !signatureHeader) {
    return { ok: false, status: 401, error: "missing timestamp or signature" };
  }

  const now = Math.trunc(Date.now() / 1000);
  if (Math.abs(now - timestamp) > ENV.exchange.walletSync.maxSkewSeconds) {
    return { ok: false, status: 401, error: "timestamp outside accepted window" };
  }

  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  if (!/^[0-9a-fA-F]{64}$/.test(provided)) {
    return { ok: false, status: 401, error: "invalid signature format" };
  }

  const payload = `${timestampHeader}.${stableJson(req.body ?? {})}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, status: 401, error: "signature verification failed" };
  }
  return { ok: true };
}

function extractInputs(body: unknown): SyncUserInput[] {
  const payload = body as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") return [];

  if (Array.isArray(payload.users)) {
    return payload.users.slice(0, MAX_BATCH_SIZE).map((item) => item as SyncUserInput);
  }

  if (typeof payload.address === "string") {
    return [payload as SyncUserInput];
  }

  return [];
}

async function syncOne(input: SyncUserInput) {
  const chain = input.chain && VALID_CHAINS.has(input.chain) ? input.chain : "erc20";
  if (!input.address || !isValidAddress(input.address)) {
    return { ok: false as const, address: input.address ?? "", error: "invalid address" };
  }

  const address = normalizeAddress(input.address);
  const user = await upsertWeb3User(address);
  const subAccountId = await ensureDefaultSubAccount(user.id);
  const depositAddress = await getOrCreateDepositAddress(user.id, chain);

  return {
    ok: true as const,
    walletUserId: input.walletUserId ?? null,
    address,
    chain,
    userId: user.id,
    openId: user.openId,
    role: user.role,
    subAccountId,
    depositAddress: depositAddress.address,
    derivationPath: depositAddress.derivationPath,
  };
}

export function registerWalletSyncRoutes(app: Express) {
  app.get("/api/wallet/sync-status", (_req: Request, res: Response) => {
    const hd = getHDWalletStatus();
    res.json({
      ok: true,
      walletSyncConfigured: Boolean(ENV.exchange.walletSync.secret),
      maxSkewSeconds: ENV.exchange.walletSync.maxSkewSeconds,
      hdWallet: {
        mode: hd.mode,
        accountIndex: hd.accountIndex,
      },
    });
  });

  app.post("/api/wallet/sync-user", async (req: Request, res: Response) => {
    const auth = verifySignature(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

    const inputs = extractInputs(req.body);
    if (inputs.length === 0) {
      return res.status(400).json({ ok: false, error: "body must contain address or users[]" });
    }
    if (Array.isArray((req.body as Record<string, unknown>)?.users) && (req.body as { users: unknown[] }).users.length > MAX_BATCH_SIZE) {
      return res.status(400).json({ ok: false, error: `users[] batch size must not exceed ${MAX_BATCH_SIZE}` });
    }

    try {
      const results = [];
      for (const input of inputs) {
        results.push(await syncOne(input));
      }
      const failed = results.filter((r) => !r.ok).length;
      res.json({ ok: failed === 0, total: results.length, failed, results });
    } catch (err) {
      console.error("[walletSync] sync-user error", err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });
}
