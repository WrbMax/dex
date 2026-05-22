/**
 * Price–time priority in-memory order book.
 *
 * Design notes (scale and TPS):
 *  - Prices and quantities use scaled BigInt (scale=18). No floats.
 *  - Each price level is a FIFO of resting orders; we keep buy prices in a
 *    descending sorted array and sell prices ascending. For 30 pairs and
 *    typical book depth, a simple sorted array with binary-search insert is
 *    faster than a red-black tree in JS because of cache locality.
 *  - Single-threaded per market; matching happens synchronously when an order
 *    enters the book. The caller (MatchingEngine) serializes order submission
 *    via a queue so there is no in-engine concurrency.
 */

import { ZERO } from "../utils/bigdec";

export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";

export type ResidentOrder = {
  id: number;
  userId: number;
  subAccountId: number;
  side: Side;
  /** Remaining quantity in base asset (scaled). */
  remaining: bigint;
  /** Price for limit orders (scaled); 0 for market. */
  price: bigint;
  type: OrderType;
  /** Monotonic sequence assigned on entry to preserve FIFO order per price. */
  seq: number;
  timestamp: number;
};

export type Fill = {
  makerOrderId: number;
  takerOrderId: number;
  makerUserId: number;
  takerUserId: number;
  makerSubAccountId: number;
  takerSubAccountId: number;
  side: Side; // side of taker
  price: bigint;
  quantity: bigint;
};

function bsearchDesc(arr: bigint[], price: bigint) {
  // Return insertion index keeping arr sorted in DESCENDING order.
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] > price) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function bsearchAsc(arr: bigint[], price: bigint) {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < price) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class OrderBook {
  readonly symbol: string;
  private seq = 1;

  // Buy side: sorted DESC (highest bid first).
  private bidPrices: bigint[] = [];
  private bids = new Map<bigint, ResidentOrder[]>();

  // Sell side: sorted ASC (lowest ask first).
  private askPrices: bigint[] = [];
  private asks = new Map<bigint, ResidentOrder[]>();

  private orderIndex = new Map<number, ResidentOrder>();

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  bestBid(): bigint | null {
    return this.bidPrices.length > 0 ? this.bidPrices[0] : null;
  }
  bestAsk(): bigint | null {
    return this.askPrices.length > 0 ? this.askPrices[0] : null;
  }

  depth(depth = 20) {
    const bids: [string, string][] = [];
    const asks: [string, string][] = [];
    for (let i = 0; i < Math.min(depth, this.bidPrices.length); i++) {
      const p = this.bidPrices[i];
      const total = (this.bids.get(p) ?? []).reduce((a, o) => a + o.remaining, ZERO);
      bids.push([p.toString(), total.toString()]);
    }
    for (let i = 0; i < Math.min(depth, this.askPrices.length); i++) {
      const p = this.askPrices[i];
      const total = (this.asks.get(p) ?? []).reduce((a, o) => a + o.remaining, ZERO);
      asks.push([p.toString(), total.toString()]);
    }
    return { bids, asks };
  }

  getOrder(id: number) {
    return this.orderIndex.get(id);
  }

  cancel(id: number): ResidentOrder | null {
    const o = this.orderIndex.get(id);
    if (!o) return null;
    const priceMap = o.side === "buy" ? this.bids : this.asks;
    const priceArr = o.side === "buy" ? this.bidPrices : this.askPrices;
    const q = priceMap.get(o.price);
    if (q) {
      const idx = q.findIndex((x) => x.id === id);
      if (idx >= 0) q.splice(idx, 1);
      if (q.length === 0) {
        priceMap.delete(o.price);
        const pi = priceArr.indexOf(o.price);
        if (pi >= 0) priceArr.splice(pi, 1);
      }
    }
    this.orderIndex.delete(id);
    return o;
  }

  /**
   * Submit a new order, matching it against the opposite side. The returned
   * `fills` is empty for orders that rest without crossing; `remaining` tells
   * the caller how much did not fill (important for market orders).
   */
  submit(input: {
    id: number;
    userId: number;
    subAccountId: number;
    side: Side;
    type: OrderType;
    price: bigint; // 0 for market
    quantity: bigint;
  }): { fills: Fill[]; remaining: bigint; rested: boolean } {
    const fills: Fill[] = [];
    let remaining = input.quantity;

    const matchAgainst = input.side === "buy" ? this.asks : this.bids;
    const matchPrices = input.side === "buy" ? this.askPrices : this.bidPrices;

    while (remaining > ZERO && matchPrices.length > 0) {
      const top = matchPrices[0];
      if (input.type === "limit") {
        if (input.side === "buy" && top > input.price) break;
        if (input.side === "sell" && top < input.price) break;
      }
      const queue = matchAgainst.get(top)!;
      let qi = 0;
      const fillsBefore = fills.length;
      while (qi < queue.length && remaining > ZERO) {
        const head = queue[qi];
        // FIX B006: Skip self-trade — do not match orders from the same user.
        // Wash trading would double-charge fees and produce fake volume.
        if (head.userId === input.userId) {
          qi++;
          continue;
        }
        const tradedQty = head.remaining < remaining ? head.remaining : remaining;
        fills.push({
          makerOrderId: head.id,
          takerOrderId: input.id,
          makerUserId: head.userId,
          takerUserId: input.userId,
          makerSubAccountId: head.subAccountId,
          takerSubAccountId: input.subAccountId,
          side: input.side,
          price: top,
          quantity: tradedQty,
        });
        head.remaining -= tradedQty;
        remaining -= tradedQty;
        if (head.remaining === ZERO) {
          queue.splice(qi, 1);
          this.orderIndex.delete(head.id);
          // do NOT increment qi; the next element shifted into position qi
        } else {
          qi++;
        }
      }
      // FIX H005: If no fills were produced at this price level (all orders
      // were skipped due to self-trade protection), break out of the outer
      // loop to prevent an infinite spin. Without this guard the outer while
      // would keep re-entering the same non-empty queue forever.
      if (fills.length === fillsBefore) break;
      if (queue.length === 0) {
        matchAgainst.delete(top);
        matchPrices.shift();
      }
    }

    let rested = false;
    if (remaining > ZERO && input.type === "limit") {
      const seq = this.seq++;
      const resting: ResidentOrder = {
        id: input.id,
        userId: input.userId,
        subAccountId: input.subAccountId,
        side: input.side,
        remaining,
        price: input.price,
        type: "limit",
        seq,
        timestamp: Date.now(),
      };
      const priceMap = input.side === "buy" ? this.bids : this.asks;
      const priceArr = input.side === "buy" ? this.bidPrices : this.askPrices;
      let q = priceMap.get(input.price);
      if (!q) {
        q = [];
        priceMap.set(input.price, q);
        const idx =
          input.side === "buy"
            ? bsearchDesc(priceArr, input.price)
            : bsearchAsc(priceArr, input.price);
        priceArr.splice(idx, 0, input.price);
      }
      q.push(resting);
      this.orderIndex.set(input.id, resting);
      rested = true;
    }

    return { fills, remaining, rested };
  }

  /** Warm-start from DB on boot: re-insert resting orders without matching. */
  load(orders: Array<Omit<ResidentOrder, "seq" | "timestamp"> & { timestamp?: number }>) {
    for (const o of orders) {
      const priceMap = o.side === "buy" ? this.bids : this.asks;
      const priceArr = o.side === "buy" ? this.bidPrices : this.askPrices;
      let q = priceMap.get(o.price);
      if (!q) {
        q = [];
        priceMap.set(o.price, q);
        const idx =
          o.side === "buy"
            ? bsearchDesc(priceArr, o.price)
            : bsearchAsc(priceArr, o.price);
        priceArr.splice(idx, 0, o.price);
      }
      const seq = this.seq++;
      const resting: ResidentOrder = {
        ...o,
        seq,
        timestamp: o.timestamp ?? Date.now(),
      };
      q.push(resting);
      this.orderIndex.set(o.id, resting);
    }
  }
}

