import { describe, expect, it, vi } from "vitest";

/**
 * Unit tests for withdrawal submission:
 *   the service accepts the caller-supplied destination address and asset symbol,
 *   then freezes the requested asset balance for review.
 */

const userRow = {
  id: 42,
  openId: "sample",
  primaryWalletAddress: "0xabc0000000000000000000000000000000000ABC",
  registerChain: "erc20",
  role: "user",
};

const insertedRows: any[] = [];
const ledgerChanges: any[] = [];

let selectStep = 0;
vi.mock("../../db", () => ({
  getRawPool: async () => null,
  getDb: async () => ({
    select: () => ({
      from: (_t: any) => ({
        where: (_w: any) => {
          selectStep++;
          const rows = selectStep === 1 ? [userRow] : [insertedRows[insertedRows.length - 1]];
          const thenable = {
            then: (resolve: (v: any) => void) => resolve(rows),
            limit: async () => rows,
          };
          return thenable;
        },
      }),
    }),
    insert: (_tbl: any) => ({
      values: async (vals: any) => {
        insertedRows.push({ id: insertedRows.length + 1, ...vals });
        return { insertId: insertedRows.length };
      },
    }),
  }),
}));

vi.mock("../accounts/ledger", () => ({
  applyLedgerChange: async () => undefined,
  applyLedgerChanges: async (...args: any[]) => {
    ledgerChanges.push(args);
  },
  applyLedgerChangesOnConnection: async () => undefined,
  ensureDefaultSubAccount: async () => 11,
}));

const { submitWithdrawal } = await import("./service");

describe("withdrawals — arbitrary destination address and asset", () => {
  it("writes caller-supplied destination address", async () => {
    selectStep = 0;
    insertedRows.length = 0;
    ledgerChanges.length = 0;
    const destination = "0xdef0000000000000000000000000000000000def";
    await submitWithdrawal({
      userId: 42,
      asset: "USDT",
      chain: "erc20",
      amount: "10",
      toAddress: destination,
    });
    const insertedWithdrawal = insertedRows[insertedRows.length - 1];
    expect(insertedWithdrawal.toAddress).toBe(destination.toLowerCase());
    expect(insertedWithdrawal.status).toBe("pending");
  });

  it("accepts non-USDT assets", async () => {
    selectStep = 0;
    insertedRows.length = 0;
    ledgerChanges.length = 0;
    await submitWithdrawal({
      userId: 42,
      asset: "BTC",
      chain: "bitcoin",
      amount: "0.25",
      toAddress: "bc1qexamplewithdrawaddress000000000000000000",
    });
    const insertedWithdrawal = insertedRows[insertedRows.length - 1];
    expect(insertedWithdrawal.asset).toBe("BTC");
    expect(insertedWithdrawal.toAddress).toBe("bc1qexamplewithdrawaddress000000000000000000");
  });

  it("rejects zero / negative amounts before touching the DB", async () => {
    selectStep = 0;
    insertedRows.length = 0;
    await expect(
      submitWithdrawal({
        userId: 42,
        asset: "USDT",
        chain: "erc20",
        amount: "0",
        toAddress: "0xdef0000000000000000000000000000000000def",
      })
    ).rejects.toThrow(/positive/);
    expect(insertedRows).toHaveLength(0);
  });
});
