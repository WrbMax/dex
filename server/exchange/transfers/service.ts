/**
 * Transfer service.
 *
 * Supported v1:
 *  - between two sub-accounts of the SAME user, same asset
 *  - cross-asset transfer (move A -> B) is intentionally NOT supported here;
 *    users must place a normal order on the exchange to convert assets.
 */

import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { subAccounts, transfers } from "../../../drizzle/schema";
import { applyLedgerChanges } from "../accounts/ledger";
import { parseDec } from "../utils/bigdec";

export async function listUserSubAccounts(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(subAccounts).where(eq(subAccounts.userId, userId));
}

export async function createSubAccount(userId: number, name: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const insertRes = await db.insert(subAccounts).values({
    userId,
    name: name.slice(0, 64),
    isDefault: false,
  });
  return Number((insertRes as unknown as { insertId: number }).insertId);
}

export async function transferBetweenSubAccounts(params: {
  userId: number;
  fromSubAccountId: number;
  toSubAccountId: number;
  asset: string;
  amount: string;
  note?: string;
}) {
  const amt = parseDec(params.amount);
  if (amt <= 0n) throw new Error("Amount must be positive");
  if (params.fromSubAccountId === params.toSubAccountId) {
    throw new Error("from and to must differ");
  }

  const db = await getDb();
  if (!db) throw new Error("DB not available");

  // Validate both sub-accounts belong to this user
  const owned = await db
    .select()
    .from(subAccounts)
    .where(eq(subAccounts.userId, params.userId));
  const ownedIds = new Set(owned.map((s) => s.id));
  if (
    !ownedIds.has(params.fromSubAccountId) ||
    !ownedIds.has(params.toSubAccountId)
  ) {
    throw new Error("Invalid sub account");
  }

  await applyLedgerChanges([
    {
      userId: params.userId,
      subAccountId: params.fromSubAccountId,
      asset: params.asset,
      delta: -amt,
      lockedDelta: 0n,
      reason: "transfer_out",
    },
    {
      userId: params.userId,
      subAccountId: params.toSubAccountId,
      asset: params.asset,
      delta: amt,
      lockedDelta: 0n,
      reason: "transfer_in",
    },
  ]);

  const insertRes = await db.insert(transfers).values({
    userId: params.userId,
    fromSubAccountId: params.fromSubAccountId,
    toSubAccountId: params.toSubAccountId,
    asset: params.asset,
    amount: params.amount,
    note: params.note ?? null,
  });
  return Number((insertRes as unknown as { insertId: number }).insertId);
}

export async function listUserTransfers(userId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(transfers)
    .where(eq(transfers.userId, userId))
    .orderBy(desc(transfers.createdAt))
    .limit(limit);
}
