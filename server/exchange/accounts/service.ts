import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { users } from "../../../drizzle/schema";
import { isHexAddress, normalizeAddress } from "../utils/address";

export type Chain = "erc20" | "bep20";

/**
 * Bind a wallet address on first registration. Once bound it cannot be changed
 * via the normal API — an admin intervention is required.
 */
export async function bindPrimaryWalletAddress(
  userId: number,
  address: string,
  chain: Chain
) {
  if (!isHexAddress(address)) throw new Error("Invalid wallet address");
  const normalized = normalizeAddress(address);

  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const [existing] = await db.select().from(users).where(eq(users.id, userId));
  if (!existing) throw new Error("User not found");
  if (existing.primaryWalletAddress) {
    if (existing.primaryWalletAddress.toLowerCase() !== normalized) {
      throw new Error("Wallet address already bound and cannot be changed");
    }
    return existing;
  }

  await db
    .update(users)
    .set({
      primaryWalletAddress: normalized,
      registerChain: chain,
      walletBoundAt: new Date(),
    })
    .where(eq(users.id, userId));

  const [updated] = await db.select().from(users).where(eq(users.id, userId));
  return updated!;
}

export async function getAccountProfile(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  if (!row) throw new Error("User not found");
  return {
    id: row.id,
    openId: row.openId,
    primaryWalletAddress: row.primaryWalletAddress,
    registerChain: row.registerChain,
    role: row.role,
    walletBoundAt: row.walletBoundAt,
  };
}
