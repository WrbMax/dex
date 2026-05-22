/**
 * useReferralDialog - Hook to control when to show the invitation code dialog
 * Shows the dialog when:
 * 1. User is authenticated
 * 2. User has NOT bound a referrer yet
 * 3. User has NOT dismissed the dialog before (localStorage)
 */
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";

const STORAGE_KEY = "referral_dialog_dismissed";

export function useReferralDialog() {
  const { isAuthenticated } = useAuth();
  const [showDialog, setShowDialog] = useState(false);

  const { data: referralInfo, isLoading } = trpc.exchange.referral.info.useQuery(undefined, {
    enabled: isAuthenticated,
    retry: false,
  });

  useEffect(() => {
    if (!isAuthenticated || isLoading) return;
    if (!referralInfo) return;

    // Already has a referrer - no need to show
    if (referralInfo.hasBoundReferrer) return;

    // Already dismissed before
    if (localStorage.getItem(STORAGE_KEY) === "1") return;

    // Show the dialog
    setShowDialog(true);
  }, [isAuthenticated, isLoading, referralInfo]);

  function closeDialog() {
    setShowDialog(false);
  }

  return { showDialog, closeDialog };
}
