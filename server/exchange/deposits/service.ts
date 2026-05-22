/**
 * Deposit service.
 *
 * First version:
 *  - Each user gets one deterministic deposit address per chain (erc20, bep20),
 *    derived from a server-side HD root + userId. For safety the root is NOT
 *    kept in process memory; we only store the derivation path.
 *  - Credit-on-confirm flow: an external watcher inserts a row in `deposits`
 *    with status='confirmed'; this service then ledger-credits the user and
 *    flips status='credited'.
 *  - For reviewed/manual operations we provide `simulateIncoming()` which mimics a
 *    successful on-chain transfer for the supplied asset symbol so the account
 *    balance can be credited without restricting deposits to one token.
 */

import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb, getRawPool } from "../../db";
import {
  deposits,
  depositAddresses,
  type DepositAddress,
} from "../../../drizzle/schema";
import { applyLedgerChange, applyLedgerChangesOnConnection, ensureDefaultSubAccount } from "../accounts/ledger";
import { parseDec } from "../utils/bigdec";
import { deriveManagedDepositAddress, getDepositDerivationPath } from "../hdwallet/service";
import type { Chain } from "@shared/wallet";

export type { Chain };

async function rollbackQuietly(conn: any) {
  try {
    await conn.rollback();
  } catch (err) {
    console.error("[deposits] rollback failed", err);
  }
}

function asRows<T>(rows: unknown): T[] {
  return rows as T[];
}

export async function getOrCreateDepositAddress(
  userId: number,
  chain: Chain
): Promise<DepositAddress> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const existing = await db
    .select()
    .from(depositAddresses)
    .where(
      and(
        eq(depositAddresses.userId, userId),
        eq(depositAddresses.chain, chain)
      )
    )
    .limit(1);
  if (existing.length > 0) return existing[0];

  const address = deriveManagedDepositAddress(userId, chain);
  await db.insert(depositAddresses).values({
    userId,
    chain,
    address,
    derivationPath: getDepositDerivationPath(userId, chain),
  });
  const [created] = await db
    .select()
    .from(depositAddresses)
    .where(eq(depositAddresses.address, address))
    .limit(1);
  return created!;
}

export async function listUserDepositAddresses(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(depositAddresses)
    .where(eq(depositAddresses.userId, userId));
}

export async function listUserDeposits(userId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(deposits)
    .where(eq(deposits.userId, userId))
    .orderBy(desc(deposits.createdAt))
    .limit(limit);
}

/**
 * Called by the on-chain watcher after the tx reaches the required number of
 * confirmations. The deposit row, ledger credit and credited status are committed
 * in one database transaction when the raw MySQL pool is available.
 */
export async function creditConfirmedDeposit(params: {
  userId: number;
  chain: Chain;
  asset: string;
  amount: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  confirmations: number;
}) {
  const amount = parseDec(params.amount);
  if (amount <= 0n) throw new Error("Deposit amount must be positive");

  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const subAccountId = await ensureDefaultSubAccount(params.userId);

  const pool = await getRawPool();
  if (!pool) {
    const existing = await db
      .select()
      .from(deposits)
      .where(and(eq(deposits.txHash, params.txHash), eq(deposits.chain, params.chain)))
      .limit(1);
    if (existing.length > 0 && existing[0].status === "credited") return;
    await db.insert(deposits).values({
      userId: params.userId,
      subAccountId,
      chain: params.chain,
      asset: params.asset,
      amount: params.amount,
      txHash: params.txHash,
      fromAddress: params.fromAddress,
      toAddress: params.toAddress,
      confirmations: params.confirmations,
      status: "confirmed",
    });
    const [row] = await db.select().from(deposits).where(eq(deposits.txHash, params.txHash)).limit(1);
    await applyLedgerChange({
      userId: params.userId,
      subAccountId,
      asset: params.asset,
      delta: amount,
      lockedDelta: 0n,
      reason: "deposit",
      refTable: "deposits",
      refId: row?.id,
    });
    if (row?.id) await db.update(deposits).set({ status: "credited", creditedAt: new Date() }).where(eq(deposits.id, row.id));
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existingRows] = await conn.execute(
      `SELECT id, status FROM deposits WHERE txHash = ? AND chain = ? FOR UPDATE`,
      [params.txHash, params.chain]
    ) as unknown[];
    const existing = asRows<{ id: number; status: string }>(existingRows)[0];
    let depositId = existing?.id;
    if (existing?.status === "credited") {
      await conn.commit();
      return;
    }
    if (!depositId) {
      const [insertRes] = await conn.execute(
        `INSERT INTO deposits
          (userId, subAccountId, chain, asset, amount, txHash, fromAddress, toAddress, confirmations, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
        [params.userId, subAccountId, params.chain, params.asset, params.amount, params.txHash, params.fromAddress, params.toAddress, params.confirmations]
      ) as unknown[];
      depositId = Number((insertRes as { insertId: number }).insertId);
      if (!depositId) throw new Error("Deposit insert failed");
    }

    await applyLedgerChangesOnConnection(conn, [{
      userId: params.userId,
      subAccountId,
      asset: params.asset,
      delta: amount,
      lockedDelta: 0n,
      reason: "deposit",
      refTable: "deposits",
      refId: depositId,
    }]);
    await conn.execute(
      `UPDATE deposits SET status = 'credited', creditedAt = NOW(), confirmations = ? WHERE id = ?`,
      [params.confirmations, depositId]
    );
    await conn.commit();
  } catch (err) {
    await rollbackQuietly(conn);
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Operational helper used by the admin console to credit a confirmed transfer
 * in non-production environments or after manual finance review.
 */
export async function simulateIncoming(userId: number, chain: Chain, asset: string, amount: string) {
  const normalizedAsset = asset.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,16}$/.test(normalizedAsset)) throw new Error("Invalid asset");
  const addr = await getOrCreateDepositAddress(userId, chain);
  const txHash =
    "0xop" +
    createHash("sha3-256")
      .update(`${Date.now()}:${userId}:${normalizedAsset}:${amount}:${chain}`)
      .digest("hex")
      .slice(0, 61);
  await creditConfirmedDeposit({
    userId,
    chain,
    asset: normalizedAsset,
    amount,
    txHash,
    fromAddress: "0x0000000000000000000000000000000000000000",
    toAddress: addr.address,
    confirmations: 12,
  });
  return { txHash, address: addr.address, asset: normalizedAsset };
}
