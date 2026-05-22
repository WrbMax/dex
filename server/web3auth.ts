/**
 * Web3 Authentication with EIP-4361 (Sign-In with Ethereum / SIWE)
 *
 * v2.0: Replaces plain nonce signing with structured SIWE messages.
 * Users see a human-readable message containing:
 *   - Which domain is requesting login
 *   - What the login statement says
 *   - Their wallet address
 *   - Chain ID
 *   - Nonce (anti-replay)
 *   - Issued time and expiration
 *
 * This gives users full transparency about what they're signing.
 */
import type { Express, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { SiweMessage, generateNonce as siweGenerateNonce } from "siwe";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { rabbitBridgeGuard } from "./rabbitBridge";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getAddress } from "viem";

// ── Configuration ──────────────────────────────────────────────────────────

/**
 * SIWE Configuration — set via environment variables.
 * SIWE_DOMAIN: The domain requesting the sign-in (e.g., "walldex.io")
 * SIWE_URI: The full URI of the application (e.g., "https://walldex.io")
 * SIWE_STATEMENT: Human-readable statement shown to user
 * SIWE_CHAIN_ID: EVM chain ID (default: 1 for Ethereum mainnet)
 * SIWE_EXPIRATION_MINUTES: How long the SIWE message is valid (default: 10)
 */
const SIWE_DOMAIN = process.env.SIWE_DOMAIN ?? "walldex.io";
const SIWE_URI = process.env.SIWE_URI ?? "https://walldex.io";
const SIWE_STATEMENT = process.env.SIWE_STATEMENT ?? "Sign in to WallDex Exchange with your Rabbit Wallet";
const SIWE_CHAIN_ID = Number(process.env.SIWE_CHAIN_ID ?? "1");
const SIWE_EXPIRATION_MINUTES = Number(process.env.SIWE_EXPIRATION_MINUTES ?? "10");

// ── Nonce Store ────────────────────────────────────────────────────────────

interface NonceEntry {
  nonce: string;
  createdAt: number;
  address: string;
}

const nonceStore = new Map<string, NonceEntry>(); // address → entry
const NONCE_TTL_MS = SIWE_EXPIRATION_MINUTES * 60 * 1000;

function pruneNonces() {
  const now = Date.now();
  for (const [addr, entry] of nonceStore) {
    if (now - entry.createdAt > NONCE_TTL_MS) {
      nonceStore.delete(addr);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export async function upsertWeb3User(address: string) {
  const db = await getDb();
  const normalized = normalizeAddress(address);
  const openId = `web3:${normalized}`;
  let [existing] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  if (!existing) {
    [existing] = await db.select().from(users).where(eq(users.primaryWalletAddress, normalized)).limit(1);
  }
  if (existing) {
    await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, existing.id));
    const [updated] = await db.select().from(users).where(eq(users.id, existing.id)).limit(1);
    return updated!;
  }
  // New user: create with wallet address as identity
  const ownerRaw = process.env.OWNER_OPEN_ID || "";
  const ownerAddr = ownerRaw.startsWith("web3:") ? ownerRaw.slice(5) : ownerRaw;
  const isOwner = normalized === normalizeAddress(ownerAddr);
  const role: "user" | "admin" = isOwner ? "admin" : "user";
  await db.insert(users).values({
    openId,
    name: `${normalized.slice(0, 6)}...${normalized.slice(-4)}`,
    loginMethod: "rabbit_bridge",
    role,
    primaryWalletAddress: normalized,
    registerChain: "erc20",
    walletBoundAt: new Date(),
    lastSignedIn: new Date(),
  });
  const [created] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return created!;
}

// ── Route Registration ─────────────────────────────────────────────────────

export function registerWeb3AuthRoutes(app: Express) {
  /**
   * GET /api/web3/nonce?address=0x...
   * Protected by Rabbit Bridge dynamic signature guard.
   *
   * Returns:
   *   - nonce: Random string for SIWE message
   *   - siweMessage: Pre-built SIWE message string for the client to present to user
   *   - issuedAt: ISO timestamp
   *   - expirationTime: ISO timestamp
   */
  app.get("/api/web3/nonce", rabbitBridgeGuard, (req: Request, res: Response) => {
    pruneNonces();
    const address = String(req.query.address ?? "").toLowerCase();
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const nonce = siweGenerateNonce();
    const issuedAt = new Date();
    const expirationTime = new Date(issuedAt.getTime() + SIWE_EXPIRATION_MINUTES * 60 * 1000);

    // Build SIWE message — SIWE requires EIP-55 checksummed address
    const checksumAddress = getAddress(address);
    const siweMessage = new SiweMessage({
      domain: SIWE_DOMAIN,
      address: checksumAddress,
      statement: SIWE_STATEMENT,
      uri: SIWE_URI,
      version: "1",
      chainId: SIWE_CHAIN_ID,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: expirationTime.toISOString(),
    });

    const messageStr = siweMessage.prepareMessage();

    // Store nonce
    nonceStore.set(normalizeAddress(address), {
      nonce,
      createdAt: Date.now(),
      address: normalizeAddress(address),
    });

    res.json({
      nonce,
      message: messageStr,
      issuedAt: issuedAt.toISOString(),
      expirationTime: expirationTime.toISOString(),
    });
  });

  /**
   * POST /api/web3/verify
   * Protected by Rabbit Bridge dynamic signature guard.
   *
   * Body: { message: string, signature: string }
   *   - message: The full SIWE message string (as returned by /nonce)
   *   - signature: EIP-191 personal_sign of the SIWE message
   *
   * Verifies the SIWE message structure, nonce, expiration, and signature.
   */
  app.post("/api/web3/verify", rabbitBridgeGuard, async (req: Request, res: Response) => {
    try {
      const { message, signature } = req.body ?? {};
      if (!message || !signature) {
        return res.status(400).json({ error: "message and signature are required" });
      }

      // Parse and verify the SIWE message
      let siweMsg: SiweMessage;
      try {
        siweMsg = new SiweMessage(message);
      } catch (parseErr) {
        return res.status(400).json({ error: "Invalid SIWE message format" });
      }

      // Verify domain matches our configured domain
      if (siweMsg.domain !== SIWE_DOMAIN) {
        return res.status(401).json({ error: "Domain mismatch" });
      }

      // Verify chain ID
      if (siweMsg.chainId !== SIWE_CHAIN_ID) {
        return res.status(401).json({ error: "Chain ID mismatch" });
      }

      const address = normalizeAddress(siweMsg.address);

      // Check nonce exists and matches
      const stored = nonceStore.get(address);
      if (!stored) {
        return res.status(401).json({ error: "Nonce not found — request a new one" });
      }
      if (stored.nonce !== siweMsg.nonce) {
        return res.status(401).json({ error: "Nonce mismatch" });
      }

      // Verify the SIWE message (checks signature, expiration, etc.)
      const verifyResult = await siweMsg.verify({
        signature,
        domain: SIWE_DOMAIN,
        nonce: stored.nonce,
      });

      if (!verifyResult.success) {
        return res.status(401).json({
          error: "SIWE verification failed",
          details: verifyResult.error?.type,
        });
      }

      // Consume nonce (one-time use)
      nonceStore.delete(address);

      // Upsert user in DB
      const user = await upsertWeb3User(address);

      // Issue JWT session cookie
      const displayName = `${address.slice(0, 6)}...${address.slice(-4)}`;
      const token = await sdk.createSessionToken(user.openId, { name: user.name ?? displayName });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      res.json({
        ok: true,
        user: {
          id: user.id,
          address,
          role: user.role,
          name: user.name,
        },
      });
    } catch (err) {
      console.error("[web3auth] verify error", err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/web3/logout
   * No bridge guard needed — anyone with a valid session can log out.
   */
  app.post("/api/web3/logout", (req: Request, res: Response) => {
    const cookieOptions = getSessionCookieOptions(req);
    res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    res.json({ ok: true });
  });
}
