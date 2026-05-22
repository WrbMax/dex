import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { COOKIE_NAME } from "@shared/const";
import { jwtVerify } from "jose";
import { ENV } from "./env";
import * as db from "../db";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

function parseCookies(cookieHeader: string | undefined): Map<string, string> {
  if (!cookieHeader) return new Map();
  const map = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    map.set(key, val);
  }
  return map;
}

async function verifySession(token: string | undefined): Promise<{ openId: string } | null> {
  if (!token) return null;
  try {
    const secret = new TextEncoder().encode(ENV.cookieSecret);
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    const openId = payload["openId"];
    if (typeof openId !== "string" || !openId) return null;
    return { openId };
  } catch {
    return null;
  }
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;
  try {
    const cookies = parseCookies(opts.req.headers.cookie);
    const token = cookies.get(COOKIE_NAME);
    const session = await verifySession(token);
    if (session?.openId) {
      const found = await db.getUserByOpenId(session.openId);
      // Removed: Legacy OAuth sync fallback — only Rabbit Bridge auth is supported.
      if (found && !found.isBanned) {
        user = found;
      }
    }
  } catch (err) {
    console.warn("[Auth] Context error", String(err));
  }
  return { req: opts.req, res: opts.res, user };
}
