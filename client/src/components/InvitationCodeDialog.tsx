/**
 * InvitationCodeDialog - 首次登录邀请码弹窗
 * 用户首次进入交易所时弹出，提示输入邀请码（非必填，可跳过）
 * 绑定成功后关闭弹窗，跳过后记录到 localStorage 不再弹出
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Gift } from "lucide-react";

interface InvitationCodeDialogProps {
  open: boolean;
  onClose: () => void;
}

export function InvitationCodeDialog({ open, onClose }: InvitationCodeDialogProps) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  const bindMutation = trpc.exchange.referral.bind.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        toast.success("邀请码绑定成功！");
        markDismissed();
        onClose();
      } else {
        toast.error(result.message);
      }
      setLoading(false);
    },
    onError: (err) => {
      toast.error(err.message || "绑定失败");
      setLoading(false);
    },
  });

  function handleBind() {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed || trimmed.length !== 6) {
      toast.error("请输入6位邀请码");
      return;
    }
    setLoading(true);
    bindMutation.mutate({ invitationCode: trimmed });
  }

  function handleSkip() {
    markDismissed();
    onClose();
  }

  function markDismissed() {
    localStorage.setItem("referral_dialog_dismissed", "1");
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleSkip(); }}>
      <DialogContent className="max-w-[360px] rounded-2xl bg-card border border-border p-6">
        <DialogHeader className="items-center text-center">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-primary/15 border border-primary/30 mb-3">
            <Gift className="w-7 h-7 text-primary" />
          </div>
          <DialogTitle className="text-lg font-semibold">欢迎加入</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground mt-2">
            如果您有朋友的邀请码，请在下方输入。<br />
            也可以跳过，稍后在个人中心绑定。
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4">
          <input
            type="text"
            maxLength={6}
            placeholder="请输入6位邀请码"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            className="w-full h-12 px-4 rounded-xl text-center text-lg font-mono tracking-[0.3em] placeholder:text-muted-foreground/40 outline-none bg-background border border-border focus:border-primary/50 transition-colors"
          />
        </div>

        <DialogFooter className="mt-5 flex flex-col gap-2.5 sm:flex-col">
          <button
            className="w-full h-11 rounded-xl font-semibold text-sm text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            style={{ background: "oklch(0.62 0.22 262)" }}
            disabled={loading || !code.trim()}
            onClick={handleBind}
          >
            {loading ? "绑定中..." : "确认绑定"}
          </button>
          <button
            className="w-full h-11 rounded-xl font-medium text-sm text-muted-foreground hover:text-foreground transition-colors bg-secondary/60 border border-border"
            onClick={handleSkip}
          >
            跳过，稍后绑定
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
