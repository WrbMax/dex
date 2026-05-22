import { describe, it, expect, vi } from "vitest";

/**
 * Integration-style test for transferBetweenSubAccounts that does NOT require a
 * real MySQL connection. We mock the DB layer and assert the service correctly
 * calls applyLedgerChanges with a pair of offsetting entries, which is the
 * atomic invariant that guarantees no value is created or destroyed inside the
 * exchange when a user moves money between their own sub-accounts.
 */

vi.mock("../../db", () => ({
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: async () => [
          { id: 1, userId: 7, name: "main", isDefault: true },
          { id: 2, userId: 7, name: "trade", isDefault: false },
        ],
      }),
    }),
    insert: () => ({ values: async () => ({ insertId: 99 }) }),
  }),
}));

const ledgerCalls: any[] = [];
vi.mock("../accounts/ledger", () => ({
  applyLedgerChanges: async (changes: any[]) => {
    ledgerCalls.push(changes);
  },
}));

const { transferBetweenSubAccounts } = await import("./service");

describe("transferBetweenSubAccounts", () => {
  it("rejects non-positive amounts before touching the ledger", async () => {
    ledgerCalls.length = 0;
    await expect(
      transferBetweenSubAccounts({
        userId: 7,
        fromSubAccountId: 1,
        toSubAccountId: 2,
        asset: "USDT",
        amount: "0",
      })
    ).rejects.toThrow();
    expect(ledgerCalls).toHaveLength(0);
  });

  it("rejects identical from/to sub-accounts", async () => {
    ledgerCalls.length = 0;
    await expect(
      transferBetweenSubAccounts({
        userId: 7,
        fromSubAccountId: 1,
        toSubAccountId: 1,
        asset: "USDT",
        amount: "10",
      })
    ).rejects.toThrow();
  });

  it("rejects sub-accounts that do not belong to the caller", async () => {
    ledgerCalls.length = 0;
    await expect(
      transferBetweenSubAccounts({
        userId: 7,
        fromSubAccountId: 1,
        toSubAccountId: 999, // not in the mocked owned set
        asset: "USDT",
        amount: "10",
      })
    ).rejects.toThrow();
    expect(ledgerCalls).toHaveLength(0);
  });

  it("moves balance with two offsetting ledger rows (zero-sum)", async () => {
    ledgerCalls.length = 0;
    await transferBetweenSubAccounts({
      userId: 7,
      fromSubAccountId: 1,
      toSubAccountId: 2,
      asset: "USDT",
      amount: "123.456",
    });
    expect(ledgerCalls).toHaveLength(1);
    const [changes] = ledgerCalls;
    expect(changes).toHaveLength(2);
    const totalDelta = changes.reduce((a: bigint, c: any) => a + c.delta, 0n);
    expect(totalDelta).toBe(0n);
    const [outLeg, inLeg] = changes;
    expect(outLeg.subAccountId).toBe(1);
    expect(outLeg.delta < 0n).toBe(true);
    expect(inLeg.subAccountId).toBe(2);
    expect(inLeg.delta > 0n).toBe(true);
  });
});
