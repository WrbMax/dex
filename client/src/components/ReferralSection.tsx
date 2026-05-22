/**
 * ReferralSection - 个人中心中的推荐系统区块
 * 显示用户的推荐码、邀请人信息、下级列表
 * 支持补填邀请码
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Copy, Gift, Users, UserPlus, Check } from "lucide-react";

export function ReferralSection() {
  const { data: referralInfo, refetch } = trpc.exchange.referral.info.useQuery();
  const [showBind, setShowBind] = useState(false);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);

  const bindMutation = trpc.exchange.referral.bind.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        toast.success("邀请码绑定成功！");
        setShowBind(false);
        setCode("");
        refetch();
      } else {
        toast.error(result.message);
      }
    },
    onError: (err) => toast.error(err.message || "绑定失败"),
  });

  function handleCopyCode() {
    if (!referralInfo?.myReferralCode) return;
    navigator.clipboard.writeText(referralInfo.myReferralCode).then(() => {
      setCopied(true);
      toast.success("推荐码已复制");
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleBind() {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed || trimmed.length !== 6) {
      toast.error("请输入6位邀请码");
      return;
    }
    bindMutation.mutate({ invitationCode: trimmed });
  }

  if (!referralInfo) return null;

  return (
    <section className="rounded-2xl p-4 mb-4 bg-card/85 border border-border backdrop-blur">
      <div className="flex items-center gap-2 mb-3">
        <Gift className="w-5 h-5 text-primary" />
        <span className="text-base font-semibold">邀请推荐</span>
      </div>

      {/* My referral code */}
      <div className="p-3 rounded-xl bg-secondary/70 border border-border mb-3">
        <div className="text-[11px] text-muted-foreground mb-1">我的推荐码</div>
        <div className="flex items-center gap-2">
          <span className="text-lg font-mono font-bold tracking-[0.2em] text-primary">
            {referralInfo.myReferralCode}
          </span>
          <button
            className="p-1.5 rounded-lg hover:bg-primary/10 transition-colors"
            onClick={handleCopyCode}
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-500" />
            ) : (
              <Copy className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          分享此推荐码给朋友，他们注册时填写即可成为您的下级
        </div>
      </div>

      {/* Referrer info or bind */}
      <div className="p-3 rounded-xl bg-secondary/70 border border-border mb-3">
        <div className="text-[11px] text-muted-foreground mb-1">我的邀请人</div>
        {referralInfo.hasBoundReferrer && referralInfo.referrer ? (
          <div className="flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-green-500" />
            <span className="text-sm font-medium">
              {referralInfo.referrer.name || shortenAddr(referralInfo.referrer.walletAddress)}
            </span>
          </div>
        ) : showBind ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              maxLength={6}
              placeholder="输入邀请码"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              className="flex-1 h-9 px-3 rounded-lg text-sm font-mono tracking-wider placeholder:text-muted-foreground/40 outline-none bg-background border border-border focus:border-primary/50 transition-colors"
            />
            <button
              className="h-9 px-3 rounded-lg text-xs font-semibold text-primary-foreground disabled:opacity-40"
              style={{ background: "oklch(0.62 0.22 262)" }}
              disabled={bindMutation.isPending || code.trim().length !== 6}
              onClick={handleBind}
            >
              绑定
            </button>
            <button
              className="h-9 px-2 rounded-lg text-xs text-muted-foreground hover:text-foreground"
              onClick={() => { setShowBind(false); setCode(""); }}
            >
              取消
            </button>
          </div>
        ) : (
          <button
            className="text-sm text-primary hover:underline"
            onClick={() => setShowBind(true)}
          >
            + 填写邀请码
          </button>
        )}
      </div>

      {/* Invitee stats */}
      <div className="p-3 rounded-xl bg-secondary/70 border border-border">
        <div className="flex items-center gap-2 mb-1">
          <Users className="w-4 h-4 text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">我的团队</span>
        </div>
        <div className="flex items-center gap-4">
          <div>
            <div className="text-lg font-bold">{referralInfo.directInvitees.length}</div>
            <div className="text-[10px] text-muted-foreground">直推人数</div>
          </div>
          <div>
            <div className="text-lg font-bold">{referralInfo.totalInviteeCount}</div>
            <div className="text-[10px] text-muted-foreground">团队总人数</div>
          </div>
        </div>
        {referralInfo.directInvitees.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border">
            <div className="text-[10px] text-muted-foreground mb-1">直推成员</div>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {referralInfo.directInvitees.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between text-xs">
                  <span className="font-mono text-muted-foreground">
                    {inv.name || shortenAddr(inv.walletAddress)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(inv.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function shortenAddr(addr: string | null): string {
  if (!addr) return "未知";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
