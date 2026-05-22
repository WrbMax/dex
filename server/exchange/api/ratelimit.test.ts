import { describe, it, expect, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { rateLimit, _resetRateLimit } from "./ratelimit";

function fakeReq(apiKey = "k-1", ip = "1.1.1.1"): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === "x-mbx-apikey" ? apiKey : undefined,
    ip,
    socket: { remoteAddress: ip } as any,
  } as unknown as Request;
}
function fakeRes() {
  const state = { status: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    status(c: number) {
      state.status = c;
      return res;
    },
    json(b: unknown) {
      state.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      state.headers[k] = v;
    },
  } as unknown as Response;
  return { res, state };
}
const noop: NextFunction = () => {};

describe("rate limit", () => {
  beforeEach(() => _resetRateLimit());

  it("allows requests under the limit and blocks when exhausted", () => {
    // Capacity = perMinute(600) + burst(120) = 720 by default ENV.
    const mw = rateLimit("private");
    let passed = 0;
    let blocked = 0;
    for (let i = 0; i < 2000; i++) {
      const { res, state } = fakeRes();
      mw(fakeReq("KEY_A"), res, noop);
      if (state.status === 429) blocked++;
      else passed++;
    }
    expect(passed).toBeGreaterThan(0);
    expect(blocked).toBeGreaterThan(0);
    // Burst capacity is finite, so we must see at least `blocked > 500` of the 2000.
    expect(blocked).toBeGreaterThan(500);
  });

  it("isolates buckets by API key", () => {
    const mw = rateLimit("private");
    // Saturate KEY_A
    for (let i = 0; i < 2000; i++) {
      const { res } = fakeRes();
      mw(fakeReq("KEY_A"), res, noop);
    }
    // KEY_B should still succeed
    const { res, state } = fakeRes();
    mw(fakeReq("KEY_B"), res, noop);
    expect(state.status).toBe(200);
  });

  it("refills over time", async () => {
    const mw = rateLimit("private");
    for (let i = 0; i < 2000; i++) {
      const { res } = fakeRes();
      mw(fakeReq("KEY_C"), res, noop);
    }
    // Wait 200ms → should allow ~2 tokens back (600/min ≈ 10/sec).
    await new Promise((r) => setTimeout(r, 250));
    const { res, state } = fakeRes();
    mw(fakeReq("KEY_C"), res, noop);
    expect(state.status).toBe(200);
  });
});
