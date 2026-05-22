/**
 * Referral System Service
 * - Generate unique 6-char referral codes
 * - Bind referrer (invitation code) to user
 * - Query downline (direct + multi-level)
 * - Query referral stats
 */
import { eq, and, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { users, referralRewards } from "../drizzle/schema";
import crypto from "crypto";

// ─── Referral Code Generation ──────────────────────────────────────────────

const REFERRAL_CODE_LENGTH = 6;
const REFERRAL_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Excluded I,O,0,1 to avoid confusion

/**
 * Generate a random referral code (6 chars, uppercase alphanumeric).
 * Retries if collision detected.
 */
export function generateReferralCode(): string {
  let code = "";
  const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += REFERRAL_CODE_CHARS[bytes[i] % REFERRAL_CODE_CHARS.length];
  }
  return code;
}

/**
 * Ensure a user has a referral code. If not, generate one and save it.
 * Called during user registration or when user first accesses referral features.
 */
export async function ensureReferralCode(userId: number): Promise<string> {
  const db = await getDb();
  const [user] = await db.select({ referralCode: users.referralCode }).from(users).where(eq(users.id, userId)).limit(1);
  if (user?.referralCode) return user.referralCode;

  // Generate unique code with retry
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateReferralCode();
    try {
      await db.update(users).set({ referralCode: code }).where(and(eq(users.id, userId), isNull(users.referralCode)));
      // Verify it was set (could fail on unique constraint race)
      const [updated] = await db.select({ referralCode: users.referralCode }).from(users).where(eq(users.id, userId)).limit(1);
      if (updated?.referralCode) return updated.referralCode;
    } catch (err: any) {
      // Duplicate key - retry with new code
      if (err?.code === "ER_DUP_ENTRY") continue;
      throw err;
    }
  }
  throw new Error("Failed to generate unique referral code after 10 attempts");
}

// ─── Bind Referrer ─────────────────────────────────────────────────────────

export interface BindReferralResult {
  success: boolean;
  message: string;
}

/**
 * Bind a referrer to the current user using an invitation code.
 * Rules:
 * - User cannot already have a referrer
 * - Cannot bind self
 * - Cannot create circular reference (A→B→A)
 * - Invitation code must exist and belong to a valid user
 */
export async function bindReferrer(userId: number, invitationCode: string): Promise<BindReferralResult> {
  const db = await getDb();
  const code = invitationCode.trim().toUpperCase();

  if (!code || code.length !== REFERRAL_CODE_LENGTH) {
    return { success: false, message: "无效的邀请码格式" };
  }

  // Check if user already has a referrer
  const [currentUser] = await db.select({ referrerId: users.referrerId, referralCode: users.referralCode }).from(users).where(eq(users.id, userId)).limit(1);
  if (!currentUser) {
    return { success: false, message: "用户不存在" };
  }
  if (currentUser.referrerId) {
    return { success: false, message: "您已绑定邀请人，不可重复绑定" };
  }

  // Find the referrer by code
  const [referrer] = await db.select({ id: users.id, referralCode: users.referralCode }).from(users).where(eq(users.referralCode, code)).limit(1);
  if (!referrer) {
    return { success: false, message: "邀请码不存在" };
  }

  // Cannot bind self
  if (referrer.id === userId) {
    return { success: false, message: "不能填写自己的邀请码" };
  }

  // Check for circular reference: walk up the referrer chain from referrer
  // If we encounter userId, it means binding would create a cycle
  let checkId: number | null = referrer.id;
  const visited = new Set<number>();
  while (checkId !== null) {
    if (checkId === userId) {
      return { success: false, message: "不能绑定您的下级为邀请人（循环引用）" };
    }
    if (visited.has(checkId)) break; // safety: break infinite loop
    visited.add(checkId);
    const [parent] = await db.select({ referrerId: users.referrerId }).from(users).where(eq(users.id, checkId)).limit(1);
    checkId = parent?.referrerId ?? null;
  }

  // Bind
  await db.update(users).set({ referrerId: referrer.id }).where(eq(users.id, userId));
  return { success: true, message: "绑定成功" };
}

// ─── Query Referral Info ───────────────────────────────────────────────────

export interface ReferralInfo {
  /** Current user's referral code */
  myReferralCode: string;
  /** Who invited me (null if nobody) */
  referrer: { id: number; name: string | null; walletAddress: string | null } | null;
  /** Direct invitees (level 1) */
  directInvitees: { id: number; name: string | null; walletAddress: string | null; createdAt: Date }[];
  /** Total invitee count (all levels) */
  totalInviteeCount: number;
  /** Whether user has bound a referrer */
  hasBoundReferrer: boolean;
}

/**
 * Get the full referral info for a user.
 */
export async function getReferralInfo(userId: number): Promise<ReferralInfo> {
  const db = await getDb();

  // Ensure user has a referral code
  const myReferralCode = await ensureReferralCode(userId);

  // Get current user's referrer
  const [currentUser] = await db.select({ referrerId: users.referrerId }).from(users).where(eq(users.id, userId)).limit(1);

  let referrer: ReferralInfo["referrer"] = null;
  if (currentUser?.referrerId) {
    const [ref] = await db.select({
      id: users.id,
      name: users.name,
      walletAddress: users.primaryWalletAddress,
    }).from(users).where(eq(users.id, currentUser.referrerId)).limit(1);
    if (ref) referrer = ref;
  }

  // Get direct invitees (level 1)
  const directInvitees = await db.select({
    id: users.id,
    name: users.name,
    walletAddress: users.primaryWalletAddress,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.referrerId, userId));

  // Count all downstream users (multi-level) using recursive approach
  const totalInviteeCount = await countAllDownline(userId);

  return {
    myReferralCode,
    referrer,
    directInvitees,
    totalInviteeCount,
    hasBoundReferrer: !!currentUser?.referrerId,
  };
}

/**
 * Count all downstream users recursively (BFS).
 * For performance, limit depth to 10 levels.
 */
async function countAllDownline(userId: number, maxDepth = 10): Promise<number> {
  const db = await getDb();
  let count = 0;
  let currentLevel = [userId];

  for (let depth = 0; depth < maxDepth && currentLevel.length > 0; depth++) {
    const children = await db.select({ id: users.id }).from(users).where(
      sql`${users.referrerId} IN (${sql.join(currentLevel.map(id => sql`${id}`), sql`, `)})`
    );
    count += children.length;
    currentLevel = children.map(c => c.id);
  }

  return count;
}

/**
 * Get multi-level downline tree (for admin or detailed view).
 * Returns up to `maxDepth` levels.
 */
export async function getDownlineTree(userId: number, maxDepth = 3): Promise<any[]> {
  const db = await getDb();

  const directChildren = await db.select({
    id: users.id,
    name: users.name,
    walletAddress: users.primaryWalletAddress,
    referralCode: users.referralCode,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.referrerId, userId));

  if (maxDepth <= 1) {
    return directChildren.map(c => ({ ...c, children: [] }));
  }

  const result = [];
  for (const child of directChildren) {
    const children = await getDownlineTree(child.id, maxDepth - 1);
    result.push({ ...child, children });
  }
  return result;
}
