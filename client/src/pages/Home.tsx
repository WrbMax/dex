import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Copy, Loader2, ShieldCheck, Sparkles, TrendingUp, WalletCards } from "lucide-react";
import { NotificationBell } from "@/components/NotificationBell";
import { MarketList } from "@/components/MarketList";
import { MyAssets } from "@/components/MyAssets";
import { cn } from "@/lib/utils";
import { shortenAddress } from "@/lib/format";
import { ConnectWallet } from "@/components/ConnectWallet";
import { Link, useLocation } from "wouter";

type Tab = "market" | "assets";

function Avatar({ seed }: { seed: string }) {
  const hue = seed
    .split("")
    .reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return (
    <div
      className="w-11 h-11 rounded-full shrink-0 flex items-center justify-center text-sm font-bold text-white shadow-sm ring-2 ring-white/10"
      style={{
        background: `linear-gradient(135deg, oklch(0.62 0.22 ${hue}), oklch(0.52 0.24 ${(hue + 40) % 360}))`,
      }}
    >
      {seed.slice(2, 4).toUpperCase()}
    </div>
  );
}

function copyText(text: string) {
  if (!text) return Promise.resolve(false);
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  return Promise.resolve(ok);
}

function WalletTopBar({ address, name }: { address: string; name?: string | null }) {
  const [copied, setCopied] = useState(false);
  const displayName = name || "Wallet User";
  const canCopy = Boolean(address && address.includes("0x"));

  const onCopy = async () => {
    if (!canCopy) return;
    const ok = await copyText(address);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <section className="flex items-center gap-2.5 pr-12">
      <button
        type="button"
        onClick={onCopy}
        className="flex-1 min-w-0 flex items-center gap-3 rounded-[22px] bg-card/85 border border-border px-3 py-2.5 shadow-sm active:scale-[0.99] transition-transform text-left"
        aria-label={canCopy ? "复制钱包地址" : "钱包地址"}
      >
        <Avatar seed={address || displayName || "anon"} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">当前钱包</span>
            <ShieldCheck className="w-3.5 h-3.5 text-primary" />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
            <span className="text-base font-semibold font-mono truncate">
              {address ? shortenAddress(address) : displayName}
            </span>
            {canCopy && (copied ? <Check className="w-3.5 h-3.5 text-up shrink-0" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground shrink-0" />)}
          </div>
        </div>
      </button>
      <NotificationBell />
    </section>
  );
}

const bannerSlides = [
  {
    tag: "WallDex Market",
    title: "一站式现货交易",
    desc: "查看实时行情、盘口深度与个人资产，在钱包内快速完成交易操作。",
    href: "/market",
    cta: "进入市场",
    icon: TrendingUp,
    accent: "oklch(0.62 0.22 262 / 0.26)",
  },
  {
    tag: "Wallet Ready",
    title: "充值提现支持任意地址",
    desc: "按页面输入代币与地址即可发起操作，不再限制为当前绑定钱包。",
    href: "/deposit",
    cta: "去充值",
    icon: WalletCards,
    accent: "oklch(0.76 0.18 152 / 0.24)",
  },
  {
    tag: "Smart Trading",
    title: "行情与下单入口更清晰",
    desc: "交易对详情页支持直接切换市场，买入与卖出按钮固定在底部。",
    href: "/market",
    cta: "选择交易对",
    icon: Sparkles,
    accent: "oklch(0.66 0.22 20 / 0.22)",
  },
];

function MarketBanner() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActive((v) => (v + 1) % bannerSlides.length);
    }, 4200);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="mt-5 overflow-hidden rounded-[28px] relative border border-border bg-card/85 shadow-sm">
      <div
        className="flex transition-transform duration-500 ease-out"
        style={{ transform: `translateX(-${active * 100}%)` }}
      >
        {bannerSlides.map((slide) => {
          const Icon = slide.icon;
          return (
            <div key={slide.title} className="relative min-w-full p-5 min-h-[148px] flex flex-col justify-between gap-5 overflow-hidden">
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute -top-12 -right-10 w-44 h-44 rounded-full blur-3xl" style={{ background: slide.accent }} />
                <div className="absolute -bottom-16 -left-8 w-44 h-44 rounded-full bg-primary/10 blur-3xl" />
              </div>
              <div className="relative flex items-start justify-between gap-4">
                <div>
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-[11px] font-semibold border border-primary/20">
                    <Sparkles className="w-3.5 h-3.5" /> {slide.tag}
                  </div>
                  <h2 className="mt-3 text-xl font-bold tracking-tight">{slide.title}</h2>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground max-w-[285px]">{slide.desc}</p>
                </div>
                <div className="w-14 h-14 rounded-2xl bg-background/55 border border-border flex items-center justify-center shrink-0">
                  <Icon className="w-7 h-7 text-primary" />
                </div>
              </div>
              <Link href={slide.href}>
                <div className="relative inline-flex items-center gap-1.5 text-sm font-semibold text-primary active:opacity-70">
                  {slide.cta} <ArrowRight className="w-4 h-4" />
                </div>
              </Link>
            </div>
          );
        })}
      </div>
      <div className="absolute right-5 bottom-5 flex gap-1.5">
        {bannerSlides.map((slide, idx) => (
          <button
            key={slide.title}
            type="button"
            aria-label={`切换到第 ${idx + 1} 张 Banner`}
            onClick={() => setActive(idx)}
            className={cn("h-1.5 rounded-full transition-all", idx === active ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30")}
          />
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  const { user, loading, isAuthenticated } = useAuth();
  const { data: profile } = trpc.exchange.profile.useQuery(undefined, {
    enabled: isAuthenticated,
  });
  const [location] = useLocation();
  const initialTab = location.includes("tab=assets") ? "assets" : "market";
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (location.includes("tab=assets")) setTab("assets");
  }, [location]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{
              background:
                "linear-gradient(135deg, oklch(0.62 0.22 262), oklch(0.52 0.24 280))",
            }}
          >
            <TrendingUp className="w-6 h-6 text-white" />
          </div>
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <ConnectWallet />;
  }

  const address = profile?.primaryWalletAddress ?? "";

  return (
    <div className="w-full px-4 pb-6 safe-top pt-4">
      <WalletTopBar address={address} name={user?.name ?? user?.email} />
      <MarketBanner />

      <div className="mt-5 flex gap-1 p-1 rounded-xl bg-secondary/70 border border-border">
        {(["market", "assets"] as Tab[]).map((t) => (
          <button
            key={t}
            className={cn(
              "flex-1 h-8 rounded-lg text-xs font-medium transition-all",
              tab === t
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setTab(t)}
          >
            {t === "market" ? "行情" : "资产"}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "market" ? <MarketList /> : <MyAssets />}
      </div>
    </div>
  );
}
