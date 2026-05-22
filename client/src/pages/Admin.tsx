/**
 * Admin Dashboard — full-featured management console
 * Tabs: Overview | Users | Orders | Deposits | Withdrawals | Fees | Markets | System
 */
import { useState } from "react";
import { Link } from "wouter";
import {
  ChevronLeft, LayoutDashboard, Users, ClipboardList,
  ArrowDownToLine, ArrowUpFromLine, Percent, BarChart2,
  Settings, Ban, CheckCircle, X, AlertTriangle,
  DollarSign, Shield, Eye, Edit2, Save, Search,
  ChevronLeft as Prev, ChevronRight as Next, PlusCircle, FileSearch,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { fmtAmount, shortenAddress } from "@/lib/format";
import { useAuth } from "@/_core/hooks/useAuth";

/* ─────────────────────────────────────────────────────── helpers ── */
type MarketMode = "binance_mirror" | "orderbook";
type MarketDataSource = "binance" | "internal" | "manual";
type MarketEditValues = {
  minNotional: string;
  priceTick: string;
  amountStep: string;
  marketMode: MarketMode;
  externalSymbol: string;
  marketDataSource: MarketDataSource;
  allowLimitOrder: boolean;
  allowMarketOrder: boolean;
  logoUrl: string;
  description: string;
  websiteUrl: string;
  whitepaperUrl: string;
  explorerUrl: string;
  contractAddress: string;
};

type CreateMarketValues = MarketEditValues & {
  symbol: string;
  base: string;
  quote: string;
  takerFee: string;
  makerFee: string;
  isActive: boolean;
};

const DEFAULT_CREATE_MARKET: CreateMarketValues = {
  symbol: "",
  base: "",
  quote: "USDT",
  minNotional: "5",
  priceTick: "0.01",
  amountStep: "0.0001",
  takerFee: "0.001",
  makerFee: "0.0008",
  marketMode: "binance_mirror",
  externalSymbol: "",
  marketDataSource: "binance",
  allowLimitOrder: true,
  allowMarketOrder: true,
  logoUrl: "",
  description: "",
  websiteUrl: "",
  whitepaperUrl: "",
  explorerUrl: "",
  contractAddress: "",
  isActive: true,
};

const MARKET_MODE_LABEL: Record<MarketMode, string> = {
  binance_mirror: "自动做市（平台流动性）",
  orderbook: "订单簿撮合",
};

const MARKET_MODE_HELP: Record<MarketMode, string> = {
  binance_mirror: "市价单直接由平台流动性成交，限价单可按行情触发或进入委托簿。",
  orderbook: "完全依赖站内买卖委托撮合，适合已有足够真实挂单深度的交易对。",
};

const MARKET_DATA_SOURCE_LABEL: Record<MarketDataSource, string> = {
  binance: "主行情通道",
  internal: "内部行情",
  manual: "手动维护",
};

const MARKET_NUMERIC_FIELDS = ["minNotional", "priceTick", "amountStep", "takerFee", "makerFee"] as const;

function normalizeMarketSymbol(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isPositiveDecimalInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) return false;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0;
}

const GLASS = "rounded-2xl p-4" as const;
const GLASS_STYLE = { background: "oklch(0.17 0.035 258 / 0.7)", border: "1px solid oklch(1 0 0 / 9%)" };
const CARD_STYLE = { background: "oklch(0.15 0.03 258 / 0.9)", border: "1px solid oklch(1 0 0 / 12%)" };

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className={GLASS} style={GLASS_STYLE}>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={cn("text-2xl font-bold font-mono", color ?? "text-foreground")}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function Badge({ status }: { status: string }) {
  const map: Record<string, string> = {
    new: "text-blue-400 bg-blue-400/10",
    partial: "text-yellow-400 bg-yellow-400/10",
    filled: "text-green-400 bg-green-400/10",
    canceled: "text-gray-400 bg-gray-400/10",
    rejected: "text-red-400 bg-red-400/10",
    pending: "text-yellow-400 bg-yellow-400/10",
    reviewing: "text-blue-400 bg-blue-400/10",
    approved: "text-green-400 bg-green-400/10",
    confirmed: "text-green-400 bg-green-400/10",
    credited: "text-green-400 bg-green-400/10",
    failed: "text-red-400 bg-red-400/10",
    broadcasting: "text-purple-400 bg-purple-400/10",
    admin: "text-purple-400 bg-purple-400/10",
    user: "text-gray-400 bg-gray-400/10",
    banned: "text-red-400 bg-red-400/10",
  };
  const cls = map[status] ?? "text-gray-400 bg-gray-400/10";
  return <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", cls)}>{status}</span>;
}

function Pagination({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
      <span>共 {total} 条 / 第 {page}/{totalPages} 页</span>
      <div className="flex gap-1">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)}
          className="p-1 rounded disabled:opacity-30 hover:text-foreground"><Prev className="w-4 h-4" /></button>
        <button disabled={page >= totalPages} onClick={() => onPage(page + 1)}
          className="p-1 rounded disabled:opacity-30 hover:text-foreground"><Next className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────── Overview Tab ── */
function OverviewTab() {
  const { data: stats } = trpc.admin.overview.useQuery(undefined, { refetchInterval: 10000 });
  const { data: recentTrades } = trpc.admin.recentTrades.useQuery({ limit: 20 }, { refetchInterval: 5000 });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="总用户数" value={stats?.totalUsers ?? "—"} sub={`24h 活跃 ${stats?.activeUsers24h ?? 0}`} />
        <StatCard label="活跃订单" value={stats?.openOrders ?? "—"} sub={`总订单 ${stats?.totalOrders ?? 0}`} color="text-primary" />
        <StatCard label="24h 成交量" value={stats ? `$${fmtAmount(stats.volume24h)}` : "—"} sub={`${stats?.trades24h ?? 0} 笔`} color="text-green-400" />
        <StatCard label="手续费收入" value={stats ? `$${fmtAmount(stats.totalFeeIncome)}` : "—"} sub={`24h +$${fmtAmount(stats?.feeIncome24h ?? "0")}`} color="text-yellow-400" />
      </div>
      {(stats?.pendingWithdrawals ?? 0) > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm"
          style={{ background: "oklch(0.75 0.18 80 / 0.08)", border: "1px solid oklch(0.75 0.18 80 / 0.2)" }}>
          <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
          <span>有 <strong className="text-yellow-400">{stats?.pendingWithdrawals}</strong> 笔提现待审核</span>
        </div>
      )}
      <div>
        <div className="text-sm font-semibold mb-2">最近成交</div>
        <div className={cn(GLASS, "p-0 overflow-hidden")} style={GLASS_STYLE}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-white/5">
                <th className="text-left px-3 py-2">交易对</th>
                <th className="text-right px-3 py-2">价格</th>
                <th className="text-right px-3 py-2">数量</th>
                <th className="text-left px-3 py-2">对手方</th>
                <th className="text-right px-3 py-2">时间</th>
              </tr>
            </thead>
            <tbody>
              {(recentTrades ?? []).map((t) => (
                <tr key={t.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                  <td className="px-3 py-2 font-medium">{t.symbol}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtAmount(t.price)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtAmount(t.quantity)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    买方 {t.buyerUserId === 0 ? <span className="text-primary font-medium">平台流动性</span> : <span className="font-mono">#{t.buyerUserId}</span>}
                    <span className="mx-1 text-muted-foreground/60">/</span>
                    卖方 {t.sellerUserId === 0 ? <span className="text-primary font-medium">平台流动性</span> : <span className="font-mono">#{t.sellerUserId}</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {new Date(t.createdAt).toLocaleTimeString("zh-CN")}
                  </td>
                </tr>
              ))}
              {(!recentTrades || recentTrades.length === 0) && (
                <tr><td colSpan={5} className="text-center py-6 text-muted-foreground">暂无成交记录</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────── Users Tab ── */
function UsersTab() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "user" | "admin">("all");
  const [selectedUser, setSelectedUser] = useState<number | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustUserId, setAdjustUserId] = useState(0);
  const [adjustAsset, setAdjustAsset] = useState("USDT");
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("管理员调整");

  const { data, refetch } = trpc.admin.listUsers.useQuery(
    { page, pageSize: 15, search: search || undefined, role: roleFilter },
    { placeholderData: (p) => p }
  );

  const setRole = trpc.admin.setUserRole.useMutation({
    onSuccess: () => { toast.success("角色已更新"); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const ban = trpc.admin.banUser.useMutation({
    onSuccess: () => { toast.success("操作成功"); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const adjust = trpc.admin.adjustBalance.useMutation({
    onSuccess: () => { toast.success("余额已调整"); setAdjustOpen(false); setAdjustDelta(""); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col gap-3">
      {/* Filters */}
      <div className="flex gap-2">
        <div className="flex-1 flex items-center gap-2 px-3 h-9 rounded-xl"
          style={{ background: "oklch(0.17 0.035 258 / 0.7)", border: "1px solid oklch(1 0 0 / 9%)" }}>
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { setSearch(searchInput); setPage(1); } }}
            placeholder="搜索用户名/邮箱/钱包地址 (Enter)" className="flex-1 bg-transparent text-xs outline-none" />
        </div>
        <select value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value as "all" | "user" | "admin"); setPage(1); }}
          className="h-9 px-2 rounded-xl text-xs outline-none"
          style={{ background: "oklch(0.17 0.035 258 / 0.7)", border: "1px solid oklch(1 0 0 / 9%)" }}>
          <option value="all">全部角色</option>
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
      </div>

      {/* Table */}
      <div className={cn(GLASS, "p-0 overflow-hidden")} style={GLASS_STYLE}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-white/5">
              <th className="text-left px-3 py-2">ID</th>
              <th className="text-left px-3 py-2">用户名</th>
              <th className="text-left px-3 py-2">角色/状态</th>
              <th className="text-left px-3 py-2">钱包</th>
              <th className="text-right px-3 py-2">注册时间</th>
              <th className="text-right px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((u) => (
              <tr key={u.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                <td className="px-3 py-2 font-mono text-muted-foreground">{u.id}</td>
                <td className="px-3 py-2">
                  <div className="font-medium">{u.name ?? "—"}</div>
                  <div className="text-muted-foreground text-[10px]">{u.email ?? ""}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <Badge status={u.role} />
                    {u.isBanned && <Badge status="banned" />}
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-muted-foreground">
                  {u.primaryWalletAddress ? shortenAddress(u.primaryWalletAddress) : "未绑定"}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {new Date(u.createdAt).toLocaleDateString("zh-CN")}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button title="查看详情" onClick={() => setSelectedUser(selectedUser === u.id ? null : u.id)}
                      className="p-1 rounded hover:text-primary transition-colors">
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    <button title="调整余额" onClick={() => { setAdjustUserId(u.id); setAdjustOpen(true); }}
                      className="p-1 rounded hover:text-yellow-400 transition-colors">
                      <DollarSign className="w-3.5 h-3.5" />
                    </button>
                    <button
                      title={u.role === "admin" ? "降为普通用户" : "升为管理员"}
                      onClick={() => setRole.mutate({ userId: u.id, role: u.role === "admin" ? "user" : "admin" })}
                      className="p-1 rounded hover:text-purple-400 transition-colors">
                      <Shield className="w-3.5 h-3.5" />
                    </button>
                    <button
                      title={u.isBanned ? "解封" : "封禁"}
                      onClick={() => ban.mutate({ userId: u.id, ban: !u.isBanned })}
                      className={cn("p-1 rounded transition-colors", u.isBanned ? "hover:text-green-400" : "hover:text-red-400")}>
                      {u.isBanned ? <CheckCircle className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {(!data?.rows || data.rows.length === 0) && (
              <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">暂无用户</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} total={data?.total ?? 0} pageSize={15} onPage={setPage} />

      {/* User detail panel */}
      {selectedUser && <UserDetailPanel userId={selectedUser} onClose={() => setSelectedUser(null)} />}

      {/* Adjust balance modal */}
      {adjustOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "oklch(0 0 0 / 0.6)" }}>
          <div className={cn(GLASS, "w-full max-w-sm")} style={CARD_STYLE}>
            <div className="flex items-center justify-between mb-4">
              <div className="font-semibold">调整用户余额 (UID: {adjustUserId})</div>
              <button onClick={() => setAdjustOpen(false)}><X className="w-4 h-4" /></button>
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">币种</div>
                <select value={adjustAsset} onChange={(e) => setAdjustAsset(e.target.value)}
                  className="w-full h-9 px-3 rounded-xl text-sm outline-none"
                  style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(1 0 0 / 10%)" }}>
                  {["USDT", "BTC", "ETH", "SOL", "BNB"].map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">调整金额（正数增加，负数减少）</div>
                <input value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)}
                  placeholder="例：100 或 -50"
                  className="w-full h-9 px-3 rounded-xl text-sm font-mono outline-none"
                  style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(1 0 0 / 10%)" }} />
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">备注原因</div>
                <input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)}
                  className="w-full h-9 px-3 rounded-xl text-sm outline-none"
                  style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(1 0 0 / 10%)" }} />
              </div>
              <div className="flex gap-2 mt-1">
                <Button variant="outline" className="flex-1 bg-secondary border-border" onClick={() => setAdjustOpen(false)}>取消</Button>
                <Button className="flex-1" disabled={!adjustDelta || adjust.isPending}
                  onClick={() => adjust.mutate({ userId: adjustUserId, asset: adjustAsset, delta: adjustDelta, reason: adjustReason })}>
                  确认调整
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UserDetailPanel({ userId, onClose }: { userId: number; onClose: () => void }) {
  const { data } = trpc.admin.getUserDetail.useQuery({ userId });
  if (!data) return null;
  return (
    <div className={cn(GLASS, "mt-1")} style={CARD_STYLE}>
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold text-sm">用户详情 — {data.user.name ?? `UID ${userId}`}</div>
        <button onClick={onClose}><X className="w-4 h-4 text-muted-foreground" /></button>
      </div>
      <div className="text-xs text-muted-foreground mb-2">余额</div>
      <div className="flex flex-wrap gap-2 mb-3">
        {data.balances.map((b) => (
          <div key={b.id} className="px-3 py-1.5 rounded-lg text-xs"
            style={{ background: "oklch(0.22 0.03 258)" }}>
            <span className="font-medium">{b.asset}</span>
            <span className="text-muted-foreground ml-1">可用 {fmtAmount(b.available)}</span>
            {Number(b.locked) > 0 && <span className="text-yellow-400 ml-1">冻结 {fmtAmount(b.locked)}</span>}
          </div>
        ))}
        {data.balances.length === 0 && <span className="text-muted-foreground text-xs">无余额记录</span>}
      </div>
      <div className="text-xs text-muted-foreground mb-1">最近订单（{data.recentOrders.length} 条）</div>
      <div className="flex flex-col gap-1 max-h-24 overflow-auto mb-3">
        {data.recentOrders.slice(0, 5).map((o) => (
          <div key={o.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded"
            style={{ background: "oklch(0.22 0.03 258)" }}>
            <Badge status={o.status} />
            <span className="font-medium">{o.symbol}</span>
            <span className={o.side === "buy" ? "text-green-400" : "text-red-400"}>{o.side.toUpperCase()}</span>
            <span className="font-mono text-muted-foreground">{fmtAmount(o.quantity)}</span>
          </div>
        ))}
        {data.recentOrders.length === 0 && <div className="text-xs text-muted-foreground">无订单记录</div>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-xs text-muted-foreground mb-1">最近充值（{data.recentDeposits.length} 条）</div>
          <div className="flex flex-col gap-1 max-h-20 overflow-auto">
            {data.recentDeposits.slice(0, 4).map((d) => (
              <div key={d.id} className="flex items-center justify-between text-xs px-2 py-1 rounded"
                style={{ background: "oklch(0.22 0.03 258)" }}>
                <span className="text-green-400">+{fmtAmount(d.amount)} {d.asset}</span>
                <Badge status={d.status} />
              </div>
            ))}
            {data.recentDeposits.length === 0 && <div className="text-xs text-muted-foreground">无充值记录</div>}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">最近提现（{data.recentWithdrawals.length} 条）</div>
          <div className="flex flex-col gap-1 max-h-20 overflow-auto">
            {data.recentWithdrawals.slice(0, 4).map((w) => (
              <div key={w.id} className="flex items-center justify-between text-xs px-2 py-1 rounded"
                style={{ background: "oklch(0.22 0.03 258)" }}>
                <span className="text-red-400">-{fmtAmount(w.amount)} {w.asset}</span>
                <Badge status={w.status} />
              </div>
            ))}
            {data.recentWithdrawals.length === 0 && <div className="text-xs text-muted-foreground">无提现记录</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────── Orders Tab ── */
function OrdersTab() {
  const [page, setPage] = useState(1);
  const [symbol, setSymbol] = useState("");
  const [status, setStatus] = useState<"new" | "partial" | "filled" | "canceled" | "rejected" | "all">("all");

  const { data, refetch } = trpc.admin.listAllOrders.useQuery(
    { page, pageSize: 15, symbol: symbol || undefined, status },
    { placeholderData: (p) => p }
  );

  const forceCancel = trpc.admin.forceCancel.useMutation({
    onSuccess: () => { toast.success("订单已强制撤销"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input value={symbol} onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setPage(1); }}
          placeholder="交易对 (如 BTCUSDT)" className="flex-1 h-9 px-3 rounded-xl text-xs outline-none"
          style={{ background: "oklch(0.17 0.035 258 / 0.7)", border: "1px solid oklch(1 0 0 / 9%)" }} />
        <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1); }}
          className="h-9 px-2 rounded-xl text-xs outline-none"
          style={{ background: "oklch(0.17 0.035 258 / 0.7)", border: "1px solid oklch(1 0 0 / 9%)" }}>
          <option value="all">全部状态</option>
          <option value="new">待成交</option>
          <option value="partial">部分成交</option>
          <option value="filled">已成交</option>
          <option value="canceled">已撤销</option>
          <option value="rejected">已拒绝</option>
        </select>
      </div>

      <div className={cn(GLASS, "p-0 overflow-hidden")} style={GLASS_STYLE}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-white/5">
              <th className="text-left px-3 py-2">ID</th>
              <th className="text-left px-3 py-2">用户</th>
              <th className="text-left px-3 py-2">交易对</th>
              <th className="text-left px-3 py-2">方向/类型</th>
              <th className="text-right px-3 py-2">数量</th>
              <th className="text-right px-3 py-2">价格</th>
              <th className="text-left px-3 py-2">状态</th>
              <th className="text-right px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((o) => (
              <tr key={o.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                <td className="px-3 py-2 font-mono text-muted-foreground">{o.id}</td>
                <td className="px-3 py-2 text-muted-foreground">UID:{o.userId}</td>
                <td className="px-3 py-2 font-medium">{o.symbol}</td>
                <td className="px-3 py-2">
                  <span className={o.side === "buy" ? "text-green-400" : "text-red-400"}>{o.side.toUpperCase()}</span>
                  <span className="text-muted-foreground ml-1">{o.type}</span>
                </td>
                <td className="px-3 py-2 text-right font-mono">{fmtAmount(o.quantity)}</td>
                <td className="px-3 py-2 text-right font-mono">{o.price ? fmtAmount(o.price) : "市价"}</td>
                <td className="px-3 py-2"><Badge status={o.status} /></td>
                <td className="px-3 py-2 text-right">
                  {(o.status === "new" || o.status === "partial") && (
                    <button onClick={() => forceCancel.mutate({ orderId: o.id })}
                      className="text-red-400 hover:text-red-300 text-xs px-2 py-0.5 rounded"
                      style={{ background: "oklch(0.5 0.2 20 / 0.15)" }}>
                      强制撤单
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {(!data?.rows || data.rows.length === 0) && (
              <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">暂无订单</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={data?.total ?? 0} pageSize={15} onPage={setPage} />
    </div>
  );
}

/* ─────────────────────────────────────────── Deposits Tab ── */
function DepositsTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"pending" | "confirmed" | "credited" | "all">("all");

  const { data } = trpc.admin.listAllDeposits.useQuery(
    { page, pageSize: 15, status },
    { placeholderData: (p) => p }
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1); }}
          className="h-9 px-2 rounded-xl text-xs outline-none"
          style={{ background: "oklch(0.17 0.035 258 / 0.7)", border: "1px solid oklch(1 0 0 / 9%)" }}>
          <option value="all">全部状态</option>
          <option value="pending">待确认</option>
          <option value="confirmed">已确认</option>
          <option value="credited">已到账</option>
        </select>
      </div>

      <div className={cn(GLASS, "p-0 overflow-hidden")} style={GLASS_STYLE}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-white/5">
              <th className="text-left px-3 py-2">ID</th>
              <th className="text-left px-3 py-2">用户</th>
              <th className="text-left px-3 py-2">链/币种</th>
              <th className="text-right px-3 py-2">金额</th>
              <th className="text-left px-3 py-2">状态</th>
              <th className="text-right px-3 py-2">时间</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((d) => (
              <tr key={d.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                <td className="px-3 py-2 font-mono text-muted-foreground">{d.id}</td>
                <td className="px-3 py-2 text-muted-foreground">UID:{d.userId}</td>
                <td className="px-3 py-2">
                  <span className="font-medium">{d.chain.toUpperCase()}</span>
                  <span className="text-muted-foreground ml-1">{d.asset}</span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-green-400">+{fmtAmount(d.amount)}</td>
                <td className="px-3 py-2"><Badge status={d.status} /></td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {new Date(d.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </td>
              </tr>
            ))}
            {(!data?.rows || data.rows.length === 0) && (
              <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">暂无充值记录</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={data?.total ?? 0} pageSize={15} onPage={setPage} />
    </div>
  );
}

/* ─────────────────────────────────────────── Withdrawals Tab ── */
function WithdrawalsTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"pending" | "reviewing" | "approved" | "confirmed" | "rejected" | "failed" | "all">("all");
  const { data, refetch } = trpc.admin.listAllWithdrawals.useQuery(
    { page, pageSize: 15, status },
    { placeholderData: (p) => p, refetchInterval: 5000 }
  );
  const review = trpc.admin.reviewWithdrawal.useMutation({
    onSuccess: () => { toast.success("处理完成"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1); }}
          className="h-9 px-2 rounded-xl text-xs outline-none"
          style={{ background: "oklch(0.17 0.035 258 / 0.7)", border: "1px solid oklch(1 0 0 / 9%)" }}>
          <option value="all">全部状态</option>
          <option value="pending">待审核</option>
          <option value="reviewing">审核中</option>
          <option value="approved">已批准</option>
          <option value="confirmed">已确认</option>
          <option value="rejected">已驳回</option>
          <option value="failed">失败</option>
        </select>
      </div>

      <div className={cn(GLASS, "p-0 overflow-hidden")} style={GLASS_STYLE}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-white/5">
              <th className="text-left px-3 py-2">ID</th>
              <th className="text-left px-3 py-2">用户</th>
              <th className="text-left px-3 py-2">链/币种</th>
              <th className="text-right px-3 py-2">金额</th>
              <th className="text-left px-3 py-2">地址</th>
              <th className="text-left px-3 py-2">状态</th>
              <th className="text-right px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((w) => (
              <tr key={w.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                <td className="px-3 py-2 font-mono text-muted-foreground">{w.id}</td>
                <td className="px-3 py-2 text-muted-foreground">UID:{w.userId}</td>
                <td className="px-3 py-2">
                  <span className="font-medium">{w.chain.toUpperCase()}</span>
                  <span className="text-muted-foreground ml-1">{w.asset}</span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-red-400">-{fmtAmount(w.amount)}</td>
                <td className="px-3 py-2 font-mono text-muted-foreground">{shortenAddress(w.toAddress)}</td>
                <td className="px-3 py-2"><Badge status={w.status} /></td>
                <td className="px-3 py-2 text-right">
                  {w.status === "pending" && (
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => review.mutate({ id: w.id, decision: "approve" })}
                        className="text-green-400 hover:text-green-300 text-xs px-2 py-0.5 rounded"
                        style={{ background: "oklch(0.5 0.2 140 / 0.15)" }}>批准</button>
                      <button onClick={() => review.mutate({ id: w.id, decision: "reject" })}
                        className="text-red-400 hover:text-red-300 text-xs px-2 py-0.5 rounded"
                        style={{ background: "oklch(0.5 0.2 20 / 0.15)" }}>驳回</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {(!data?.rows || data.rows.length === 0) && (
              <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">暂无提现记录</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={data?.total ?? 0} pageSize={15} onPage={setPage} />
    </div>
  );
}

/* ─────────────────────────────────────────── Fees Tab ── */
function FeesTab() {
  const { data: markets, refetch } = trpc.admin.listMarkets.useQuery();
  const [editing, setEditing] = useState<string | null>(null);
  const [takerVal, setTakerVal] = useState("");
  const [makerVal, setMakerVal] = useState("");

  const updateFees = trpc.admin.updateMarketFees.useMutation({
    onSuccess: () => { toast.success("手续费已更新"); setEditing(null); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const startEdit = (m: { symbol: string; takerFee: string; makerFee: string }) => {
    setEditing(m.symbol);
    setTakerVal(m.takerFee);
    setMakerVal(m.makerFee);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-muted-foreground px-1">
        手续费以小数表示，0.001 = 0.1%。修改后立即对新订单生效。点击 <Edit2 className="w-3 h-3 inline" /> 编辑，<Save className="w-3 h-3 inline" /> 保存。
      </div>
      <div className={cn(GLASS, "p-0 overflow-hidden")} style={GLASS_STYLE}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-white/5">
              <th className="text-left px-3 py-2">交易对</th>
              <th className="text-right px-3 py-2">Taker 费率</th>
              <th className="text-right px-3 py-2">Maker 费率</th>
              <th className="text-center px-3 py-2">状态</th>
              <th className="text-right px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {(markets ?? []).map((m) => (
              <tr key={m.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                <td className="px-3 py-2 font-medium">{m.symbol}</td>
                <td className="px-3 py-2 text-right font-mono">
                  {editing === m.symbol
                    ? <input value={takerVal} onChange={(e) => setTakerVal(e.target.value)}
                        className="w-20 h-6 px-2 rounded text-right outline-none"
                        style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.62 0.22 262 / 0.4)" }} />
                    : <span className="text-yellow-400">{(Number(m.takerFee) * 100).toFixed(3)}%</span>
                  }
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {editing === m.symbol
                    ? <input value={makerVal} onChange={(e) => setMakerVal(e.target.value)}
                        className="w-20 h-6 px-2 rounded text-right outline-none"
                        style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.62 0.22 262 / 0.4)" }} />
                    : <span className="text-blue-400">{(Number(m.makerFee) * 100).toFixed(3)}%</span>
                  }
                </td>
                <td className="px-3 py-2 text-center">
                  <Badge status={m.isActive ? "confirmed" : "canceled"} />
                </td>
                <td className="px-3 py-2 text-right">
                  {editing === m.symbol ? (
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => updateFees.mutate({ symbol: m.symbol, takerFee: takerVal, makerFee: makerVal })}
                        className="p-1 rounded text-green-400 hover:text-green-300"><Save className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setEditing(null)}
                        className="p-1 rounded text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ) : (
                    <button onClick={() => startEdit(m)} className="p-1 rounded hover:text-primary">
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────── Markets Tab ── */
function MarketsTab() {
  const { data: markets, refetch } = trpc.admin.listMarkets.useQuery();
  const [editing, setEditing] = useState<string | null>(null);
  const [editVals, setEditVals] = useState<MarketEditValues>({
    minNotional: "",
    priceTick: "",
    amountStep: "",
    marketMode: "binance_mirror",
    externalSymbol: "",
    marketDataSource: "binance",
    allowLimitOrder: true,
    allowMarketOrder: true,
    logoUrl: "",
    description: "",
    websiteUrl: "",
    whitepaperUrl: "",
    explorerUrl: "",
    contractAddress: "",
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [createVals, setCreateVals] = useState<CreateMarketValues>(DEFAULT_CREATE_MARKET);

  const createMarket = trpc.admin.createMarket.useMutation({
    onSuccess: () => { toast.success("交易对已创建"); setCreateVals(DEFAULT_CREATE_MARKET); setCreateOpen(false); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const updateMarket = trpc.admin.updateMarket.useMutation({
    onSuccess: () => { toast.success("交易对已更新"); setEditing(null); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className={cn(GLASS, "flex items-center justify-between gap-3")} style={GLASS_STYLE}>
        <div>
          <div className="text-sm font-semibold">交易对与做市管理</div>
          <div className="text-xs text-muted-foreground mt-1">
            支持新增交易对、选择自动做市或订单簿模式、独立开关限价/市价单，并提供明确的上架/下架通道。
          </div>
        </div>
        <Button size="sm" onClick={() => setCreateOpen((v) => !v)} className="gap-1">
          <PlusCircle className="w-4 h-4" /> 新增 / 上架交易对
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className={cn(GLASS, "space-y-1")} style={CARD_STYLE}>
          <div className="font-medium text-blue-300">自动做市（平台流动性）</div>
          <div className="text-muted-foreground">市价单直接由平台流动性成交，后台成交对手方应显示为“平台流动性”。适合跟随主行情通道快速上线交易对。</div>
        </div>
        <div className={cn(GLASS, "space-y-1")} style={CARD_STYLE}>
          <div className="font-medium text-amber-300">订单簿撮合</div>
          <div className="text-muted-foreground">仅依赖站内用户挂单撮合。切换前应确认深度、最小成交额、手续费和撤单释放均已验证。</div>
        </div>
      </div>

      {createOpen && (
        <div className={cn(GLASS, "grid grid-cols-2 gap-3 text-xs")} style={CARD_STYLE}>
          {[
            ["交易对", "symbol", "如 BTCUSDT"],
            ["基础币种", "base", "如 BTC"],
            ["计价币种", "quote", "USDT"],
            ["最小名义额", "minNotional", "5"],
            ["价格步长", "priceTick", "0.01"],
            ["数量步长", "amountStep", "0.0001"],
            ["Taker 费率", "takerFee", "0.001"],
            ["Maker 费率", "makerFee", "0.0008"],
            ["外部标的", "externalSymbol", "默认同交易对"],
            ["Logo URL", "logoUrl", "https://.../logo.png"],
            ["官网", "websiteUrl", "https://..."],
            ["白皮书", "whitepaperUrl", "https://.../whitepaper.pdf"],
            ["区块浏览器", "explorerUrl", "https://..."],
            ["合约地址", "contractAddress", "可选，主链资产可留空"],
          ].map(([label, key, placeholder]) => {
            const isSymbolField = ["symbol", "base", "quote", "externalSymbol"].includes(key);
            const isNumericField = MARKET_NUMERIC_FIELDS.includes(key as (typeof MARKET_NUMERIC_FIELDS)[number]);
            const invalid = isNumericField && !isPositiveDecimalInput((createVals as any)[key]);
            return (
              <label key={key} className="flex flex-col gap-1">
                <span className="text-muted-foreground">{label}</span>
                <input value={(createVals as any)[key]} onChange={(e) => setCreateVals(v => ({ ...v, [key]: isSymbolField ? normalizeMarketSymbol(e.target.value) : e.target.value.trim() }))}
                  placeholder={placeholder} className={cn("h-8 px-2 rounded outline-none", invalid && "border-red-400/70")}
                  style={{ background: "oklch(0.22 0.03 258)", border: invalid ? "1px solid oklch(0.65 0.22 25 / 70%)" : "1px solid oklch(1 0 0 / 10%)" }} />
                {invalid && <span className="text-[10px] text-red-300">请输入大于 0 的有效数字</span>}
              </label>
            );
          })}
          <label className="col-span-2 flex flex-col gap-1">
            <span className="text-muted-foreground">币种介绍</span>
            <textarea value={createVals.description} onChange={(e) => setCreateVals(v => ({ ...v, description: e.target.value }))}
              placeholder="项目定位、核心功能、生态用途等，将展示在交易对资料页" rows={3}
              className="px-2 py-2 rounded outline-none resize-none" style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(1 0 0 / 10%)" }} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">做市模式</span>
            <select value={createVals.marketMode} onChange={(e) => setCreateVals(v => ({ ...v, marketMode: e.target.value as MarketMode }))}
              className="h-8 px-2 rounded outline-none" style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(1 0 0 / 10%)" }}>
              <option value="binance_mirror">{MARKET_MODE_LABEL.binance_mirror}</option>
              <option value="orderbook">{MARKET_MODE_LABEL.orderbook}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">行情源</span>
            <select value={createVals.marketDataSource} onChange={(e) => setCreateVals(v => ({ ...v, marketDataSource: e.target.value as MarketDataSource }))}
              className="h-8 px-2 rounded outline-none" style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(1 0 0 / 10%)" }}>
              <option value="binance">{MARKET_DATA_SOURCE_LABEL.binance}</option>
              <option value="internal">{MARKET_DATA_SOURCE_LABEL.internal}</option>
              <option value="manual">{MARKET_DATA_SOURCE_LABEL.manual}</option>
            </select>
          </label>
          <div className="col-span-2 rounded-xl px-3 py-2 text-[11px] text-muted-foreground" style={{ background: "oklch(0.22 0.03 258 / 0.55)", border: "1px solid oklch(1 0 0 / 8%)" }}>
            {MARKET_MODE_HELP[createVals.marketMode]}
          </div>
          <div className="col-span-2 flex items-center justify-between pt-1">
            <div className="flex items-center gap-4 text-muted-foreground">
              <label className="flex items-center gap-2"><Switch checked={createVals.allowLimitOrder} onCheckedChange={(v) => setCreateVals(s => ({ ...s, allowLimitOrder: v }))} />允许限价单</label>
              <label className="flex items-center gap-2"><Switch checked={createVals.allowMarketOrder} onCheckedChange={(v) => setCreateVals(s => ({ ...s, allowMarketOrder: v }))} />允许市价单</label>
              <label className="flex items-center gap-2"><Switch checked={createVals.isActive} onCheckedChange={(v) => setCreateVals(s => ({ ...s, isActive: v }))} />创建后立即上架</label>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="bg-secondary border-border" onClick={() => setCreateOpen(false)}>取消</Button>
              <Button disabled={createMarket.isPending || !createVals.symbol || createVals.symbol !== `${createVals.base}${createVals.quote}` || MARKET_NUMERIC_FIELDS.some((key) => !isPositiveDecimalInput(createVals[key]))}
                onClick={() => createMarket.mutate({ ...createVals, symbol: normalizeMarketSymbol(createVals.symbol), base: normalizeMarketSymbol(createVals.base), quote: normalizeMarketSymbol(createVals.quote), externalSymbol: createVals.externalSymbol ? normalizeMarketSymbol(createVals.externalSymbol) : undefined })}>
                创建并{createVals.isActive ? "上架" : "保持下架"}
              </Button>
            </div>
          </div>
          {createVals.symbol && createVals.base && createVals.quote && createVals.symbol !== `${createVals.base}${createVals.quote}` && (
            <div className="col-span-2 text-[11px] text-red-300">交易对代码必须等于基础币种 + 计价币种，例如 BTC + USDT = BTCUSDT。</div>
          )}
        </div>
      )}

      <div className={cn(GLASS, "p-0 overflow-hidden")} style={GLASS_STYLE}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-white/5">
              <th className="text-left px-3 py-2">交易对</th>
              <th className="text-right px-3 py-2">最小名义额</th>
              <th className="text-right px-3 py-2">价格步长</th>
              <th className="text-right px-3 py-2">数量步长</th>
              <th className="text-center px-3 py-2">做市模式</th>
              <th className="text-center px-3 py-2">外部标的</th>
              <th className="text-center px-3 py-2">行情源</th>
              <th className="text-center px-3 py-2">限价</th>
              <th className="text-center px-3 py-2">市价</th>
              <th className="text-center px-3 py-2">启用</th>
              <th className="text-right px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {(markets ?? []).map((m) => (
              <>
              <tr key={m.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                <td className="px-3 py-2 font-medium">{m.symbol}</td>
                <td className="px-3 py-2 text-right font-mono">
                  {editing === m.symbol
                    ? <input value={editVals.minNotional} onChange={(e) => setEditVals(v => ({ ...v, minNotional: e.target.value }))}
                        className="w-16 h-6 px-2 rounded text-right outline-none"
                        style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.62 0.22 262 / 0.4)" }} />
                    : m.minNotional
                  }
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {editing === m.symbol
                    ? <input value={editVals.priceTick} onChange={(e) => setEditVals(v => ({ ...v, priceTick: e.target.value }))}
                        className="w-20 h-6 px-2 rounded text-right outline-none"
                        style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.62 0.22 262 / 0.4)" }} />
                    : m.priceTick
                  }
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {editing === m.symbol
                    ? <input value={editVals.amountStep} onChange={(e) => setEditVals(v => ({ ...v, amountStep: e.target.value }))}
                        className="w-20 h-6 px-2 rounded text-right outline-none"
                        style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.62 0.22 262 / 0.4)" }} />
                    : m.amountStep
                  }
                </td>
                <td className="px-3 py-2 text-center">
                  {editing === m.symbol ? (
                    <select value={editVals.marketMode} onChange={(e) => setEditVals(v => ({ ...v, marketMode: e.target.value as MarketMode }))}
                      className="h-6 px-2 rounded outline-none"
                      style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.62 0.22 262 / 0.4)" }}>
                      <option value="binance_mirror">{MARKET_MODE_LABEL.binance_mirror}</option>
                      <option value="orderbook">{MARKET_MODE_LABEL.orderbook}</option>
                    </select>
                  ) : (
                    <span className={cn("px-2 py-0.5 rounded-full border", m.marketMode === "orderbook" ? "text-amber-300 border-amber-300/30" : "text-blue-300 border-blue-300/30")} title={MARKET_MODE_HELP[(m.marketMode ?? "binance_mirror") as MarketMode]}>
                      {MARKET_MODE_LABEL[(m.marketMode ?? "binance_mirror") as MarketMode]}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-center font-mono">
                  {editing === m.symbol
                    ? <input value={editVals.externalSymbol} onChange={(e) => setEditVals(v => ({ ...v, externalSymbol: normalizeMarketSymbol(e.target.value) }))}
                        className="w-24 h-6 px-2 rounded text-center outline-none"
                        style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.62 0.22 262 / 0.4)" }} />
                    : (m.externalSymbol ?? m.symbol)
                  }
                </td>
                <td className="px-3 py-2 text-center">
                  {editing === m.symbol ? (
                    <select value={editVals.marketDataSource} onChange={(e) => setEditVals(v => ({ ...v, marketDataSource: e.target.value as MarketDataSource }))}
                      className="h-6 px-2 rounded outline-none"
                      style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.62 0.22 262 / 0.4)" }}>
                      <option value="binance">{MARKET_DATA_SOURCE_LABEL.binance}</option>
                      <option value="internal">{MARKET_DATA_SOURCE_LABEL.internal}</option>
                      <option value="manual">{MARKET_DATA_SOURCE_LABEL.manual}</option>
                    </select>
                  ) : (MARKET_DATA_SOURCE_LABEL[(m.marketDataSource ?? "binance") as MarketDataSource] ?? MARKET_DATA_SOURCE_LABEL.binance)}
                </td>
                <td className="px-3 py-2 text-center">
                  {editing === m.symbol
                    ? <Switch checked={editVals.allowLimitOrder} onCheckedChange={(checked) => setEditVals(v => ({ ...v, allowLimitOrder: checked }))} />
                    : <Badge status={m.allowLimitOrder === false ? "canceled" : "confirmed"} />
                  }
                </td>
                <td className="px-3 py-2 text-center">
                  {editing === m.symbol
                    ? <Switch checked={editVals.allowMarketOrder} onCheckedChange={(checked) => setEditVals(v => ({ ...v, allowMarketOrder: checked }))} />
                    : <Badge status={m.allowMarketOrder === false ? "canceled" : "confirmed"} />
                  }
                </td>
                <td className="px-3 py-2 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <Switch checked={m.isActive}
                      onCheckedChange={() => updateMarket.mutate({ symbol: m.symbol, isActive: !m.isActive })} />
                    <button
                      disabled={updateMarket.isPending}
                      onClick={() => updateMarket.mutate({ symbol: m.symbol, isActive: !m.isActive })}
                      className={cn("px-2 py-0.5 rounded-full border text-[11px]", m.isActive ? "text-red-300 border-red-300/30 hover:bg-red-400/10" : "text-green-300 border-green-300/30 hover:bg-green-400/10")}
                      title={m.isActive ? "下架后用户端不再允许新下单，历史订单和成交保留" : "上架后用户端可见并允许按配置下单"}
                    >
                      {m.isActive ? "下架" : "上架"}
                    </button>
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  {editing === m.symbol ? (
                    <div className="flex items-center justify-end gap-1">
                      <button disabled={!isPositiveDecimalInput(editVals.minNotional) || !isPositiveDecimalInput(editVals.priceTick) || !isPositiveDecimalInput(editVals.amountStep)}
                        onClick={() => updateMarket.mutate({ symbol: m.symbol, ...editVals, externalSymbol: editVals.externalSymbol ? normalizeMarketSymbol(editVals.externalSymbol) : m.symbol })}
                        className="p-1 rounded text-green-400 disabled:opacity-30"><Save className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setEditing(null)}
                        className="p-1 rounded text-muted-foreground"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ) : (
                    <button onClick={() => {
                      setEditing(m.symbol);
                      setEditVals({
                        minNotional: m.minNotional,
                        priceTick: m.priceTick,
                        amountStep: m.amountStep,
                        marketMode: m.marketMode ?? "binance_mirror",
                        externalSymbol: m.externalSymbol ?? m.symbol,
                        marketDataSource: m.marketDataSource ?? "binance",
                        allowLimitOrder: m.allowLimitOrder !== false,
                        allowMarketOrder: m.allowMarketOrder !== false,
                        logoUrl: m.logoUrl ?? "",
                        description: m.description ?? "",
                        websiteUrl: m.websiteUrl ?? "",
                        whitepaperUrl: m.whitepaperUrl ?? "",
                        explorerUrl: m.explorerUrl ?? "",
                        contractAddress: m.contractAddress ?? "",
                      });
                    }} className="p-1 rounded hover:text-primary"><Edit2 className="w-3.5 h-3.5" /></button>
                  )}
                </td>
              </tr>
              {editing === m.symbol && (
                <tr className="border-b border-white/5 bg-white/[0.025]">
                  <td colSpan={11} className="px-3 py-3">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      {([
                        ["Logo URL", "logoUrl", "https://.../logo.png"],
                        ["官网", "websiteUrl", "https://..."],
                        ["白皮书", "whitepaperUrl", "https://.../whitepaper.pdf"],
                        ["区块浏览器", "explorerUrl", "https://..."],
                        ["合约地址", "contractAddress", "可选，主链资产可留空"],
                      ] as const).map(([label, key, placeholder]) => (
                        <label key={key} className="flex flex-col gap-1">
                          <span className="text-muted-foreground">{label}</span>
                          <input value={editVals[key]} onChange={(e) => setEditVals(v => ({ ...v, [key]: e.target.value.trim() }))}
                            placeholder={placeholder} className="h-8 px-2 rounded outline-none"
                            style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.62 0.22 262 / 0.4)" }} />
                        </label>
                      ))}
                      <label className="col-span-2 flex flex-col gap-1">
                        <span className="text-muted-foreground">币种介绍</span>
                        <textarea value={editVals.description} onChange={(e) => setEditVals(v => ({ ...v, description: e.target.value }))}
                          rows={3} placeholder="项目定位、核心功能、生态用途等，将展示在交易对资料页"
                          className="px-2 py-2 rounded outline-none resize-none"
                          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.62 0.22 262 / 0.4)" }} />
                      </label>
                    </div>
                  </td>
                </tr>
              )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────── Audit Tab ── */
function AuditTab() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const { data } = trpc.admin.getAdminLogs.useQuery(
    { page, pageSize: 20, action: action || undefined },
    { placeholderData: (p) => p }
  );
  const { data: alerts } = trpc.admin.riskAlerts.useQuery(undefined, { refetchInterval: 10000 });
  const { data: balances } = trpc.admin.balanceSnapshot.useQuery(undefined, { refetchInterval: 10000 });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-semibold mb-2">运营风险提醒</div>
        <div className="flex flex-col gap-2">
          {(alerts ?? []).map((a, i) => (
            <div key={i} className={cn("px-3 py-2 rounded-xl text-xs", a.level === "critical" ? "text-red-300" : a.level === "high" ? "text-yellow-300" : "text-muted-foreground")}
              style={{ background: "oklch(0.17 0.035 258 / 0.7)", border: "1px solid oklch(1 0 0 / 9%)" }}>
              <span className="font-semibold mr-2">{a.level.toUpperCase()}</span>{a.message}
            </div>
          ))}
          {(!alerts || alerts.length === 0) && <div className="text-xs text-muted-foreground px-1">暂无高优先级风险提醒</div>}
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold mb-2">平台资产快照</div>
        <div className={cn(GLASS, "p-0 overflow-hidden")} style={GLASS_STYLE}>
          <table className="w-full text-xs">
            <thead><tr className="text-muted-foreground border-b border-white/5"><th className="text-left px-3 py-2">资产</th><th className="text-right px-3 py-2">可用合计</th><th className="text-right px-3 py-2">冻结合计</th><th className="text-right px-3 py-2">账户数</th></tr></thead>
            <tbody>
              {(balances ?? []).map((b) => <tr key={b.asset} className="border-b border-white/5 last:border-0"><td className="px-3 py-2 font-medium">{b.asset}</td><td className="px-3 py-2 text-right font-mono">{fmtAmount(b.totalAvailable ?? "0")}</td><td className="px-3 py-2 text-right font-mono">{fmtAmount(b.totalLocked ?? "0")}</td><td className="px-3 py-2 text-right">{b.accountCount}</td></tr>)}
              {(!balances || balances.length === 0) && <tr><td colSpan={4} className="text-center py-6 text-muted-foreground">暂无资产数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="flex gap-2 mb-2">
          <input value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} placeholder="按操作类型过滤，如 update_market" className="flex-1 h-9 px-3 rounded-xl text-xs outline-none"
            style={{ background: "oklch(0.17 0.035 258 / 0.7)", border: "1px solid oklch(1 0 0 / 9%)" }} />
        </div>
        <div className={cn(GLASS, "p-0 overflow-hidden")} style={GLASS_STYLE}>
          <table className="w-full text-xs">
            <thead><tr className="text-muted-foreground border-b border-white/5"><th className="text-left px-3 py-2">时间</th><th className="text-left px-3 py-2">管理员</th><th className="text-left px-3 py-2">操作</th><th className="text-left px-3 py-2">对象</th><th className="text-left px-3 py-2">备注</th></tr></thead>
            <tbody>
              {(data?.rows ?? []).map((l) => <tr key={l.id} className="border-b border-white/5 last:border-0 hover:bg-white/5"><td className="px-3 py-2 text-muted-foreground">{new Date(l.createdAt).toLocaleString("zh-CN")}</td><td className="px-3 py-2">{l.adminName ?? l.adminId}</td><td className="px-3 py-2 font-mono text-primary">{l.action}</td><td className="px-3 py-2 text-muted-foreground">{l.targetType ?? "—"}:{l.targetId ?? "—"}</td><td className="px-3 py-2 text-muted-foreground">{l.note ?? "—"}</td></tr>)}
              {(!data?.rows || data.rows.length === 0) && <tr><td colSpan={5} className="text-center py-8 text-muted-foreground">暂无审计日志</td></tr>}
            </tbody>
          </table>
        </div>
        <Pagination page={page} total={data?.total ?? 0} pageSize={20} onPage={setPage} />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────── System Tab ── */
function SystemTab() {
  const { data: hedge, refetch: refetchHedge } = trpc.admin.getPlatformMode.useQuery();
  const setHedge = trpc.admin.setPlatformMode.useMutation({
    onSuccess: () => { toast.success("已更新风险覆盖模式"); refetchHedge(); },
    onError: (e: { message: string }) => toast.error(e.message),
  });
  const { data: hedgeLog } = trpc.admin.hedgeLog.useQuery(undefined, { refetchInterval: 5000 });
  const { data: sources } = trpc.admin.marketSources.useQuery(undefined, { refetchInterval: 5000 });

  const hedged = hedge?.mode === "hedged";

  const channelLabel = (venue?: string) => {
    const v = (venue ?? "").toLowerCase();
    if (v.includes("binance")) return "主通道";
    if (v.includes("okx")) return "备用通道";
    if (v.includes("hyper")) return "聚合通道";
    return venue || "平台通道";
  };

  const srcRow = (label: string, live: boolean) => (
    <div className="flex items-center justify-between px-3 py-2 rounded-xl"
      style={{ background: "oklch(0.22 0.03 258)" }}>
      <span className="text-sm font-medium">{label}</span>
      <span className={cn("text-xs font-mono px-2 py-0.5 rounded", live ? "text-green-400 bg-green-400/10" : "text-muted-foreground bg-secondary")}>
        {live ? "LIVE" : "offline"}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className={cn(GLASS)} style={GLASS_STYLE}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold">风险覆盖模式</div>
            <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
              开启后，平台会对指定交易对执行自动化风险覆盖和头寸管理，降低单边敞口风险。
            </div>
            <div className={cn("mt-2 text-xs font-medium", hedged ? "text-green-400" : "text-muted-foreground")}>
              当前：{hedged ? "自动覆盖已开启" : "内部撮合优先"}
            </div>
          </div>
          <Switch checked={hedged} onCheckedChange={(v) => setHedge.mutate({ mode: v ? "hedged" : "internal_only" })} />
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold mb-2">行情通道状态</div>
        <div className="flex flex-col gap-1.5">
          {srcRow("主行情通道", sources?.binance ?? false)}
          {srcRow("备用行情通道", sources?.okx ?? false)}
          {srcRow("聚合行情通道", sources?.hyperliquid ?? false)}
          <div className="text-xs text-muted-foreground px-1">
            已观测符号：{sources?.distinctSourcesSeen.length ?? 0} 个
          </div>
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold mb-2">风险覆盖日志（最近 100 条）</div>
        <div className={cn(GLASS, "p-2 max-h-56 overflow-auto")} style={GLASS_STYLE}>
          {(hedgeLog ?? []).map((h, i) => (
            <div key={i} className="text-xs font-mono py-0.5 flex gap-2">
              <span className="text-muted-foreground shrink-0">{new Date(h.ts).toLocaleTimeString()}</span>
              <span className={h.side === "buy" ? "text-green-400" : "text-red-400"}>{h.side.toUpperCase()}</span>
              <span>{h.symbol}</span>
              <span className="text-muted-foreground">qty={h.quantity} @{h.price} → {channelLabel(h.venue)}</span>
            </div>
          ))}
          {(!hedgeLog || hedgeLog.length === 0) && (
            <div className="text-center py-4 text-muted-foreground text-xs">暂无风险覆盖记录</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────── Main Admin Page ── */
type Tab = "overview" | "users" | "orders" | "deposits" | "withdrawals" | "fees" | "markets" | "audit" | "system";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "概览", icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: "users", label: "用户", icon: <Users className="w-4 h-4" /> },
  { id: "orders", label: "订单", icon: <ClipboardList className="w-4 h-4" /> },
  { id: "deposits", label: "充值", icon: <ArrowDownToLine className="w-4 h-4" /> },
  { id: "withdrawals", label: "提现", icon: <ArrowUpFromLine className="w-4 h-4" /> },
  { id: "fees", label: "手续费", icon: <Percent className="w-4 h-4" /> },
  { id: "markets", label: "交易对/做市", icon: <BarChart2 className="w-4 h-4" /> },
  { id: "audit", label: "审计", icon: <FileSearch className="w-4 h-4" /> },
  { id: "system", label: "系统", icon: <Settings className="w-4 h-4" /> },
];

export default function Admin() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");

  if (!loading && user?.role !== "admin") {
    return (
      <div className="w-full px-4 pt-10 text-center">
        <Shield className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
        <div className="text-muted-foreground text-sm">仅管理员可访问此页面</div>
        <Link href="/me">
          <Button variant="outline" className="mt-4 bg-secondary border-border">返回</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col min-h-screen">
      {/* Header */}
      <header className="flex items-center gap-2 px-4 pt-3 pb-3 shrink-0"
        style={{ borderBottom: "1px solid oklch(1 0 0 / 7%)" }}>
        <Link href="/me">
          <button className="p-1.5 -ml-1.5 rounded-xl text-muted-foreground hover:text-foreground transition-colors"
            style={{ background: "oklch(0.17 0.035 258 / 0.5)" }}>
            <ChevronLeft className="w-5 h-5" />
          </button>
        </Link>
        <Shield className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-semibold">平台管理后台</h1>
        <div className="ml-auto text-xs text-muted-foreground">
          {user?.name ?? user?.email}
        </div>
      </header>

      {/* Tab bar */}
      <div className="flex overflow-x-auto gap-1 px-3 py-2 shrink-0 scrollbar-none"
        style={{ borderBottom: "1px solid oklch(1 0 0 / 7%)" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all",
              tab === t.id ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            style={tab === t.id ? { background: "oklch(0.62 0.22 262)" } : { background: "oklch(0.17 0.035 258 / 0.5)" }}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24">
        {tab === "overview" && <OverviewTab />}
        {tab === "users" && <UsersTab />}
        {tab === "orders" && <OrdersTab />}
        {tab === "deposits" && <DepositsTab />}
        {tab === "withdrawals" && <WithdrawalsTab />}
        {tab === "fees" && <FeesTab />}
        {tab === "markets" && <MarketsTab />}
        {tab === "audit" && <AuditTab />}
        {tab === "system" && <SystemTab />}
      </div>
    </div>
  );
}
