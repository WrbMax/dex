import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Copy, Key, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import { getLoginUrl } from "@/const";

type CreatedKey = {
  publicKey: string;
  secret: string;
  label: string;
  permissions: { read: boolean; trade: boolean; withdraw: boolean };
  ipWhitelist: string[];
};

function copyText(text: string, label: string) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success(`${label}已复制`),
    () => toast.error("复制失败，请手动复制")
  );
}

function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

export default function ApiKeys() {
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const { data: keys, isLoading } = trpc.exchange.apiKeys.useQuery(undefined, { enabled: isAuthenticated });
  const [label, setLabel] = useState("量化交易 Key");
  const [trade, setTrade] = useState(true);
  const [ipText, setIpText] = useState("");
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const ipWhitelist = useMemo(
    () => ipText.split(/[\n,]/).map((v) => v.trim()).filter(Boolean),
    [ipText]
  );

  const createKey = trpc.exchange.createApiKey.useMutation({
    onSuccess: (data) => {
      setCreated(data as CreatedKey);
      toast.success("API Key 已创建，请立即保存 Secret");
      utils.exchange.apiKeys.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const revokeKey = trpc.exchange.revokeApiKey.useMutation({
    onSuccess: () => {
      toast.success("API Key 已撤销");
      utils.exchange.apiKeys.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (!isAuthenticated) {
    return (
      <div className="w-full px-4 pt-24 flex flex-col items-center gap-4">
        <div className="w-16 h-16 rounded-full flex items-center justify-center bg-primary/10 border border-primary/30">
          <Key className="w-8 h-8 text-primary" />
        </div>
        <div className="text-muted-foreground text-sm">请登录后管理 API Key</div>
        <button onClick={() => (window.location.href = getLoginUrl())} className="px-8 py-3 rounded-2xl font-semibold text-white text-sm bg-primary">
          立即登录
        </button>
      </div>
    );
  }

  return (
    <div className="w-full px-4 pb-24 pt-3">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/me" className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-lg font-semibold">API 管理</h1>
          <p className="text-xs text-muted-foreground">创建、查看和撤销用于程序化交易的 API Key</p>
        </div>
      </div>

      {created && (
        <section className="rounded-2xl p-4 mb-4 border border-yellow-500/40 bg-yellow-500/10">
          <div className="font-semibold text-yellow-200 mb-2">请立即保存 Secret</div>
          <p className="text-xs text-yellow-100/80 mb-3">Secret 只显示一次，关闭后无法再次查看；如遗失请撤销并重新创建。</p>
          <div className="space-y-2 text-xs">
            <SecretRow label="API Key" value={created.publicKey} />
            <SecretRow label="Secret" value={created.secret} secret />
          </div>
          <button onClick={() => setCreated(null)} className="mt-3 px-3 py-2 rounded-xl text-xs bg-secondary text-foreground">我已保存</button>
        </section>
      )}

      <section className="bg-card rounded-2xl p-4 mb-4">
        <div className="font-semibold mb-3 flex items-center gap-2"><Plus className="w-4 h-4 text-primary" />创建 API Key</div>
        <label className="text-xs text-muted-foreground">标签</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64}
          className="w-full mt-1 mb-3 px-3 py-2 rounded-xl bg-secondary text-sm outline-none border border-border" />
        <label className="flex items-start gap-2 mb-3 text-sm">
          <input type="checkbox" checked={trade} onChange={(e) => setTrade(e.target.checked)} className="mt-1" />
          <span><span className="font-medium">允许交易</span><span className="block text-xs text-muted-foreground">开启后可通过 REST API 下单和撤单；提现权限永久关闭。</span></span>
        </label>
        <label className="text-xs text-muted-foreground">IP 白名单，可选。多个 IP 用换行或英文逗号分隔。</label>
        <textarea value={ipText} onChange={(e) => setIpText(e.target.value)} rows={3}
          placeholder="例如：203.0.113.10"
          className="w-full mt-1 mb-3 px-3 py-2 rounded-xl bg-secondary text-sm outline-none border border-border" />
        <button disabled={!label.trim() || createKey.isPending}
          onClick={() => createKey.mutate({ label: label.trim(), permissions: { read: true, trade, withdraw: false }, ipWhitelist })}
          className="w-full py-3 rounded-2xl text-sm font-semibold text-white disabled:opacity-50 bg-primary">
          {createKey.isPending ? "创建中..." : "创建 API Key"}
        </button>
      </section>

      <section className="bg-card rounded-2xl p-4">
        <div className="font-semibold mb-3 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-green-400" />当前 API Key</div>
        {isLoading && <div className="text-sm text-muted-foreground py-6 text-center">加载中...</div>}
        {!isLoading && (!keys || keys.length === 0) && <div className="text-sm text-muted-foreground py-6 text-center">暂无 API Key</div>}
        <div className="space-y-3">
          {keys?.map((k) => (
            <div key={k.id} className="rounded-xl p-3 bg-secondary/70 border border-border">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{k.label}</div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{k.publicKey}</div>
                </div>
                <button onClick={() => revokeKey.mutate({ id: k.id })} disabled={revokeKey.isPending}
                  className="w-9 h-9 rounded-full bg-down/10 text-down flex items-center justify-center disabled:opacity-50"
                  aria-label="撤销 API Key">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3 text-xs text-muted-foreground">
                <div>权限：读取{k.permissions.trade ? "、交易" : ""}</div>
                <div>创建：{fmtDate(k.createdAt)}</div>
                <div>最近使用：{fmtDate(k.lastUsedAt)}</div>
                <div>IP：{k.ipWhitelist?.length ? k.ipWhitelist.join(", ") : "不限"}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <Link href="/docs/api" className="block text-center mt-4 text-sm text-primary">查看开发者 API 文档</Link>
    </div>
  );
}

function SecretRow({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  return (
    <div className="rounded-xl bg-background/60 border border-white/10 p-3">
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="text-muted-foreground">{label}</span>
        <button onClick={() => copyText(value, label)} className="text-primary flex items-center gap-1">
          <Copy className="w-3 h-3" />复制
        </button>
      </div>
      <code className="block break-all text-[11px] font-mono text-foreground">{secret ? value : value}</code>
    </div>
  );
}
