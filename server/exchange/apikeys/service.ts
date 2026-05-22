/**
 * API Key management — HMAC style, same shape as Binance SDK expects.
 *
 * Each key = public identifier + raw secret. The raw secret is returned exactly
 * once on creation. New secrets are encrypted at rest in the legacy `secretHash`
 * column so existing migrations remain compatible; legacy plaintext rows are
 * still accepted for backwards compatibility.
 */

import { desc, eq, and, isNull, count, like, or } from "drizzle-orm";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { getDb } from "../../db";
import { apiKeys } from "../../../drizzle/schema";

export type ApiKeyPermissions = {
  read: boolean;
  trade: boolean;
  withdraw: boolean;
};

const ENC_PREFIX = "enc:";
const ENC_VERSION = Buffer.from([1]);

function encryptionKey() {
  const material =
    process.env.API_KEY_ENCRYPTION_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.JWT_SECRET ||
    "walldex-dev-api-key-encryption";
  return createHash("sha256").update(material).digest();
}

export function encryptApiSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([ENC_VERSION, iv, tag, encrypted]).toString("base64");
}

export function decryptApiSecret(stored: string) {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const payload = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
  const version = payload.subarray(0, 1)[0];
  if (version !== 1) throw new Error("unsupported api key encryption version");
  const iv = payload.subarray(1, 13);
  const tag = payload.subarray(13, 29);
  const encrypted = payload.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function normalizeIpWhitelist(input?: string[]) {
  return Array.from(
    new Set(
      (input ?? [])
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, 20)
    )
  );
}

function maskKey(publicKey: string) {
  return `${publicKey.slice(0, 8)}…${publicKey.slice(-6)}`;
}

export async function listUserApiKeys(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    publicKey: r.publicKey,
    maskedKey: maskKey(r.publicKey),
    permissions: r.permissions as ApiKeyPermissions,
    ipWhitelist: (r.ipWhitelist as string[] | null) ?? [],
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  }));
}

export async function createApiKey(
  userId: number,
  label: string,
  permissions: ApiKeyPermissions = { read: true, trade: true, withdraw: false },
  ipWhitelist: string[] = []
) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // Force withdraw=false: proceeds must always go to the bound wallet address,
  // never to an SDK-initiated destination.
  const p: ApiKeyPermissions = { ...permissions, read: true, withdraw: false };

  const publicKey = "wdk_" + randomBytes(24).toString("hex"); // 48-char body
  const secret = randomBytes(32).toString("hex"); // 64-char

  await db.insert(apiKeys).values({
    userId,
    label: label.slice(0, 64),
    publicKey,
    secretHash: encryptApiSecret(secret),
    permissions: p,
    ipWhitelist: normalizeIpWhitelist(ipWhitelist),
  });

  // Return secret ONCE — caller must persist it now.
  return { publicKey, secret, permissions: p, ipWhitelist: normalizeIpWhitelist(ipWhitelist), label };
}

export async function revokeApiKey(userId: number, id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));
  return { ok: true };
}

export async function listAdminApiKeys(input: {
  page: number;
  pageSize: number;
  search?: string;
  includeRevoked?: boolean;
}) {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };
  const conditions: any[] = [];
  if (!input.includeRevoked) conditions.push(isNull(apiKeys.revokedAt));
  const search = input.search?.trim();
  if (search) {
    const parts: any[] = [like(apiKeys.label, `%${search}%`), like(apiKeys.publicKey, `%${search}%`)];
    const userId = Number(search);
    if (Number.isInteger(userId) && userId > 0) parts.push(eq(apiKeys.userId, userId));
    conditions.push(or(...parts));
  }
  const whereClause = conditions.length ? and(...conditions) : undefined;
  const offset = (input.page - 1) * input.pageSize;
  const totalRow = whereClause
    ? await db.select({ c: count() }).from(apiKeys).where(whereClause)
    : await db.select({ c: count() }).from(apiKeys);
  const rows = await db
    .select()
    .from(apiKeys)
    .where(whereClause)
    .orderBy(desc(apiKeys.createdAt))
    .limit(input.pageSize)
    .offset(offset);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      label: r.label,
      publicKey: r.publicKey,
      maskedKey: maskKey(r.publicKey),
      permissions: r.permissions as ApiKeyPermissions,
      ipWhitelist: (r.ipWhitelist as string[] | null) ?? [],
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
      secretEncrypted: String(r.secretHash).startsWith(ENC_PREFIX),
    })),
    total: totalRow[0]?.c ?? 0,
  };
}

export async function revokeAnyApiKey(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const [before] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!before) throw new Error("API Key not found");
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
  return { ok: true, before };
}
