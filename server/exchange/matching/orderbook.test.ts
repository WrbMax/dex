import { describe, it, expect } from "vitest";
import { OrderBook } from "./orderbook";
import { parseDec, formatDec } from "../utils/bigdec";

/**
 * These tests target the pure in-memory matching core.
 * They do not touch the DB, so they are safe to run on every commit.
 */

function buy(book: OrderBook, id: number, user: number, price: string, qty: string) {
  return book.submit({
    id,
    userId: user,
    subAccountId: user,
    side: "buy",
    type: "limit",
    price: parseDec(price),
    quantity: parseDec(qty),
  });
}
function sell(book: OrderBook, id: number, user: number, price: string, qty: string) {
  return book.submit({
    id,
    userId: user,
    subAccountId: user,
    side: "sell",
    type: "limit",
    price: parseDec(price),
    quantity: parseDec(qty),
  });
}

describe("OrderBook — core matching semantics", () => {
  it("rests a non-crossing limit order and exposes it in the depth snapshot", () => {
    const book = new OrderBook("BTCUSDT");
    const r = buy(book, 1, 100, "30000", "1");
    expect(r.fills).toHaveLength(0);
    expect(r.rested).toBe(true);
    const d = book.depth(5);
    expect(d.bids[0][0]).toBe(parseDec("30000").toString());
    expect(d.bids[0][1]).toBe(parseDec("1").toString());
    expect(d.asks).toHaveLength(0);
  });

  it("fully crosses a taker against the best resting maker (price-priority)", () => {
    const book = new OrderBook("BTCUSDT");
    sell(book, 1, 100, "30010", "0.5"); // worse ask
    sell(book, 2, 100, "30005", "0.5"); // best ask
    const r = buy(book, 3, 200, "30010", "0.7");
    expect(r.fills).toHaveLength(2);
    expect(r.fills[0].price).toBe(parseDec("30005")); // best first
    expect(r.fills[0].quantity).toBe(parseDec("0.5"));
    expect(r.fills[1].price).toBe(parseDec("30010"));
    expect(r.fills[1].quantity).toBe(parseDec("0.2"));
    // Remaining 0 — fully filled
    expect(r.remaining).toBe(parseDec("0"));
  });

  it("honors time-priority at equal price (FIFO within a price level)", () => {
    const book = new OrderBook("BTCUSDT");
    sell(book, 1, 100, "30000", "1"); // maker A (first)
    sell(book, 2, 101, "30000", "1"); // maker B (second)
    const r = buy(book, 3, 200, "30000", "1.5");
    // A must be fully consumed before B starts
    expect(r.fills[0].makerOrderId).toBe(1);
    expect(r.fills[0].quantity).toBe(parseDec("1"));
    expect(r.fills[1].makerOrderId).toBe(2);
    expect(r.fills[1].quantity).toBe(parseDec("0.5"));
  });

  it("executes a market order across multiple price levels until filled", () => {
    const book = new OrderBook("BTCUSDT");
    sell(book, 1, 100, "30000", "1");
    sell(book, 2, 100, "30100", "1");
    const r = book.submit({
      id: 3,
      userId: 200,
      subAccountId: 200,
      side: "buy",
      type: "market",
      price: parseDec("0"),
      quantity: parseDec("1.3"),
    });
    expect(r.fills).toHaveLength(2);
    expect(formatDec(r.remaining)).toBe("0");
  });

  it("cancels a resting order and removes it from the book", () => {
    const book = new OrderBook("BTCUSDT");
    buy(book, 1, 100, "30000", "1");
    const canceled = book.cancel(1);
    expect(canceled).not.toBeNull();
    expect(book.depth(5).bids).toHaveLength(0);
  });

  it("leaves the maker partially filled when taker quantity < maker quantity", () => {
    const book = new OrderBook("BTCUSDT");
    sell(book, 1, 100, "30000", "2");
    const r = buy(book, 2, 200, "30000", "0.4");
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0].quantity).toBe(parseDec("0.4"));
    const d = book.depth(5);
    expect(d.asks[0][0]).toBe(parseDec("30000").toString());
    expect(d.asks[0][1]).toBe(parseDec("1.6").toString());
  });
});
