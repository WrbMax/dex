import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  ChevronLeft,
  ChevronRight,
  History,
  Key,
  ListOrdered,
  LogOut,
  ShieldCheck,
  Settings,
  User,
  WalletCards,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState, type ReactNode } from "react";
import { shortenAddress, splitSymbol } from "@/lib/format";
import { Link } from "wouter";
import { ReferralSection } from "@/components/ReferralSection";

export default function Me() {
  const { user, isAuthenticated, logout } = useAuth();
  const { data: profile, refetch } = trpc.exchange.profile.useQuery(undefined, {
    enabled: isAuthenticated,
  });
  const { data: balances } = trpc.exchange.balances.useQuery(undefined, {
    enabled: isAuthenticated,
    refetchInterval: 10000,
  });
  const { data: markets } = trpc.exchange.listMarkets.useQuery(undefined, {
    enabled: isAuthenticated,
    refetchInterval: 30000,
  });
  const bind = trpc.exchange.bindWallet.useMutation({
    onSuccess: () => { toast.success("钱包绑定成功"); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const [addr, setAddr] = useState("");
  const isValidAddr = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());

  if (!isAuthenticated) {
    return (
      <div className="w-full px-4 pt-24 flex flex-col items-center gap-4">
        <div className="w-16 h-16 rounded-full flex items-center justify-center bg-primary/15 border border-primary/30">
          <User className="w-8 h-8 text-primary" />
        </div>
        <div className="text-muted-foreground text-sm">请登录以继续</div>
        <button
          className="px-8 py-3 rounded-2xl font-semibold text-white text-sm"
          style={{ background: "oklch(0.62 0.22 262)" }}
          onClick={() => (window.location.href = "/")}
        >
          登录
        </button>
      </div>
    );
  }

  const bound = !!profile?.primaryWalletAddress;
  const displayName = user?.name ?? user?.email ?? "用户";
  const initials = displayName.slice(0, 2).toUpperCase();
  const totalUsdt = (() => {
    if (!balances || !markets) return null;
    const priceOf = new Map<string, number>();
    for (const row of markets) {
      const { base, quote } = splitSymbol(row.symbol);
      if (quote === "USDT") priceOf.set(base, Number(row.lastPrice));
    }
    priceOf.set("USDT", 1);
    return balances.reduce((sum, b) => {
      const price = priceOf.get(b.asset) ?? 0;
      return sum + price * (Number(b.available) + Number(b.locked));
    }, 0);
  })();

  return (
    <div className="w-full px-4 pt-4 pb-10">
      {/* Header */}
      <header className="flex items-center gap-2 mb-5">
        <Link href="/">
          <button className="p-1.5 -ml-1.5 rounded-xl text-muted-foreground hover:text-foreground transition-colors bg-secondary/70 border border-border">
            <ChevronLeft className="w-5 h-5" />
          </button>
        </Link>
        <h1 className="text-lg font-semibold">我的</h1>
      </header>

      {/* Profile card */}
      <div className="rounded-2xl p-5 mb-4 bg-card/85 border border-border backdrop-blur">
        <div className="flex items-center gap-4">
          {/* Avatar */}
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-lg font-bold text-primary shrink-0 bg-primary/15 border border-primary/30">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-base truncate">{displayName}</div>
            {user?.role === "admin" && (
              <span className="inline-block mt-1 text-[10px] px-2 py-0.5 rounded-full font-medium text-primary bg-primary/15">
                管理员
              </span>
            )}
            {totalUsdt !== null && (
              <div className="mt-1.5">
                <div className="text-[10px] text-muted-foreground">总资产估值</div>
                <div className="text-sm font-semibold text-foreground">
                  ${totalUsdt.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  <span className="text-[10px] text-muted-foreground ml-1.5">≈ ¥{(totalUsdt * 7.2).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Wallet binding */}
        <div className="mt-4 p-3 rounded-xl bg-secondary/70 border border-border">
          {bound ? (
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Nexus Wallet 地址</div>
                <div className="font-mono text-sm text-foreground/90 break-all">
                  {shortenAddress(profile!.primaryWalletAddress!)}
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  钱包注册后自动同步；充值与提现可填写任意地址和代币
                </div>
              </div>
            </div>
          ) : (
            <div>
              <div className="text-xs text-muted-foreground mb-2">账户识别地址</div>
              <div className="flex gap-2">
                <input
                  value={addr}
                  onChange={(e) => setAddr(e.target.value)}
                  placeholder="0x... 以太坊/BEP20 地址"
                  className="flex-1 h-10 px-3 rounded-xl text-xs font-mono text-foreground placeholder:text-muted-foreground/40 outline-none bg-background border border-border"
                  style={{ borderColor: addr && !isValidAddr ? "oklch(0.66 0.22 20 / 0.5)" : undefined }}
                />
                <button
                  className="h-10 px-4 rounded-xl text-sm font-semibold text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                  style={{ background: "oklch(0.62 0.22 262)" }}
                  disabled={bind.isPending || !isValidAddr}
                  onClick={() => bind.mutate({ address: addr.trim(), chain: "erc20" })}
                >
                  绑定
                </button>
              </div>
              {addr && !isValidAddr && (
                <div className="mt-1.5 text-[11px] text-down">
                  请输入有效的 0x 开头 42 位地址
                </div>
              )}
              <div className="mt-1.5 text-[10px] text-muted-foreground">
                该地址仅用于账户识别，充值与提现可填写任意地址和代币
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Wallet operation card */}
      <section className="rounded-2xl p-4 mb-4 bg-card/85 border border-border backdrop-blur">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-base font-semibold">钱包与交易所资金</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              充值、提现支持自定义地址和代币；划转入口预留给 Nexus Wallet 调用。
            </p>
          </div>
          <span className="px-2 py-1 rounded-full text-[10px] font-semibold text-primary bg-primary/10 border border-primary/20 shrink-0">
            H5 嵌入
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <WalletAction href="/deposit" label="充值" hint="任意代币" color="oklch(0.76 0.18 152)" icon={<ArrowDownToLine className="w-5 h-5" />} />
          <WalletAction href="/withdraw" label="提现" hint="任意地址" color="oklch(0.66 0.22 20)" icon={<ArrowUpFromLine className="w-5 h-5" />} />
          <WalletAction href="/transfer?source=nexus-wallet" label="划转" hint="调用钱包" color="oklch(0.62 0.22 262)" icon={<ArrowRightLeft className="w-5 h-5" />} />
        </div>
      </section>

      {/* Referral section */}
      <ReferralSection />
      {/* Menu items */}
      <div className="rounded-2xl overflow-hidden divide-y divide-border mb-4 bg-card/85 border border-border backdrop-blur">
        <MeItem href="/?tab=assets" icon={<WalletCards className="w-5 h-5 text-yellow-400" />} title="我的资产" />
        <MeItem href="/orders" icon={<ListOrdered className="w-5 h-5 text-primary" />} title="我的订单" />
        <MeItem href="/trades" icon={<History className="w-5 h-5 text-green-400" />} title="成交历史" />
        <MeItem href="/me/api-keys" icon={<Key className="w-5 h-5 text-primary" />} title="API 管理" />
        <MeItem href="/docs/api" icon={<Key className="w-5 h-5 text-muted-foreground" />} title="开发者 API 文档" />
        {user?.role === "admin" && (
          <MeItem href="/admin" icon={<Settings className="w-5 h-5 text-purple-400" />} title="后台管理系统" />
        )}
      </div>

      {/* Logout */}
      <button
        className="w-full h-12 rounded-2xl font-semibold text-sm text-down flex items-center justify-center gap-2 transition-opacity active:opacity-70"
        style={{ background: "oklch(0.66 0.22 20 / 0.08)", border: "1px solid oklch(0.66 0.22 20 / 0.2)" }}
        onClick={() => logout()}
      >
        <LogOut className="w-4 h-4" /> 退出登录
      </button>
    </div>
  );
}

function WalletAction({ href, icon, label, hint, color }: { href: string; icon: ReactNode; label: string; hint: string; color: string }) {
  return (
    <Link href={href}>
      <div className="rounded-2xl p-3 min-h-[96px] flex flex-col items-center justify-center gap-2 bg-secondary/60 border border-border active:opacity-70 transition-opacity">
        <div className="w-11 h-11 rounded-2xl flex items-center justify-center" style={{ background: `${color}1a`, border: `1px solid ${color}33`, color }}>
          {icon}
        </div>
        <div className="text-center">
          <div className="text-sm font-semibold">{label}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>
        </div>
      </div>
    </Link>
  );
}

function MeItem({ href, icon, title }: { href: string; icon: ReactNode; title: string }) {
  return (
    <Link href={href}>
      <div className="px-4 py-4 flex items-center justify-between active:opacity-70 transition-opacity">
        <div className="flex items-center gap-3">
          {icon}
          <span className="text-sm">{title}</span>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
      </div>
    </Link>
  );
}
