import { AssetIcon } from "@/components/AssetIcon";
import { Link } from "wouter";
import { ChevronLeft, ArrowDown, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtAmount } from "@/lib/format";
import { toast } from "sonner";
import { cn } from "@/lib/utils";


export default function Transfer() {
  const { data: subs, refetch: refetchSubs } = trpc.exchange.subAccounts.useQuery();
  const { data: history, refetch: refetchHistory } = trpc.exchange.transferHistory.useQuery();
  const { data: balances } = trpc.exchange.balances.useQuery(undefined, { placeholderData: (prev) => prev });
  const [from, setFrom] = useState<number | undefined>();
  const [to, setTo] = useState<number | undefined>();
  const [asset, setAsset] = useState("USDT");
  const [amount, setAmount] = useState("");

  const availableAssets = useMemo(() => {
    if (!balances || balances.length === 0) return ["USDT"];
    return balances.filter((b) => Number(b.available) > 0).map((b) => b.asset);
  }, [balances]);

  const sameAccount = from !== undefined && from === to;

  useMemo(() => {
    if (!from && subs?.[0]) setFrom(subs[0].id);
    if (!to && subs?.[1]) setTo(subs[1].id);
  }, [subs, from, to]);

  const create = trpc.exchange.createSubAccount.useMutation({
    onSuccess: () => { toast.success("子账户已创建"); refetchSubs(); },
    onError: (e) => toast.error(e.message),
  });

  const doTransfer = trpc.exchange.transfer.useMutation({
    onSuccess: () => { toast.success("划转成功"); setAmount(""); refetchHistory(); },
    onError: (e) => toast.error(e.message),
  });

  const fromAvail = useMemo(() => {
    if (!balances || !from) return "0";
    return balances.find((b) => b.asset === asset)?.available ?? "0";
  }, [balances, from, asset]);

  return (
    <div className="w-full px-4 pt-3 pb-10 safe-top">
      {/* Header */}
      <header className="flex items-center gap-2 mb-5">
        <Link href="/">
          <button className="tap-target p-1.5 -ml-1.5 rounded-xl ui-secondary-button transition-colors">
            <ChevronLeft className="w-5 h-5" />
          </button>
        </Link>
        <h1 className="text-lg font-semibold">划转</h1>
      </header>

      {/* Form card */}
      <div className="rounded-2xl p-5 ui-surface">
        {/* From */}
        <div className="text-xs text-muted-foreground mb-1.5">从</div>
        <select
          className="w-full h-11 px-3 rounded-xl text-sm text-foreground outline-none appearance-none ui-field"
          value={from ?? ""}
          onChange={(e) => setFrom(Number(e.target.value))}
        >
          {(subs ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}{s.isDefault ? "（主）" : ""}
            </option>
          ))}
        </select>

        {/* Arrow */}
        <div className="my-3 flex justify-center">
          <div className="p-2 rounded-full" >
            <ArrowDown className="w-4 h-4 text-primary" />
          </div>
        </div>

        {/* To */}
        <div className="text-xs text-muted-foreground mb-1.5">到</div>
        <select
          className="w-full h-11 px-3 rounded-xl text-sm text-foreground outline-none appearance-none ui-field"
          value={to ?? ""}
          onChange={(e) => setTo(Number(e.target.value))}
        >
          {(subs ?? []).filter((s) => s.id !== from).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}{s.isDefault ? "（主）" : ""}
            </option>
          ))}
        </select>
        {sameAccount && (
          <div className="mt-2 text-xs text-down rounded-xl px-3 py-2"
            style={{ background: "oklch(0.66 0.22 20 / 0.08)", border: "1px solid oklch(0.66 0.22 20 / 0.2)" }}>
            转入账户不能与转出账户相同
          </div>
        )}

        {/* Asset + Amount */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">币种</div>
            <select
              className="w-full h-10 px-3 rounded-xl text-sm text-foreground outline-none appearance-none ui-field"
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
            >
              {availableAssets.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">金额</div>
            <div className="flex items-center h-10 px-3 rounded-xl ui-field">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="flex-1 bg-transparent text-sm font-mono text-foreground placeholder:text-muted-foreground/60 outline-none border-none"
              />
            </div>
          </div>
        </div>

        <div className="mt-2 text-xs text-muted-foreground">
          可用 <span className="font-mono text-foreground/80">{fmtAmount(fromAvail)} {asset}</span>
        </div>

        <button
          className="w-full mt-5 h-12 rounded-2xl font-semibold text-white text-sm active:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: "oklch(0.62 0.22 262)" }}
          disabled={!from || !to || sameAccount || !amount || Number(amount) <= 0 || doTransfer.isPending}
          onClick={() => doTransfer.mutate({ fromSubAccountId: from!, toSubAccountId: to!, asset, amount })}
        >
          {doTransfer.isPending ? "划转中…" : "确认划转"}
        </button>
      </div>

      {/* Sub-accounts */}
      <div className="mt-4 rounded-2xl p-4 ui-surface">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">子账户</div>
          <button
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-medium text-primary transition-colors ui-secondary-button"
            onClick={() => {
              const name = window.prompt("子账户名称");
              if (name) create.mutate({ name });
            }}
          >
            <Plus className="w-3.5 h-3.5" /> 新建
          </button>
        </div>
        <ul className="flex flex-col gap-1.5">
          {(subs ?? []).map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between px-3 py-2 rounded-xl text-sm ui-surface-soft"
            >
              <span className="font-medium">{s.name}</span>
              {s.isDefault && (
                <span className="text-xs text-primary px-2 py-0.5 rounded-full"
                  style={{ background: "oklch(0.62 0.22 262 / 0.15)" }}>
                  默认主账户
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* History */}
      <section className="mt-5">
        <div className="text-sm font-semibold mb-3">划转记录</div>
        <ul className="flex flex-col gap-2">
          {(history ?? []).map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-3 px-4 py-3 rounded-2xl ui-surface-soft"
            >
              <AssetIcon asset={t.asset} size={32} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{fmtAmount(t.amount)} {t.asset}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  账户 #{t.fromSubAccountId} → #{t.toSubAccountId}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                {new Date(t.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
            </li>
          ))}
          {(!history || history.length === 0) && (
            <li className="text-center py-10 text-muted-foreground text-sm">暂无划转记录</li>
          )}
        </ul>
      </section>
    </div>
  );
}
