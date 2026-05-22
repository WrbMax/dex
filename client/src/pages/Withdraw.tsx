import { AssetIcon } from "@/components/AssetIcon";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  Info,
  Search,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { fmtAmount } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  CHAIN_META,
  ON_CHAIN_ASSETS,
  getSupportedChainsForAsset,
  type Chain,
} from "@shared/wallet";

const FEATURED_ASSETS = ["USDT", "BTC", "ETH", "BNB", "SOL", "TRX", "MATIC", "ARB"];
const ALL_ASSET_OPTIONS = Array.from(new Set([...FEATURED_ASSETS, ...ON_CHAIN_ASSETS]));
const EVM_CHAINS: Chain[] = ["erc20", "bep20", "polygon", "arbitrum", "optimism"];

const normalizeAsset = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
const parseNumber = (value: string) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function validateAddress(address: string, chain: Chain) {
  const trimmed = address.trim();
  if (!trimmed) return "请输入提现地址";
  if (trimmed.length > 64) return "提现地址过长";
  if (EVM_CHAINS.includes(chain) && !/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return "请输入正确的 EVM 地址（0x 开头，共 42 位）";
  if (chain === "trc20" && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) return "请输入正确的 TRON 地址（T 开头）";
  if (chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return "请输入正确的 Solana 地址";
  if (chain === "bitcoin" && !/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(trimmed)) return "请输入正确的 Bitcoin 地址";
  return "";
}

function normalizeAmountInput(value: string) {
  return value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 32);
}

export default function Withdraw() {
  const [chain, setChain] = useState<Chain>("trc20");
  const [asset, setAsset] = useState("USDT");
  const [assetSearch, setAssetSearch] = useState("");
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");

  const { data: balances } = trpc.exchange.balances.useQuery(undefined, {
    refetchInterval: 3000,
    placeholderData: (prev) => prev,
  });
  const { data: history, refetch } = trpc.exchange.withdrawHistory.useQuery(undefined, {
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
  });
  const submit = trpc.exchange.submitWithdrawal.useMutation({
    onSuccess: () => {
      toast.success("提现申请已提交，等待风控审核");
      setAmount("");
      setToAddress("");
      refetch();
    },
    onError: (e) => {
      const msg = e.message
        .replace("Amount must be positive", "请输入有效提现金额")
        .replace("Destination address is required", "请输入提现地址")
        .replace("Destination address is too long", "提现地址过长")
        .replace("Invalid EVM destination address", "EVM 地址格式不正确")
        .replace("Invalid TRON destination address", "TRON 地址格式不正确")
        .replace("Invalid Solana destination address", "Solana 地址格式不正确")
        .replace("Invalid Bitcoin destination address", "Bitcoin 地址格式不正确")
        .replace(`Insufficient ${selectedAsset} available`, `${selectedAsset} 余额不足`)
        .replace(/Insufficient (.+) available/, "$1 余额不足")
        .replace(/Amount must exceed network fee \((.+) (.+)\)/, "金额必须大于网络手续费 $1 $2");
      toast.error(msg);
    },
  });

  const selectedAsset = normalizeAsset(asset) || "USDT";
  const supportedChains = useMemo(() => getSupportedChainsForAsset(selectedAsset), [selectedAsset]);
  const network = CHAIN_META[chain];
  const balance = balances?.find((b) => b.asset.toUpperCase() === selectedAsset);
  const available = parseNumber(balance?.available ?? "0");
  const fee = selectedAsset === "USDT" ? parseNumber(network.withdrawFeeUSDT) : 0;
  const numericAmount = parseNumber(amount);
  const arrival = Math.max(numericAmount - fee, 0);
  const addressError = validateAddress(toAddress, chain);
  const amountError = amount && numericAmount <= 0
    ? "请输入有效提现金额"
    : amount && numericAmount > available
      ? `${selectedAsset} 可用余额不足`
      : amount && numericAmount <= fee
        ? `提现金额必须大于手续费 ${network.withdrawFeeUSDT} ${selectedAsset}`
        : "";
  const canSubmit = !addressError && !amountError && numericAmount > 0 && selectedAsset.length > 0 && !submit.isPending;

  const availableAssets = useMemo(() => {
    const assets = new Set(ALL_ASSET_OPTIONS);
    for (const b of balances ?? []) assets.add(b.asset.toUpperCase());
    return Array.from(assets);
  }, [balances]);

  const filteredAssets = useMemo(() => {
    const keyword = normalizeAsset(assetSearch);
    if (!keyword) return availableAssets;
    return availableAssets.filter((symbol) => symbol.includes(keyword));
  }, [assetSearch, availableAssets]);

  useEffect(() => {
    if (!supportedChains.includes(chain)) {
      setChain(supportedChains[0]);
    }
  }, [chain, supportedChains]);

  const selectAsset = (symbol: string) => {
    const normalized = normalizeAsset(symbol);
    setAsset(normalized);
    setAssetSearch("");
    const nextChains = getSupportedChainsForAsset(normalized);
    setChain(nextChains[0]);
  };

  const setPercentAmount = (percent: number) => {
    const value = Math.max(available * percent, 0);
    const fixed = value >= 1 ? value.toFixed(6) : value.toPrecision(6);
    setAmount(fixed.replace(/\.?0+$/, ""));
  };

  const onSubmit = () => {
    if (addressError) return toast.error(addressError);
    if (amountError) return toast.error(amountError);
    if (!numericAmount) return toast.error("请输入提现金额");
    submit.mutate({ chain, asset: selectedAsset, amount, toAddress: toAddress.trim() });
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
            <h1 className="text-lg font-semibold">提现 Crypto</h1>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold text-down bg-down/10 border border-down/20">链上出金</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">按币种筛选网络，提交后进入平台审核与链上广播流程。</p>
        </div>
      </header>

      <section className="rounded-[24px] p-4 mb-4 bg-card/90 border border-border/80 shadow-sm overflow-hidden relative">
        <div className="absolute -right-10 -top-10 w-28 h-28 rounded-full bg-down/10 blur-2xl" />
        <div className="relative flex items-start justify-between gap-4">
          <div>
            <div className="text-xs text-muted-foreground">当前提现资产</div>
            <div className="mt-2 flex items-center gap-3">
              <AssetIcon asset={selectedAsset} size={42} />
              <div>
                <div className="text-2xl font-semibold tracking-tight">{selectedAsset}</div>
                <div className="text-xs text-muted-foreground">可用 {fmtAmount(balance?.available ?? "0")} {selectedAsset}</div>
              </div>
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground leading-5">
            <div className="font-medium text-foreground">预计到账</div>
            <div>{network.arrival}</div>
          </div>
        </div>
      </section>

      <section className="rounded-[22px] p-4 mb-4 bg-card/90 border border-border/80 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold">1. 选择提现币种</h2>
            <p className="text-xs text-muted-foreground mt-0.5">优先展示有余额资产，同时保留主流资产快捷入口。</p>
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
          {filteredAssets.map((symbol) => {
            const b = balances?.find((item) => item.asset.toUpperCase() === symbol);
            const hasBalance = Number(b?.available ?? 0) > 0;
            return (
              <button
                key={symbol}
                onClick={() => selectAsset(symbol)}
                className={cn(
                  "h-14 rounded-2xl text-xs font-semibold border transition-all flex flex-col items-center justify-center gap-1 relative overflow-hidden",
                  selectedAsset === symbol
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-secondary/50 text-muted-foreground active:bg-secondary"
                )}
              >
                {hasBalance && <span className="absolute right-1.5 top-1.5 w-1.5 h-1.5 rounded-full bg-up" />}
                <AssetIcon asset={symbol} size={18} />
                {symbol}
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-[22px] p-4 mb-4 bg-card/90 border border-border/80 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold">2. 选择提现网络</h2>
            <p className="text-xs text-muted-foreground mt-0.5">收款地址网络必须与这里完全一致。</p>
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
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                      <span className="text-muted-foreground">手续费：<b className="font-medium text-foreground">{selectedAsset === "USDT" ? item.withdrawFeeUSDT : "0"}</b></span>
                      <span className="text-muted-foreground">确认：<b className="font-medium text-foreground">{item.confirmations}</b></span>
                      <span className="text-muted-foreground">到账：<b className="font-medium text-foreground">{item.arrival}</b></span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-[24px] p-4 mb-4 bg-card/95 border border-border/80 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold">3. 填写地址与金额</h2>
            <p className="text-xs text-muted-foreground mt-0.5">地址格式会根据当前网络自动校验。</p>
          </div>
          <ArrowDownToLine className="w-5 h-5 text-muted-foreground" />
        </div>

        <div className="space-y-3">
          <label className="block">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-muted-foreground">提现地址</span>
              <span className="text-[11px] text-muted-foreground">{network.addressHint}</span>
            </div>
            <textarea
              value={toAddress}
              onChange={(e) => setToAddress(e.target.value)}
              rows={3}
              placeholder={`请输入 ${network.shortName} 收款地址`}
              className={cn(
                "w-full resize-none rounded-2xl px-3 py-3 text-sm font-mono leading-relaxed outline-none ui-field",
                toAddress && addressError ? "border-down/40" : ""
              )}
            />
            {toAddress && addressError && <div className="mt-1.5 text-xs text-down">{addressError}</div>}
          </label>

          <label className="block">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-muted-foreground">提现金额</span>
              <button type="button" onClick={() => setPercentAmount(1)} className="text-[11px] font-semibold text-primary">全部提现</button>
            </div>
            <div className={cn("flex items-center gap-3 rounded-2xl px-3 py-3 ui-field", amount && amountError ? "border-down/40" : "")}>
              <input
                value={amount}
                onChange={(e) => setAmount(normalizeAmountInput(e.target.value))}
                inputMode="decimal"
                placeholder="最小提现金额需大于手续费"
                className="flex-1 bg-transparent text-lg font-semibold text-foreground placeholder:text-muted-foreground/50 outline-none border-none"
              />
              <span className="text-sm font-semibold text-muted-foreground">{selectedAsset}</span>
            </div>
            <div className="mt-2 flex gap-2">
              {[0.25, 0.5, 0.75, 1].map((p) => (
                <button
                  type="button"
                  key={p}
                  onClick={() => setPercentAmount(p)}
                  className="flex-1 h-8 rounded-xl text-[11px] font-semibold border border-border bg-secondary/50 text-muted-foreground active:bg-secondary"
                >
                  {Math.round(p * 100)}%
                </button>
              ))}
            </div>
            {amount && amountError && <div className="mt-1.5 text-xs text-down">{amountError}</div>}
          </label>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <InfoCell label="可用余额" value={`${fmtAmount(balance?.available ?? "0")} ${selectedAsset}`} />
          <InfoCell label="网络手续费" value={`${selectedAsset === "USDT" ? network.withdrawFeeUSDT : "0"} ${selectedAsset}`} />
          <InfoCell label="实际到账" value={`${numericAmount ? fmtAmount(String(arrival)) : "0"} ${selectedAsset}`} />
          <InfoCell label="审核状态" value="人工风控审核" />
        </div>

        <button
          onClick={onSubmit}
          disabled={!canSubmit}
          className="mt-4 w-full h-12 rounded-2xl bg-primary text-primary-foreground font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          {submit.isPending ? "提交中…" : "提交提现申请"}
        </button>
      </section>

      <section className="rounded-[22px] p-4 mb-4 bg-amber-400/10 border border-amber-400/25">
        <div className="flex gap-3">
          <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">提现安全提示</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              提交前请确认收款平台选择的是 {network.shortName} 网络。错误地址或错误网络可能造成不可逆资产损失。平台不会通过客服要求你泄露私钥、助记词或验证码。
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-[22px] p-4 mb-4 bg-card/90 border border-border/80 shadow-sm">
        <h2 className="text-sm font-semibold mb-3">提现流程</h2>
        <div className="space-y-3">
          <StepRow index="1" title="提交申请" desc="填写地址和金额后，系统立即冻结对应可用余额。" />
          <StepRow index="2" title="平台审核" desc="风控审核地址、金额和账户状态，审核通过后进入链上广播。" />
          <StepRow index="3" title="链上确认" desc={`${network.confirmations} 后提现状态更新为已完成。`} />
        </div>
      </section>

      <section className="mt-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">提现记录</div>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock3 className="w-3.5 h-3.5" /> 实时刷新
          </div>
        </div>
        <ul className="flex flex-col gap-2">
          {(history ?? []).map((w) => (
            <li key={w.id} className="px-4 py-3 rounded-2xl bg-card/90 border border-border/80 shadow-sm">
              <div className="flex items-start gap-3">
                <AssetIcon asset={w.asset} size={34} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-down">-{fmtAmount(w.amount)} {w.asset}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {String(w.chain).toUpperCase()} · 手续费 {fmtAmount(w.feeAmount ?? "0")} · {statusText(String(w.status))}
                  </div>
                  <div className="mt-2 text-[11px] font-mono text-muted-foreground truncate">{w.toAddress}</div>
                </div>
                <div className="text-xs text-muted-foreground text-right shrink-0">
                  {new Date(w.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            </li>
          ))}
          {(!history || history.length === 0) && (
            <li className="rounded-2xl bg-card/70 border border-dashed border-border py-10 text-center text-muted-foreground text-sm">
              暂无提现记录
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

function statusText(status: string) {
  const map: Record<string, string> = {
    pending: "待审核",
    reviewing: "审核中",
    approved: "已通过",
    broadcasting: "广播中",
    confirmed: "已完成",
    rejected: "已拒绝",
    failed: "失败",
  };
  return map[status] ?? status;
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
