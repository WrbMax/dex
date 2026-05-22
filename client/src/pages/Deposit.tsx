import { AssetIcon } from "@/components/AssetIcon";
import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  Copy,
  Info,
  QrCode,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { fmtAmount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  CHAIN_META,
  ON_CHAIN_ASSETS,
  getSupportedChainsForAsset,
  type Chain,
} from "@shared/wallet";
import { WalletTransfer } from "@/components/WalletTransfer";

const FEATURED_ASSETS = ["USDT", "BTC", "ETH", "BNB", "SOL", "TRX", "MATIC", "ARB"];
const ALL_ASSET_OPTIONS = Array.from(new Set([...FEATURED_ASSETS, ...ON_CHAIN_ASSETS]));

const normalizeAsset = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);

export default function Deposit() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [chain, setChain] = useState<Chain>("trc20");
  const [asset, setAsset] = useState("USDT");
  const [assetSearch, setAssetSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [simAmount, setSimAmount] = useState("100");

  const { data: addrs } = trpc.exchange.depositAddresses.useQuery();
  const { data: history, refetch } = trpc.exchange.depositHistory.useQuery(undefined, {
    refetchInterval: 4000,
    placeholderData: (prev) => prev,
  });
  const sim = trpc.exchange.simulateDeposit.useMutation({
    onSuccess: () => { toast.success("入账核验已完成"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const selectedAsset = normalizeAsset(asset) || "USDT";
  const displayAsset = selectedAsset || "代币";
  const supportedChains = useMemo(() => getSupportedChainsForAsset(selectedAsset), [selectedAsset]);
  const currentNetwork = CHAIN_META[chain];
  const addr = addrs?.find((a) => a.chain === chain);
  const filteredAssets = useMemo(() => {
    const keyword = normalizeAsset(assetSearch);
    if (!keyword) return ALL_ASSET_OPTIONS;
    return ALL_ASSET_OPTIONS.filter((symbol) => symbol.includes(keyword));
  }, [assetSearch]);

  useEffect(() => {
    if (!supportedChains.includes(chain)) {
      setChain(supportedChains[0]);
    }
  }, [chain, supportedChains]);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl("");
    if (!addr?.address) return;
    QRCode.toDataURL(addr.address, { width: 220, margin: 1, errorCorrectionLevel: "M" })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl("");
      });
    return () => { cancelled = true; };
  }, [addr?.address]);

  const selectAsset = (symbol: string) => {
    const normalized = normalizeAsset(symbol);
    setAsset(normalized);
    setAssetSearch("");
    const nextChains = getSupportedChainsForAsset(normalized);
    setChain(nextChains[0]);
  };

  const handleCopy = () => {
    if (!addr?.address) return;
    navigator.clipboard.writeText(addr.address);
    setCopied(true);
    toast.success("充值地址已复制");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full px-4 pt-3 pb-10 safe-top">
      <header className="flex items-center gap-3 mb-4">
        <Link href="/">
          <button className="tap-target p-1.5 -ml-1.5 rounded-xl ui-secondary-button transition-colors">
            <ChevronLeft className="w-5 h-5" />
          </button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">充值 Crypto</h1>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold text-up bg-up/10 border border-up/20">链上入金</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">先选币种，再选该币种支持的网络，避免错链资产损失。</p>
        </div>
      </header>

      <section className="rounded-[24px] p-4 mb-4 bg-card/90 border border-border/80 shadow-sm overflow-hidden relative">
        <div className="absolute -right-10 -top-10 w-28 h-28 rounded-full bg-primary/10 blur-2xl" />
        <div className="relative flex items-start justify-between gap-4">
          <div>
            <div className="text-xs text-muted-foreground">当前充值资产</div>
            <div className="mt-2 flex items-center gap-3">
              <AssetIcon asset={selectedAsset} size={42} />
              <div>
                <div className="text-2xl font-semibold tracking-tight">{displayAsset}</div>
                <div className="text-xs text-muted-foreground">{currentNetwork.shortName} 网络充值地址</div>
              </div>
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground leading-5">
            <div className="font-medium text-foreground">预计到账</div>
            <div>{currentNetwork.arrival}</div>
          </div>
        </div>
      </section>

      <section className="rounded-[22px] p-4 mb-4 bg-card/90 border border-border/80 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold">1. 选择充值币种</h2>
            <p className="text-xs text-muted-foreground mt-0.5">支持交易区主流资产，搜索后可直接切换。</p>
          </div>
          <span className="text-[10px] px-2 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">Coin</span>
        </div>
        <div className="flex items-center gap-3 px-3 py-3 rounded-2xl ui-field">
          <Search className="w-4 h-4 text-muted-foreground" />
          <input
            value={assetSearch}
            onChange={(e) => setAssetSearch(e.target.value)}
            placeholder="搜索 BTC / USDT / SOL"
            className="flex-1 bg-transparent text-sm font-medium text-foreground placeholder:text-muted-foreground/60 outline-none border-none uppercase"
          />
        </div>
        <div className="grid grid-cols-4 gap-2 mt-3 max-h-56 overflow-y-auto pr-1">
          {filteredAssets.map((symbol) => (
            <button
              key={symbol}
              onClick={() => selectAsset(symbol)}
              className={cn(
                "h-12 rounded-2xl text-xs font-semibold border transition-all flex flex-col items-center justify-center gap-1",
                selectedAsset === symbol
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-secondary/50 text-muted-foreground active:bg-secondary"
              )}
            >
              <AssetIcon asset={symbol} size={18} />
              {symbol}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-[22px] p-4 mb-4 bg-card/90 border border-border/80 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold">2. 选择充值网络</h2>
            <p className="text-xs text-muted-foreground mt-0.5">仅展示当前币种常用且推荐的网络。</p>
          </div>
          <span className="text-[10px] px-2 py-1 rounded-full bg-amber-400/10 text-amber-500 border border-amber-400/20">Network</span>
        </div>
        <div className="space-y-2">
          {supportedChains.map((c) => {
            const item = CHAIN_META[c];
            const active = chain === c;
            return (
              <button
                key={c}
                onClick={() => setChain(c)}
                className={cn(
                  "w-full rounded-2xl p-3 border text-left transition-all",
                  active ? "border-primary bg-primary/10 shadow-[0_0_0_1px_var(--primary)]" : "border-border bg-background/50 active:bg-secondary/70"
                )}
              >
                <div className="flex items-start gap-3">
                  <div className={cn(
                    "w-9 h-9 rounded-2xl flex items-center justify-center border shrink-0",
                    active ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-muted-foreground border-border"
                  )}>
                    {active ? <CheckCircle2 className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold">{item.title}</span>
                      <span className="text-xs font-mono text-muted-foreground">{item.shortName}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground leading-5">{item.subtitle}</p>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                      <span className="text-muted-foreground">到账：<b className="font-medium text-foreground">{item.arrival}</b></span>
                      <span className="text-muted-foreground">确认：<b className="font-medium text-foreground">{item.confirmations}</b></span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>
      <WalletTransfer asset={selectedAsset} chain={chain} depositAddress={addr?.address} />

      <section className="rounded-[24px] p-4 mb-4 bg-card/95 border border-border/80 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold">3. 复制充值地址</h2>
            <p className="text-xs text-muted-foreground mt-0.5">仅向该地址充值 {displayAsset}（{currentNetwork.shortName}）。</p>
          </div>
          <QrCode className="w-5 h-5 text-muted-foreground" />
        </div>

        <div className="flex flex-col items-center">
          <div className="w-44 h-44 rounded-[28px] bg-white border border-border shadow-sm p-3 flex items-center justify-center">
            {qrDataUrl ? <img src={qrDataUrl} alt={`${displayAsset} ${currentNetwork.shortName} 充值二维码`} className="w-full h-full object-contain" /> : <QrCode className="w-16 h-16 text-slate-300" />}
          </div>
          <div className="mt-3 text-[11px] text-muted-foreground">二维码与下方地址一致，请勿跨网络转入</div>
        </div>

        <div className="mt-4 rounded-2xl p-3 bg-background/70 border border-border">
          <div className="text-[11px] text-muted-foreground mb-1.5">充值地址</div>
          <div className="break-all text-sm font-mono text-foreground leading-relaxed min-h-[42px]">
            {addr?.address ?? "地址生成中…"}
          </div>
          <button
            className={cn(
              "mt-3 w-full h-11 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold transition-all border",
              copied ? "text-up border-up/30 bg-up/10" : "text-primary border-primary/30 bg-primary/10 active:bg-primary/15"
            )}
            disabled={!addr?.address}
            onClick={handleCopy}
          >
            {copied ? <><CheckCircle2 className="w-4 h-4" /> 已复制</> : <><Copy className="w-4 h-4" /> 复制地址</>}
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <InfoCell label="最小充值" value={`${currentNetwork.minDeposit} ${displayAsset}`} />
          <InfoCell label="预计到账" value={currentNetwork.arrival} />
          <InfoCell label="入账确认" value={currentNetwork.confirmations} />
          <InfoCell label="地址格式" value={currentNetwork.addressHint} />
        </div>
      </section>

      <section className="rounded-[22px] p-4 mb-4 bg-amber-400/10 border border-amber-400/25">
        <div className="flex gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">充值前请确认币种与网络完全一致</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              请勿向该地址充值非 {currentNetwork.shortName} 网络资产。错误网络、错误币种或低于最小充值金额的转账，可能无法自动入账。
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-[22px] p-4 mb-4 bg-card/90 border border-border/80 shadow-sm">
        <h2 className="text-sm font-semibold mb-3">充值流程</h2>
        <div className="space-y-3">
          <StepRow index="1" title="选择币种与网络" desc="先确定资产，再选择平台展示的可用网络。" />
          <StepRow index="2" title="复制地址或扫码" desc={`转出时网络必须选择 ${currentNetwork.shortName}。`} />
          <StepRow index="3" title="等待链上确认" desc={`${currentNetwork.confirmations} 后自动入账到账户余额。`} />
        </div>
      </section>

      {isAdmin && (
        <div className="mt-4 rounded-[22px] p-4 bg-card/90 border border-border/80 shadow-sm">
          <div className="text-sm font-semibold text-primary mb-3">入账核验</div>
          <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
            <input
              value={asset}
              onChange={(e) => setAsset(normalizeAsset(e.target.value))}
              placeholder="代币"
              className="h-10 px-3 rounded-xl text-sm font-mono text-foreground placeholder:text-muted-foreground/60 outline-none uppercase ui-field"
            />
            <input
              value={simAmount}
              onChange={(e) => setSimAmount(e.target.value)}
              placeholder="金额"
              inputMode="decimal"
              className="h-10 px-3 rounded-xl text-sm font-mono text-foreground placeholder:text-muted-foreground/60 outline-none ui-field"
            />
            <button
              className="h-10 px-4 rounded-xl text-sm font-semibold text-primary-foreground disabled:opacity-50 transition-opacity bg-primary"
              onClick={() => sim.mutate({ chain, asset: selectedAsset, amount: simAmount })}
              disabled={sim.isPending || !selectedAsset}
            >
              核验
            </button>
          </div>
        </div>
      )}

      <section className="mt-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">充值记录</div>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock3 className="w-3.5 h-3.5" /> 实时刷新
          </div>
        </div>
        <ul className="flex flex-col gap-2">
          {(history ?? []).map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-card/90 border border-border/80 shadow-sm">
              <AssetIcon asset={d.asset} size={34} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-up">+{fmtAmount(d.amount)} {d.asset}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {String(d.chain).toUpperCase()} · {d.status === "confirmed" ? "已确认" : d.status}
                </div>
              </div>
              <div className="text-xs text-muted-foreground text-right shrink-0">
                {new Date(d.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
            </li>
          ))}
          {(!history || history.length === 0) && (
            <li className="rounded-2xl bg-card/70 border border-dashed border-border py-10 text-center text-muted-foreground text-sm">
              暂无充值记录
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl p-3 bg-background/70 border border-border">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-xs font-semibold text-foreground leading-5">{value}</div>
    </div>
  );
}

function StepRow({ index, title, desc }: { index: string; title: string; desc: string }) {
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-bold flex items-center justify-center shrink-0">
        {index}
      </div>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground leading-5 mt-0.5">{desc}</div>
      </div>
    </div>
  );
}
