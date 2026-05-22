import { describe, it, expect } from "vitest";
import { mergeDepth } from "./depth_mirror";

describe("depth_mirror · mergeDepth", () => {
  it("returns mirror untouched when internal is empty", () => {
    const mirror = {
      bids: [
        ["100", "1"],
        ["99", "2"],
      ] as [string, string][],
      asks: [
        ["101", "1"],
        ["102", "2"],
      ] as [string, string][],
    };
    const internal = { bids: [] as [string, string][], asks: [] as [string, string][] };
    const merged = mergeDepth(mirror, internal, 10);
    expect(merged.bids[0]?.[0]).toBe("100");
    expect(merged.asks[0]?.[0]).toBe("101");
    expect(merged.bids).toHaveLength(2);
    expect(merged.asks).toHaveLength(2);
  });

  it("adds internal quantity to mirror at matching price levels", () => {
    const mirror = {
      bids: [["100", "1"]] as [string, string][],
      asks: [["101", "1"]] as [string, string][],
    };
    const internal = {
      bids: [["100", "2"]] as [string, string][],
      asks: [["101", "3"]] as [string, string][],
    };
    const merged = mergeDepth(mirror, internal, 10);
    expect(merged.bids[0]).toEqual(["100", "3"]);
    expect(merged.asks[0]).toEqual(["101", "4"]);
  });

  it("keeps bids descending and asks ascending, caps at limit", () => {
    const mirror = {
      bids: [
        ["100", "1"],
        ["99", "1"],
        ["98", "1"],
        ["97", "1"],
      ] as [string, string][],
      asks: [
        ["101", "1"],
        ["102", "1"],
        ["103", "1"],
      ] as [string, string][],
    };
    const internal = {
      bids: [["96", "5"]] as [string, string][],
      asks: [["104", "5"]] as [string, string][],
    };
    const merged = mergeDepth(mirror, internal, 3);
    expect(merged.bids.map(([p]) => p)).toEqual(["100", "99", "98"]);
    expect(merged.asks.map(([p]) => p)).toEqual(["101", "102", "103"]);
  });
});
