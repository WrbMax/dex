/**
 * tRPC Router for Referral System
 * Endpoints:
 * - exchange.referral.info: Get user's referral info (code, referrer, invitees)
 * - exchange.referral.bind: Bind an invitation code
 * - exchange.referral.downline: Get multi-level downline tree
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { bindReferrer, getReferralInfo, getDownlineTree, ensureReferralCode } from "../referral";

export const referralRouter = router({
  /** Get current user's referral information */
  info: protectedProcedure.query(async ({ ctx }) => {
    return getReferralInfo(ctx.user.id);
  }),

  /** Bind an invitation code (set referrer) */
  bind: protectedProcedure
    .input(z.object({ invitationCode: z.string().min(1).max(8) }))
    .mutation(async ({ ctx, input }) => {
      return bindReferrer(ctx.user.id, input.invitationCode);
    }),

  /** Get multi-level downline tree */
  downline: protectedProcedure
    .input(z.object({ maxDepth: z.number().min(1).max(10).default(3) }).optional())
    .query(async ({ ctx, input }) => {
      return getDownlineTree(ctx.user.id, input?.maxDepth ?? 3);
    }),

  /** Get just the referral code (lightweight) */
  myCode: protectedProcedure.query(async ({ ctx }) => {
    const code = await ensureReferralCode(ctx.user.id);
    return { referralCode: code };
  }),
});
