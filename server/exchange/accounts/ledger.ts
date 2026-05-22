/**
 * LedgerEngine — atomic balance mutation + journal entry.
 *
 * All balance changes (deposits, withdrawals, transfers, order freeze/unfreeze,
 * trade fills, fees, hedge adjustments) MUST go through this module. Each call
 * writes exactly one row in `ledger_entries` and updates `asset_accounts` in
 * the same database transaction, so the sum of ledger `delta` + `lockedDelta`
 * matches the live balance snapshot.
 *
 * P0 hardening:
 * - Use parameterized SQL only; no user-controlled value is concatenated into SQL.
 * - Apply multi-leg ledger changes inside one DB transaction.
 * - Lock each account row with SELECT ... FOR UPDATE before computing balances.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb, getRawPool } from "../../db";
import {
  assetAccounts,
  ledgerEntries,
  subAccounts,
} from "../../../drizzle/schema";
import { formatDec, parseDec } from "../utils/bigdec";

export type LedgerReason =
  | "deposit"
  | "withdraw_freeze"
  | "withdraw_complete"
  | "withdraw_revert"
  | "transfer_out"
  | "transfer_in"
  | "order_freeze"
  | "order_unfreeze"
  | "trade_fill"
  | "trade_fee"
  | "hedge_adjust"
  | "admin_adjust";

export type LedgerChange = {
  userId: number;
  subAccountId: number;
  asset: string;
  /** Change applied to `available` balance. Can be negative. */
  delta: bigint;
  /** Change applied to `locked` balance. Can be negative. */
  lockedDelta: bigint;
  reason: LedgerReason;
  refTable?: string;
  refId?: number;
};

export type BalanceSnapshot = {
  asset: string;
  available: string;
  locked: string;
  total: string;
};

const ASSET_RE = /^[A-Z0-9]{1,16}$/;
const REF_TABLE_RE = /^[a-zA-Z0-9_]{1,64}$/;

function validateLedgerChange(c: LedgerChange) {
  if (!Number.isInteger(c.userId) || c.userId <= 0) {
    throw new Error("Invalid ledger userId");
  }
  if (!Number.isInteger(c.subAccountId) || c.subAccountId <= 0) {
    throw new Error("Invalid ledger subAccountId");
  }
  if (!ASSET_RE.test(c.asset)) {
    throw new Error(`Invalid ledger asset: ${c.asset}`);
  }
  if (c.refTable !== undefined && !REF_TABLE_RE.test(c.refTable)) {
    throw new Error(`Invalid ledger refTable: ${c.refTable}`);
  }
  if (c.refId !== undefined && (!Number.isInteger(c.refId) || c.refId < 0)) {
    throw new Error("Invalid ledger refId");
  }
}

/** Ensure every user has a default sub account. Returns its id. */
export async function ensureDefaultSubAccount(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const existing = await db
    .select()
    .from(subAccounts)
    .where(and(eq(subAccounts.userId, userId), eq(subAccounts.isDefault, true)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  await db.insert(subAccounts).values({
    userId,
    name: "main",
    isDefault: true,
  });
  const [created] = await db
    .select()
    .from(subAccounts)
    .where(and(eq(subAccounts.userId, userId), eq(subAccounts.isDefault, true)))
    .limit(1);
  if (!created) throw new Error("Failed to create default sub account");
  return created.id;
}

/**
 * Apply a ledger change. All-or-nothing inside a transaction.
 * Throws when the mutation would drive `available` or `locked` below zero.
 */
export async function applyLedgerChange(change: LedgerChange) {
  await applyLedgerChanges([change]);
}

/**
 * Batch-apply multiple changes atomically.
 *
 * Exchange accounting must prefer correctness over one fewer network round trip.
 * The earlier implementation intentionally avoided a transaction and built a
 * multi-statement SQL string. That was fast but unsafe: a later leg could fail
 * after an earlier leg committed, and user-controlled symbols/ref fields widened
 * the SQL injection blast radius. This version uses one connection, one
 * transaction, row locks, and parameterized statements.
 */
export async function applyLedgerChanges(changes: LedgerChange[]) {
  if (changes.length === 0) return;
  for (const c of changes) validateLedgerChange(c);

  const pool = await getRawPool();
  if (!pool) {
    return applyLedgerChangesFallback(changes);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await applyLedgerChangesOnConnection(conn, changes);
    await conn.commit();
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      console.error("[ledger] rollback failed", rollbackErr);
    }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Apply ledger changes using an existing transaction/connection.
 *
 * This is intentionally exported for higher-level money workflows such as
 * deposits and withdrawals, where the business row and the balance mutation
 * must commit or rollback together. The caller owns begin/commit/rollback.
 */
export async function applyLedgerChangesOnConnection(conn: any, changes: LedgerChange[]) {
  for (const c of changes) {
    validateLedgerChange(c);

    await conn.execute(
      `INSERT INTO asset_accounts (userId, subAccountId, asset, available, locked)
       VALUES (?, ?, ?, 0, 0)
       ON DUPLICATE KEY UPDATE asset = asset`,
      [c.userId, c.subAccountId, c.asset]
    );

    const [rows] = await conn.execute(
      `SELECT available, locked
         FROM asset_accounts
        WHERE subAccountId = ? AND asset = ?
        FOR UPDATE`,
      [c.subAccountId, c.asset]
    ) as unknown[];
    const row = (rows as Array<{ available: string; locked: string }>)[0];
    if (!row) throw new Error(`Ledger account not found for ${c.asset}`);

    const available = parseDec(row.available);
    const locked = parseDec(row.locked);
    const nextAvailable = available + c.delta;
    const nextLocked = locked + c.lockedDelta;

    if (nextAvailable < 0n) {
      throw new Error(
        `Insufficient ${c.asset} available (need ${formatDec(-c.delta)}, have ${row.available})`
      );
    }
    if (nextLocked < 0n) {
      throw new Error(
        `Insufficient ${c.asset} locked (need ${formatDec(-c.lockedDelta)}, have ${row.locked})`
      );
    }

    await conn.execute(
      `UPDATE asset_accounts
          SET available = ?, locked = ?
        WHERE subAccountId = ? AND asset = ?`,
      [formatDec(nextAvailable), formatDec(nextLocked), c.subAccountId, c.asset]
    );

    await conn.execute(
      `INSERT INTO ledger_entries
        (userId, subAccountId, asset, delta, lockedDelta, reason, refTable, refId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.userId,
        c.subAccountId,
        c.asset,
        formatDec(c.delta),
        formatDec(c.lockedDelta),
        c.reason,
        c.refTable ?? null,
        c.refId ?? null,
      ]
    );
  }
}

/**
 * Fallback implementation using Drizzle ORM (used when raw pool is unavailable).
 * It also wraps all changes in one transaction and uses parameterized SQL.
 */
async function applyLedgerChangesFallback(changes: LedgerChange[]) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  await db.transaction(async (tx) => {
    for (const c of changes) {
      validateLedgerChange(c);
      await tx
        .insert(assetAccounts)
        .values({ userId: c.userId, subAccountId: c.subAccountId, asset: c.asset, available: "0", locked: "0" })
        .onDuplicateKeyUpdate({ set: { asset: c.asset } });

      const [row] = await tx
        .select({ available: assetAccounts.available, locked: assetAccounts.locked })
        .from(assetAccounts)
        .where(
          and(
            eq(assetAccounts.subAccountId, c.subAccountId),
            eq(assetAccounts.asset, c.asset)
          )
        );

      const available = parseDec(row?.available ?? "0");
      const locked = parseDec(row?.locked ?? "0");
      const nextAvailable = available + c.delta;
      const nextLocked = locked + c.lockedDelta;

      if (nextAvailable < 0n) {
        throw new Error(
          `Insufficient ${c.asset} available (need ${formatDec(-c.delta)}, have ${row?.available ?? "0"})`
        );
      }
      if (nextLocked < 0n) {
        throw new Error(
          `Insufficient ${c.asset} locked (need ${formatDec(-c.lockedDelta)}, have ${row?.locked ?? "0"})`
        );
      }

      await tx.execute(
        sql`UPDATE asset_accounts
            SET available = ${formatDec(nextAvailable)},
                locked    = ${formatDec(nextLocked)}
            WHERE subAccountId = ${c.subAccountId}
              AND asset         = ${c.asset}`
      );

      await tx.insert(ledgerEntries).values({
        userId: c.userId,
        subAccountId: c.subAccountId,
        asset: c.asset,
        delta: formatDec(c.delta),
        lockedDelta: formatDec(c.lockedDelta),
        reason: c.reason,
        refTable: c.refTable,
        refId: c.refId,
      });
    }
  });
}

/** Snapshot of all balances for a user. */
export async function getUserBalances(userId: number): Promise<BalanceSnapshot[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(assetAccounts)
    .where(eq(assetAccounts.userId, userId));
  return rows.map((r) => ({
    asset: r.asset,
    available: r.available,
    locked: r.locked,
    total: formatDec(parseDec(r.available) + parseDec(r.locked)),
  }));
}

/** Sum of total equity (available + locked) for a given asset across subaccounts. */
export async function getAssetTotal(userId: number, asset: string) {
  const db = await getDb();
  if (!db) return "0";
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${assetAccounts.available} + ${assetAccounts.locked}), 0)`,
    })
    .from(assetAccounts)
    .where(
      and(eq(assetAccounts.userId, userId), eq(assetAccounts.asset, asset))
    );
  return row?.total ?? "0";
}
