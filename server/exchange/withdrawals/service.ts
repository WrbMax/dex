/**
 * Withdrawal service.
 *
 * Operational model:
 *  - The client provides the destination address and asset symbol at submit time.
 *  - The withdrawal amount is FROZEN (available -> locked) at submit time.
 *  - An admin must approve before funds leave the platform.
 *  - On confirmation the locked balance is debited and status flips to `confirmed`.
 *  - On reject/fail the locked balance is released back to `available`.
 */

import { desc, eq } from "drizzle-orm";
import { getDb, getRawPool } from "../../db";
import { withdrawals } from "../../../drizzle/schema";
import { applyLedgerChange, applyLedgerChangesOnConnection, ensureDefaultSubAccount } from "../accounts/ledger";
import { parseDec } from "../utils/bigdec";
import { CHAIN_META, getSupportedChainsForAsset, type Chain } from "@shared/wallet";

export type { Chain };

const DEFAULT_USDT_FEE: Record<Chain, string> = {
  erc20: CHAIN_META.erc20.withdrawFeeUSDT,
  trc20: CHAIN_META.trc20.withdrawFeeUSDT,
  bep20: CHAIN_META.bep20.withdrawFeeUSDT,
  polygon: CHAIN_META.polygon.withdrawFeeUSDT,
  arbitrum: CHAIN_META.arbitrum.withdrawFeeUSDT,
  optimism: CHAIN_META.optimism.withdrawFeeUSDT,
  solana: CHAIN_META.solana.withdrawFeeUSDT,
  bitcoin: CHAIN_META.bitcoin.withdrawFeeUSDT,
};

const ASSET_RE = /^[A-Z0-9]{1,16}$/;

function asRows<T>(rows: unknown): T[] {
  return rows as T[];
}

function normalizeAsset(asset: string) {
  const normalized = asset.trim().toUpperCase();
  if (!normalized) throw new Error("Asset is required");
  if (!ASSET_RE.test(normalized)) throw new Error("Invalid asset");
  return normalized;
}

function normalizeDestinationAddress(address: string, chain: Chain) {
  const trimmed = address.trim();
  if (!trimmed) throw new Error("Destination address is required");
  if (trimmed.length > 64) throw new Error("Destination address is too long");

  const evmChains: Chain[] = ["erc20", "bep20", "polygon", "arbitrum", "optimism"];
  if (evmChains.includes(chain) && !/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error("Invalid EVM destination address");
  }
  if (chain === "trc20" && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) {
    throw new Error("Invalid TRON destination address");
  }
  if (chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
    throw new Error("Invalid Solana destination address");
  }
  if (chain === "bitcoin" && !/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(trimmed)) {
    throw new Error("Invalid Bitcoin destination address");
  }
  return trimmed;
}

function assertAssetChainSupported(asset: string, chain: Chain) {
  const supportedChains = getSupportedChainsForAsset(asset);
  if (!supportedChains.includes(chain)) {
    throw new Error(`${asset} withdrawals are not supported on ${CHAIN_META[chain].shortName}`);
  }
}

function withdrawalFee(asset: string, chain: Chain) {
  return asset === "USDT" ? DEFAULT_USDT_FEE[chain] : "0";
}

async function rollbackQuietly(conn: any) {
  try {
    await conn.rollback();
  } catch (err) {
    console.error("[withdrawals] rollback failed", err);
  }
}

export async function submitWithdrawal(params: {
  userId: number;
  chain: Chain;
  asset: string;
  amount: string;
  toAddress: string;
}) {
  const asset = normalizeAsset(params.asset);
  assertAssetChainSupported(asset, params.chain);
  const toAddress = normalizeDestinationAddress(params.toAddress, params.chain);
  const amt = parseDec(params.amount);
  if (amt <= 0n) throw new Error("Amount must be positive");

  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const subAccountId = await ensureDefaultSubAccount(params.userId);
  const feeAmount = withdrawalFee(asset, params.chain);
  const fee = parseDec(feeAmount);
  if (fee > 0n && amt <= fee) {
    throw new Error(`Amount must exceed network fee (${feeAmount} ${asset})`);
  }

  const pool = await getRawPool();
  if (!pool) {
    await applyLedgerChange({
      userId: params.userId,
      subAccountId,
      asset,
      delta: -amt,
      lockedDelta: amt,
      reason: "withdraw_freeze",
    });
    const insertRes = await db.insert(withdrawals).values({
      userId: params.userId,
      subAccountId,
      chain: params.chain,
      asset,
      amount: params.amount,
      feeAmount,
      toAddress,
      status: "pending",
    });
    const id = Number((insertRes as unknown as { insertId: number }).insertId);
    const [row] = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
    return row!;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [insertRes] = await conn.execute(
      `INSERT INTO withdrawals
        (userId, subAccountId, chain, asset, amount, feeAmount, toAddress, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [params.userId, subAccountId, params.chain, asset, params.amount, feeAmount, toAddress]
    ) as unknown[];
    const id = Number((insertRes as { insertId: number }).insertId);
    if (!id) throw new Error("Withdrawal insert failed");

    await applyLedgerChangesOnConnection(conn, [{
      userId: params.userId,
      subAccountId,
      asset,
      delta: -amt,
      lockedDelta: amt,
      reason: "withdraw_freeze",
      refTable: "withdrawals",
      refId: id,
    }]);

    await conn.commit();
    const [row] = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
    return row!;
  } catch (err) {
    await rollbackQuietly(conn);
    throw err;
  } finally {
    conn.release();
  }
}

export async function listUserWithdrawals(userId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(withdrawals)
    .where(eq(withdrawals.userId, userId))
    .orderBy(desc(withdrawals.createdAt))
    .limit(limit);
}

export async function listPendingWithdrawals(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(withdrawals)
    .where(eq(withdrawals.status, "pending"))
    .orderBy(desc(withdrawals.createdAt))
    .limit(limit);
}

/** Admin action: approve a withdrawal, mark as approved (still locked). */
export async function approveWithdrawal(id: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const pool = await getRawPool();
  if (!pool) {
    await db.update(withdrawals).set({ status: "approved" }).where(eq(withdrawals.id, id));
    return;
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT id, status FROM withdrawals WHERE id = ? FOR UPDATE`,
      [id]
    ) as unknown[];
    const row = asRows<{ id: number; status: string }>(rows)[0];
    if (!row) throw new Error("Withdrawal not found");
    if (row.status !== "pending" && row.status !== "reviewing") {
      throw new Error(`Withdrawal cannot be approved from status ${row.status}`);
    }
    await conn.execute(`UPDATE withdrawals SET status = 'approved' WHERE id = ?`, [id]);
    await conn.commit();
  } catch (err) {
    await rollbackQuietly(conn);
    throw err;
  } finally {
    conn.release();
  }
}

/** Admin action: reject a withdrawal and return the locked funds. */
export async function rejectWithdrawal(id: number, reason: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const pool = await getRawPool();
  if (!pool) {
    const [row] = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
    if (!row) throw new Error("Withdrawal not found");
    if (row.status === "confirmed") throw new Error("Already confirmed");
    await applyLedgerChange({
      userId: row.userId,
      subAccountId: row.subAccountId,
      asset: row.asset,
      delta: parseDec(row.amount),
      lockedDelta: -parseDec(row.amount),
      reason: "withdraw_revert",
      refTable: "withdrawals",
      refId: row.id,
    });
    await db.update(withdrawals).set({ status: "rejected", rejectReason: reason }).where(eq(withdrawals.id, id));
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT id, userId, subAccountId, asset, amount, status FROM withdrawals WHERE id = ? FOR UPDATE`,
      [id]
    ) as unknown[];
    const row = asRows<{ id: number; userId: number; subAccountId: number; asset: string; amount: string; status: string }>(rows)[0];
    if (!row) throw new Error("Withdrawal not found");
    if (["confirmed", "rejected", "failed"].includes(row.status)) {
      throw new Error(`Withdrawal cannot be rejected from status ${row.status}`);
    }
    await applyLedgerChangesOnConnection(conn, [{
      userId: row.userId,
      subAccountId: row.subAccountId,
      asset: row.asset,
      delta: parseDec(row.amount),
      lockedDelta: -parseDec(row.amount),
      reason: "withdraw_revert",
      refTable: "withdrawals",
      refId: row.id,
    }]);
    await conn.execute(`UPDATE withdrawals SET status = 'rejected', rejectReason = ? WHERE id = ?`, [reason, id]);
    await conn.commit();
  } catch (err) {
    await rollbackQuietly(conn);
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Called after the signing service successfully broadcasts the tx and it reaches
 * finality. Burns the locked balance and finalizes status.
 */
export async function finalizeWithdrawal(id: number, txHash: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const pool = await getRawPool();
  if (!pool) {
    const [row] = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
    if (!row) throw new Error("Withdrawal not found");
    if (row.status === "confirmed") return;
    await applyLedgerChange({
      userId: row.userId,
      subAccountId: row.subAccountId,
      asset: row.asset,
      delta: 0n,
      lockedDelta: -parseDec(row.amount),
      reason: "withdraw_complete",
      refTable: "withdrawals",
      refId: row.id,
    });
    await db.update(withdrawals).set({ status: "confirmed", txHash }).where(eq(withdrawals.id, id));
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT id, userId, subAccountId, asset, amount, status FROM withdrawals WHERE id = ? FOR UPDATE`,
      [id]
    ) as unknown[];
    const row = asRows<{ id: number; userId: number; subAccountId: number; asset: string; amount: string; status: string }>(rows)[0];
    if (!row) throw new Error("Withdrawal not found");
    if (row.status === "confirmed") {
      await conn.commit();
      return;
    }
    if (row.status !== "approved" && row.status !== "broadcasting") {
      throw new Error(`Withdrawal cannot be finalized from status ${row.status}`);
    }
    await applyLedgerChangesOnConnection(conn, [{
      userId: row.userId,
      subAccountId: row.subAccountId,
      asset: row.asset,
      delta: 0n,
      lockedDelta: -parseDec(row.amount),
      reason: "withdraw_complete",
      refTable: "withdrawals",
      refId: row.id,
    }]);
    await conn.execute(`UPDATE withdrawals SET status = 'confirmed', txHash = ? WHERE id = ?`, [txHash, id]);
    await conn.commit();
  } catch (err) {
    await rollbackQuietly(conn);
    throw err;
  } finally {
    conn.release();
  }
}
