/**
 * AdminPanel — Full-page enterprise admin dashboard at /admin-panel
 * Sections: overview | users | orders | trades | deposits | withdrawals | ledger | fees | markets | apiKeys | risk | system | logs
 */
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "../_core/hooks/useAuth";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────
type Section =
  | "overview" | "users" | "orders" | "trades" | "deposits"
  | "withdrawals" | "ledger" | "fees" | "markets" | "apiKeys" | "risk" | "system" | "logs";
type MarketMode = "binance_mirror" | "orderbook";
type MarketDataSource = "binance" | "internal" | "manual";
type RefExchange = "binance" | "okx" | "bybit" | "manual";
type KlineFollowMode = "scaled" | "synthetic";
type MarketEditValues = {
  minNotional: string;
  priceTick: string;
  amountStep: string;
  marketMode: MarketMode;
  externalSymbol: string;
  marketDataSource: MarketDataSource;
  refExchange: RefExchange;
  priceRatio: string;
  priceOffset: string;
  spreadPct: string;
  maxDepthLevels: string;
  updateIntervalSec: string;
  maxPriceJumpPct: string;
  klineFollowMode: KlineFollowMode;
  allowRealTrade: boolean;
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
  refExchange: "binance",
  priceRatio: "1",
  priceOffset: "0",
  spreadPct: "0.002",
  maxDepthLevels: "15",
  updateIntervalSec: "3",
  maxPriceJumpPct: "0.05",
  klineFollowMode: "scaled",
  allowRealTrade: true,
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
  binance_mirror: "市价单直接由平台流动性成交，限价单可按行情触发或进入委托簿。适合跟随主行情通道快速上线交易对。",
  orderbook: "完全依赖站内买卖委托撮合。切换前应确认深度、最小成交额、手续费和撤单释放均已验证。",
};
const MARKET_DATA_SOURCE_LABEL: Record<MarketDataSource, string> = {
  binance: "主行情通道",
  internal: "内部行情",
  manual: "手动维护",
};
const REF_EXCHANGE_LABEL: Record<RefExchange, string> = {
  binance: "Binance 参考价",
  okx: "OKX 参考价",
  bybit: "Bybit 参考价",
  manual: "手动参考价",
};
const KLINE_FOLLOW_LABEL: Record<KlineFollowMode, string> = {
  scaled: "跟随参考 K 线并按倍率缩放",
  synthetic: "独立合成 K 线",
};
const MARKET_NUMERIC_FIELDS = ["minNotional", "priceTick", "amountStep", "takerFee", "makerFee", "priceRatio"] as const;
const MARKET_NON_NEGATIVE_FIELDS = ["priceOffset", "spreadPct", "maxPriceJumpPct"] as const;
const normalizeMarketSymbol = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
const isPositiveDecimalInput = (value: string) => /^\d+(?:\.\d+)?$/.test(value.trim()) && Number(value) > 0;
const isNonNegativeDecimalInput = (value: string) => /^\d+(?:\.\d+)?$/.test(value.trim()) && Number(value) >= 0;
const isPositiveIntInput = (value: string, min = 1, max = Number.MAX_SAFE_INTEGER) => /^\d+$/.test(value.trim()) && Number(value) >= min && Number(value) <= max;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (v: string | number | null | undefined, decimals = 2) => {
  const n = Number(v ?? 0);
  if (isNaN(n)) return "0";
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};
const fmtDate = (d: Date | string | null | undefined) => {
  if (!d) return "—";
  return new Date(d).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
};
const splitSymbolUnits = (symbol: string | null | undefined) => {
  const value = String(symbol ?? "").toUpperCase();
  const knownQuotes = ["USDT", "USDC", "BUSD", "USD", "BTC", "ETH", "BNB"];
  const quote = knownQuotes.find((asset) => value.endsWith(asset) && value.length > asset.length) ?? "";
  return { base: quote ? value.slice(0, -quote.length) : value, quote };
};
const withUnit = (value: string, unit: string) => unit ? `${value} ${unit}` : value;
const orderQuantityUnit = (order: { symbol?: string | null; side?: string | null; type?: string | null }) => {
  const { base, quote } = splitSymbolUnits(order.symbol);
  return order.type === "market" && order.side === "buy" ? quote : base;
};
const statusColor: Record<string, string> = {
  new: "#60a5fa", partial: "#f59e0b", filled: "#4ade80", canceled: "#6b7280",
  rejected: "#f87171", pending: "#f59e0b", reviewing: "#a78bfa",
  approved: "#4ade80", confirmed: "#34d399", failed: "#f87171",
  confirmed_onchain: "#34d399", broadcasting: "#60a5fa",
};

const REASON_LABELS: Record<string, string> = {
  trade_fill: "成交入账",
  order_freeze: "订单冻结",
  order_unfreeze: "订单解冻",
  admin_adjust: "管理员调整",
  deposit: "充值到账",
  withdrawal: "提现扣减",
  transfer_in: "划转转入",
  transfer_out: "划转转出",
  trade_fee: "手续费",
};
const REF_TABLE_LABELS: Record<string, string> = {
  orders: "订单",
  deposits: "充值",
  withdrawals: "提现",
  trades: "成交",
  transfers: "划转",
  users: "用户",
};

const ACTION_LABELS: Record<string, string> = {
  ban_user: "封禁用户",
  unban_user: "解封用户",
  set_user_role: "修改用户角色",
  adjust_balance: "调整账户余额",
  simulate_deposit: "运营入账",
  force_cancel_order: "强制撤单",
  bulk_cancel_orders: "批量撤单",
  approve_withdrawal: "批准提现",
  reject_withdrawal: "驳回提现",
  update_market_fees: "修改手续费设置",
  update_market: "修改交易对配置",
  set_platform_mode: "切换平台模式",
  revoke_api_key: "撤销 API Key",
};
const TARGET_TYPE_LABELS: Record<string, string> = {
  user: "用户",
  order: "订单",
  withdrawal: "提现申请",
  market: "交易对",
  platform: "平台",
  api_key: "API Key",
};
function formatLogChange(val: unknown): React.ReactNode {
  if (val === null || val === undefined) return <span className="text-gray-600">—</span>;
  if (typeof val === "object") {
    const entries = Object.entries(val as Record<string, unknown>);
    return (
      <div className="flex flex-col gap-0.5">
        {entries.map(([k, v]) => (
          <span key={k} className="text-xs">
            <span className="text-gray-500">{k}:</span>{" "}
            <span className="text-gray-200">{String(v)}</span>
          </span>
        ))}
      </div>
    );
  }
  return <span>{String(val)}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const color = statusColor[status] ?? "#9ca3af";
  const labels: Record<string, string> = {
    new: "待成交", partial: "部分成交", filled: "已成交", canceled: "已撤销",
    rejected: "已拒绝", pending: "待审核", reviewing: "审核中",
    approved: "已批准", confirmed: "已确认", failed: "失败",
    confirmed_onchain: "链上确认", broadcasting: "广播中",
  };
  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ background: color + "22", color }}>
      {labels[status] ?? status}
    </span>
  );
}

function KpiCard({ label, value, sub, color = "#60a5fa" }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl p-4 flex flex-col gap-1" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-2xl font-bold font-mono" style={{ color }}>{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

function Pagination({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (p: number) => void }) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center gap-2 justify-end mt-3 text-xs text-gray-400">
      <span>共 {total} 条</span>
      <button disabled={page <= 1} onClick={() => onChange(page - 1)}
        className="px-2 py-1 rounded disabled:opacity-30" style={{ background: "oklch(0.22 0.03 258)" }}>上一页</button>
      <span>{page} / {totalPages}</span>
      <button disabled={page >= totalPages} onClick={() => onChange(page + 1)}
        className="px-2 py-1 rounded disabled:opacity-30" style={{ background: "oklch(0.22 0.03 258)" }}>下一页</button>
    </div>
  );
}

// ─── Section: Overview ────────────────────────────────────────────────────────
function OverviewSection() {
  const [chartDays, setChartDays] = useState(7);
  const { data: stats, isLoading } = trpc.admin.overview.useQuery(undefined, { refetchInterval: 30000 });
  const { data: chart } = trpc.admin.revenueChart.useQuery({ days: chartDays }, { refetchInterval: 60000 });
  const { data: growth } = trpc.admin.userGrowth.useQuery({ days: chartDays });
  const { data: topTraders } = trpc.admin.topTraders.useQuery({ limit: 10 });
  const { data: alerts } = trpc.admin.riskAlerts.useQuery(undefined, { refetchInterval: 30000 });

  const chartData = useMemo(() => {
    if (!chart) return [];
    return chart.map((r) => ({ day: r.day, 交易量: Number(r.volume).toFixed(0), 手续费: Number(r.feeIncome).toFixed(2), 成交笔数: r.tradeCount }));
  }, [chart]);

  const growthData = useMemo(() => {
    if (!growth) return [];
    return growth.map((r) => ({ day: r.day, 新增用户: r.newUsers }));
  }, [growth]);

  if (isLoading) return <div className="text-gray-400 p-8">加载中...</div>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">平台概览</h2>
        <div className="text-xs text-gray-400">每30秒自动刷新</div>
      </div>

      {/* Risk alerts */}
      {alerts && alerts.length > 0 && (
        <div className="flex flex-col gap-2">
          {alerts.map((a, i) => (
            <div key={i} className="flex items-start gap-3 px-4 py-3 rounded-lg text-sm"
              style={{ background: a.level === "critical" ? "#7f1d1d33" : a.level === "high" ? "#78350f33" : "#1e3a5f33", border: `1px solid ${a.level === "critical" ? "#f87171" : a.level === "high" ? "#f59e0b" : "#60a5fa"}44` }}>
              <span style={{ color: a.level === "critical" ? "#f87171" : a.level === "high" ? "#f59e0b" : "#60a5fa" }}>
                {a.level === "critical" ? "🔴" : a.level === "high" ? "🟠" : "🔵"}
              </span>
              <span className="text-gray-200">{a.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* KPI cards - Today highlights */}
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-1">今日实时数据</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="今日新增用户" value={stats?.todayNewUsers ?? 0} sub={`累计 ${stats?.totalUsers ?? 0} 人`} color="#60a5fa" />
          <KpiCard label="今日成交笔数" value={stats?.todayTrades ?? 0} sub={`成交额 $${fmt(stats?.todayVolume)}`} color="#4ade80" />
          <KpiCard label="今日手续费收入" value={`$${fmt(stats?.todayFeeIncome)}`} sub={`24h $${fmt(stats?.feeIncome24h)}`} color="#f59e0b" />
          <KpiCard label="待审核提现" value={stats?.pendingWithdrawals ?? 0} sub="需要处理" color={(stats?.pendingWithdrawals ?? 0) > 0 ? "#f87171" : "#4ade80"} />
        </div>
      </div>
      {/* KPI cards - Platform totals */}
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-1">平台累计数据</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="总用户数" value={stats?.totalUsers ?? 0} sub={`活跃(24h) ${stats?.activeUsers24h ?? 0} 人`} color="#60a5fa" />
          <KpiCard label="总成交笔数" value={stats?.totalTrades ?? 0} sub={`总成交额 $${fmt(stats?.totalVolume)}`} color="#34d399" />
          <KpiCard label="累计手续费收入" value={`$${fmt(stats?.totalFeeIncome)}`} sub={(stats?.feeByAsset ?? []).map((a) => `${a.asset} ${fmt(a.total, 4)}`).join("  |  ") || "暂无数据"} color="#f59e0b" />
          <KpiCard label="活跃挂单" value={stats?.openOrders ?? 0} sub={`总订单 ${stats?.totalOrders ?? 0}`} color="#a78bfa" />
        </div>
      </div>

      {/* Charts */}
      <div className="flex items-center gap-3 mb-1">
        <span className="text-sm text-gray-400">图表周期：</span>
        {[7, 14, 30].map((d) => (
          <button key={d} onClick={() => setChartDays(d)}
            className="px-3 py-1 rounded text-xs font-medium transition-colors"
            style={{ background: chartDays === d ? "oklch(0.62 0.22 262)" : "oklch(0.22 0.03 258)", color: chartDays === d ? "#fff" : "#9ca3af" }}>
            {d}天
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
          <div className="text-sm font-medium text-gray-300 mb-3">交易量 & 手续费趋势</div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#60a5fa" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#60a5fa" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="feeGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
              <XAxis dataKey="day" tick={{ fill: "#6b7280", fontSize: 10 }} />
              <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} />
              <Tooltip contentStyle={{ background: "#1e2a3a", border: "1px solid #334155", color: "#e2e8f0" }} />
              <Legend />
              <Area type="monotone" dataKey="交易量" stroke="#60a5fa" fill="url(#volGrad)" strokeWidth={2} />
              <Area type="monotone" dataKey="手续费" stroke="#f59e0b" fill="url(#feeGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-xl p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
          <div className="text-sm font-medium text-gray-300 mb-3">用户增长趋势</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={growthData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
              <XAxis dataKey="day" tick={{ fill: "#6b7280", fontSize: 10 }} />
              <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} />
              <Tooltip contentStyle={{ background: "#1e2a3a", border: "1px solid #334155", color: "#e2e8f0" }} />
              <Bar dataKey="新增用户" fill="#4ade80" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top traders */}
      {topTraders && topTraders.length > 0 && (
        <div className="rounded-xl p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
          <div className="text-sm font-medium text-gray-300 mb-3">Top 10 交易员（按成交量）</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-white/10">
                  <th className="text-left py-2 px-3">排名</th>
                  <th className="text-left py-2 px-3">用户</th>
                  <th className="text-right py-2 px-3">成交量 (USDT)</th>
                  <th className="text-right py-2 px-3">成交笔数</th>
                </tr>
              </thead>
              <tbody>
                {topTraders.map((t, i) => (
                  <tr key={t.userId} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-2 px-3 font-bold" style={{ color: i < 3 ? "#f59e0b" : "#6b7280" }}>#{i + 1}</td>
                    <td className="py-2 px-3 text-gray-300">{t.name || t.email || `用户${t.userId}`}</td>
                    <td className="py-2 px-3 text-right font-mono text-green-400">${fmt(t.volume)}</td>
                    <td className="py-2 px-3 text-right text-gray-400">{t.tradeCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Section: Users ───────────────────────────────────────────────────────────
function UsersSection() {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "user" | "admin">("all");
  const [banFilter, setBanFilter] = useState<"all" | "active" | "banned">("all");
  const [selectedUser, setSelectedUser] = useState<number | null>(null);
  const [showAdjust, setShowAdjust] = useState(false);
  const [adjustAsset, setAdjustAsset] = useState("USDT");
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("管理员调整");
  const [showDeposit, setShowDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState("100");
  const [depositAsset, setDepositAsset] = useState("");
  const [depositChain, setDepositChain] = useState<"erc20" | "bep20">("erc20");
  const [bulkSelected, setBulkSelected] = useState<number[]>([]);
  const [showBulkBan, setShowBulkBan] = useState(false);
  const [bulkBanReason, setBulkBanReason] = useState("");

  const { data, isLoading } = trpc.admin.listUsers.useQuery(
    { page, pageSize: 20, search: search || undefined, role: roleFilter, banned: banFilter === "all" ? undefined : banFilter === "banned" }
  );
  const { data: detail } = trpc.admin.getUserDetail.useQuery(
    { userId: selectedUser! },
    { enabled: selectedUser !== null }
  );

  const setRole = trpc.admin.setUserRole.useMutation({
    onSuccess: () => { toast.success("角色已更新"); utils.admin.listUsers.invalidate(); utils.admin.getUserDetail.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const banUser = trpc.admin.banUser.useMutation({
    onSuccess: () => { toast.success("操作成功"); utils.admin.listUsers.invalidate(); utils.admin.getUserDetail.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const adjustBalance = trpc.admin.adjustBalance.useMutation({
    onSuccess: (r) => { toast.success(`余额已调整 ${r.delta}`); setShowAdjust(false); setAdjustDelta(""); utils.admin.getUserDetail.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const simulateDeposit = trpc.admin.simulateDeposit.useMutation({
    onSuccess: () => { toast.success("入账处理成功"); setShowDeposit(false); utils.admin.getUserDetail.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const bulkBanUsers = trpc.admin.bulkBanUsers.useMutation({
    onSuccess: (r) => {
      const ok = r.results.filter((x) => x.ok).length;
      toast.success(`批量操作完成: ${ok}/${r.results.length} 成功`);
      setBulkSelected([]);
      setShowBulkBan(false);
      setBulkBanReason("");
      utils.admin.listUsers.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const { data: userLedger } = trpc.admin.getUserLedger.useQuery(
    { userId: selectedUser!, limit: 20 },
    { enabled: selectedUser !== null }
  );

  return (
    <div className="flex gap-4 h-full">
      {/* User list */}
      <div className="flex-1 flex flex-col gap-4 min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-xl font-bold text-white">用户管理</h2>
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="搜索用户名/邮箱/钱包地址..."
            className="flex-1 min-w-48 px-3 py-1.5 rounded-lg text-sm text-white placeholder-gray-500 outline-none"
            style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
          <select value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value as any); setPage(1); }}
            className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
            style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }}>
            <option value="all">全部角色</option>
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
          <select value={banFilter} onChange={(e) => { setBanFilter(e.target.value as any); setPage(1); }}
            className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
            style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }}>
            <option value="all">全部状态</option>
            <option value="active">正常</option>
            <option value="banned">已封禁</option>
          </select>
          {bulkSelected.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">已选 {bulkSelected.length} 人</span>
              <button onClick={() => setShowBulkBan(true)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white"
                style={{ background: "#7f1d1d" }}>
                批量封禁
              </button>
              <button onClick={() => bulkBanUsers.mutate({ userIds: bulkSelected, ban: false })}
                disabled={bulkBanUsers.isPending}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50"
                style={{ background: "oklch(0.28 0.08 142)" }}>
                批量解封
              </button>
              <button onClick={() => setBulkSelected([])}
                className="px-3 py-1.5 rounded-lg text-xs text-gray-400"
                style={{ background: "oklch(0.22 0.03 258)" }}>
                取消选择
              </button>
            </div>
          )}
        </div>
        {showBulkBan && (
          <div className="rounded-xl p-3 text-xs flex items-center gap-3" style={{ background: "#7f1d1d22", border: "1px solid #f8717144" }}>
            <span className="text-red-400 font-medium">封禁原因:</span>
            <input value={bulkBanReason} onChange={(e) => setBulkBanReason(e.target.value)}
              placeholder="输入封禁原因..."
              className="flex-1 px-2 py-1 rounded text-white outline-none"
              style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
            <button onClick={() => bulkBanUsers.mutate({ userIds: bulkSelected, ban: true, reason: bulkBanReason || undefined })}
              disabled={bulkBanUsers.isPending}
              className="px-3 py-1 rounded text-xs font-medium text-white disabled:opacity-50"
              style={{ background: "#7f1d1d" }}>
              {bulkBanUsers.isPending ? "处理中..." : "确认封禁"}
            </button>
            <button onClick={() => setShowBulkBan(false)} className="px-3 py-1 rounded text-xs text-gray-400" style={{ background: "oklch(0.22 0.03 258)" }}>取消</button>
          </div>
        )}

        <div className="rounded-xl overflow-hidden" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-white/10">
                  <th className="py-3 px-3 w-8">
                    <input type="checkbox" onChange={(e) => {
                      if (e.target.checked) setBulkSelected((data?.rows ?? []).map((u) => u.id));
                      else setBulkSelected([]);
                    }} checked={bulkSelected.length > 0 && bulkSelected.length === (data?.rows ?? []).length} />
                  </th>
                  <th className="text-left py-3 px-3">ID</th>
                  <th className="text-left py-3 px-3">用户名</th>
                  <th className="text-left py-3 px-3">邮箱</th>
                  <th className="text-left py-3 px-3">角色</th>
                  <th className="text-left py-3 px-3">状态</th>
                  <th className="text-left py-3 px-3">注册时间</th>
                  <th className="text-left py-3 px-3">最后登录</th>
                  <th className="text-left py-3 px-3">操作</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={8} className="text-center py-8 text-gray-500">加载中...</td></tr>
                )}
                {data?.rows.map((u) => (
                  <tr key={u.id}
                    className="border-b border-white/5 hover:bg-white/5 cursor-pointer transition-colors"
                    style={{ background: selectedUser === u.id ? "oklch(0.22 0.03 258)" : undefined }}
                    onClick={() => setSelectedUser(u.id)}>
                    <td className="py-2 px-3" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={bulkSelected.includes(u.id)}
                        onChange={() => setBulkSelected((prev) => prev.includes(u.id) ? prev.filter((x) => x !== u.id) : [...prev, u.id])} />
                    </td>
                    <td className="py-2 px-3 text-gray-400 font-mono">{u.id}</td>
                    <td className="py-2 px-3 text-white font-medium">{u.name ?? "—"}</td>
                    <td className="py-2 px-3 text-gray-400">{u.email ?? "—"}</td>
                    <td className="py-2 px-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${u.role === "admin" ? "bg-purple-900/50 text-purple-300" : "bg-blue-900/30 text-blue-300"}`}>
                        {u.role === "admin" ? "管理员" : "用户"}
                      </span>
                    </td>
                    <td className="py-2 px-3">
                      {u.isBanned
                        ? <span className="px-2 py-0.5 rounded text-xs bg-red-900/40 text-red-400">已封禁</span>
                        : <span className="px-2 py-0.5 rounded text-xs bg-green-900/30 text-green-400">正常</span>}
                    </td>
                    <td className="py-2 px-3 text-gray-500">{fmtDate(u.createdAt).split(" ")[0]}</td>
                    <td className="py-2 px-3 text-gray-500">{fmtDate(u.lastSignedIn).split(" ")[0]}</td>
                    <td className="py-2 px-3">
                      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => setRole.mutate({ userId: u.id, role: u.role === "admin" ? "user" : "admin" })}
                          className="px-2 py-0.5 rounded text-xs" style={{ background: "oklch(0.28 0.04 258)", color: "#a78bfa" }}>
                          {u.role === "admin" ? "降级" : "升管理"}
                        </button>
                        <button onClick={() => banUser.mutate({ userId: u.id, ban: !u.isBanned })}
                          className="px-2 py-0.5 rounded text-xs" style={{ background: u.isBanned ? "oklch(0.28 0.04 258)" : "#7f1d1d44", color: u.isBanned ? "#4ade80" : "#f87171" }}>
                          {u.isBanned ? "解封" : "封禁"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!isLoading && data?.rows.length === 0 && (
                  <tr><td colSpan={9} className="text-center py-8 text-gray-500">无数据</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <Pagination page={page} total={data?.total ?? 0} pageSize={20} onChange={setPage} />
      </div>

      {/* User detail drawer */}
      {selectedUser !== null && (
        <div className="w-80 flex-shrink-0 flex flex-col gap-3 overflow-y-auto" style={{ maxHeight: "calc(100vh - 120px)" }}>
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-white">用户详情 #{selectedUser}</div>
            <button onClick={() => setSelectedUser(null)} className="text-gray-500 hover:text-white text-lg">×</button>
          </div>

          {detail && (
            <>
              {/* Basic info */}
              <div className="rounded-xl p-3 text-xs" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
                <div className="font-medium text-gray-300 mb-2">基本信息</div>
                <div className="grid grid-cols-2 gap-1 text-gray-400">
                  <span>用户名:</span><span className="text-white">{detail.user.name ?? "—"}</span>
                  <span>邮箱:</span><span className="text-white truncate">{detail.user.email ?? "—"}</span>
                  <span>角色:</span><span className="text-purple-300">{detail.user.role}</span>
                  <span>状态:</span><span className={detail.user.isBanned ? "text-red-400" : "text-green-400"}>{detail.user.isBanned ? "已封禁" : "正常"}</span>
                  <span>登录方式:</span><span className="text-white">{detail.user.loginMethod ?? "—"}</span>
                  <span>注册:</span><span className="text-white">{fmtDate(detail.user.createdAt).split(" ")[0]}</span>
                  <span>钱包:</span><span className="text-blue-300 truncate text-xs">{detail.user.primaryWalletAddress ? detail.user.primaryWalletAddress.slice(0, 10) + "..." : "未绑定"}</span>
                </div>
                {detail.user.isBanned && detail.user.banReason && (
                  <div className="mt-2 text-red-400">封禁原因: {detail.user.banReason}</div>
                )}
              </div>

              {/* Balances */}
              <div className="rounded-xl p-3 text-xs" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
                <div className="font-medium text-gray-300 mb-2">余额明细</div>
                {detail.balances.length === 0 && <div className="text-gray-500">无余额记录</div>}
                {detail.balances.map((b) => (
                  <div key={b.id} className="flex justify-between py-1 border-b border-white/5">
                    <span className="text-white font-medium">{b.asset}</span>
                    <div className="text-right">
                      <div className="text-green-400">可用: {fmt(b.available, 4)}</div>
                      <div className="text-yellow-400">冻结: {fmt(b.locked, 4)}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <button onClick={() => setShowAdjust(true)}
                  className="flex-1 py-2 rounded-lg text-xs font-medium text-white"
                  style={{ background: "oklch(0.35 0.12 262)" }}>
                  调整余额
                </button>
                <button onClick={() => setShowDeposit(true)}
                  className="flex-1 py-2 rounded-lg text-xs font-medium text-white"
                  style={{ background: "oklch(0.35 0.12 142)" }}>
                  运营入账
                </button>
              </div>

              {/* Adjust balance form */}
              {showAdjust && (
                <div className="rounded-xl p-3 text-xs" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid #f59e0b44" }}>
                  <div className="font-medium text-yellow-400 mb-2">调整余额</div>
                  <div className="flex flex-col gap-2">
                    <input value={adjustAsset} onChange={(e) => setAdjustAsset(e.target.value)}
                      placeholder="币种 (如 USDT)" className="px-2 py-1.5 rounded text-white outline-none"
                      style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
                    <input value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)}
                      placeholder="变动额 (正数增加，负数减少)" className="px-2 py-1.5 rounded text-white outline-none"
                      style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
                    <input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)}
                      placeholder="原因" className="px-2 py-1.5 rounded text-white outline-none"
                      style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
                    <div className="flex gap-2">
                      <button onClick={() => adjustBalance.mutate({ userId: selectedUser, asset: adjustAsset, delta: adjustDelta, reason: adjustReason })}
                        disabled={adjustBalance.isPending || !adjustDelta}
                        className="flex-1 py-1.5 rounded font-medium text-white disabled:opacity-50"
                        style={{ background: "oklch(0.35 0.12 262)" }}>
                        {adjustBalance.isPending ? "处理中..." : "确认调整"}
                      </button>
                      <button onClick={() => setShowAdjust(false)} className="px-3 py-1.5 rounded text-gray-400" style={{ background: "oklch(0.22 0.03 258)" }}>取消</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Simulate deposit form */}
              {showDeposit && (
                <div className="rounded-xl p-3 text-xs" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid #4ade8044" }}>
                  <div className="font-medium text-green-400 mb-2">运营入账</div>
                  <div className="flex flex-col gap-2">
                    <select value={depositChain} onChange={(e) => setDepositChain(e.target.value as any)}
                      className="px-2 py-1.5 rounded text-white outline-none"
                      style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }}>
                      <option value="erc20">ERC20 (以太坊)</option>
                      <option value="bep20">BEP20 (BSC)</option>
                    </select>
                    <input value={depositAsset} onChange={(e) => setDepositAsset(e.target.value.toUpperCase())}
                      placeholder="充值代币" className="px-2 py-1.5 rounded text-white outline-none"
                      style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
                    <input value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder="充值金额" className="px-2 py-1.5 rounded text-white outline-none"
                      style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
                    <div className="flex gap-2">
                      <button onClick={() => simulateDeposit.mutate({ userId: selectedUser, chain: depositChain, asset: depositAsset.trim().toUpperCase(), amount: depositAmount })}
                        disabled={simulateDeposit.isPending || !depositAsset.trim()}
                        className="flex-1 py-1.5 rounded font-medium text-white disabled:opacity-50"
                        style={{ background: "oklch(0.35 0.12 142)" }}>
                        {simulateDeposit.isPending ? "处理中..." : "确认充值"}
                      </button>
                      <button onClick={() => setShowDeposit(false)} className="px-3 py-1.5 rounded text-gray-400" style={{ background: "oklch(0.22 0.03 258)" }}>取消</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Recent orders */}
              <div className="rounded-xl p-3 text-xs" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
                <div className="font-medium text-gray-300 mb-2">最近订单 ({detail.recentOrders.length})</div>
                {detail.recentOrders.slice(0, 8).map((o) => (
                  <div key={o.id} className="flex items-center justify-between py-1 border-b border-white/5">
                    <div className="flex items-center gap-2">
                      <span className={o.side === "buy" ? "text-green-400" : "text-red-400"}>{o.side === "buy" ? "买" : "卖"}</span>
                      <span className="text-white">{o.symbol}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 font-mono">{fmt(o.quantity, 8)}</span>
                      <StatusBadge status={o.status} />
                    </div>
                  </div>
                ))}
                {detail.recentOrders.length === 0 && <div className="text-gray-500">无订单记录</div>}
              </div>

              {/* Recent deposits & withdrawals */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl p-3 text-xs" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
                  <div className="font-medium text-gray-300 mb-2">充值记录 ({detail.recentDeposits.length})</div>
                  {detail.recentDeposits.slice(0, 5).map((d) => (
                    <div key={d.id} className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-green-400">+{fmt(d.amount)}</span>
                      <StatusBadge status={d.status} />
                    </div>
                  ))}
                  {detail.recentDeposits.length === 0 && <div className="text-gray-500">无记录</div>}
                </div>
                <div className="rounded-xl p-3 text-xs" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
                  <div className="font-medium text-gray-300 mb-2">提现记录 ({detail.recentWithdrawals.length})</div>
                  {detail.recentWithdrawals.slice(0, 5).map((w) => (
                    <div key={w.id} className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-red-400">-{fmt(w.amount)}</span>
                      <StatusBadge status={w.status} />
                    </div>
                  ))}
                  {detail.recentWithdrawals.length === 0 && <div className="text-gray-500">无记录</div>}
                </div>
               </div>

              {/* Ledger entries */}
              <div className="rounded-xl p-3 text-xs" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
                <div className="font-medium text-gray-300 mb-2">账本流水 ({userLedger?.length ?? 0})</div>
                {(userLedger ?? []).slice(0, 15).map((e) => (
                  <div key={e.id} className="flex items-center justify-between py-1 border-b border-white/5">
                    <div className="flex flex-col">
                      <span className="text-gray-400">{e.reason}</span>
                      <span className="text-gray-600 text-xs">{fmtDate(e.createdAt)}</span>
                    </div>
                    <div className="text-right">
                      <div className={Number(e.delta) >= 0 ? "text-green-400" : "text-red-400"}>
                        {Number(e.delta) >= 0 ? "+" : ""}{fmt(e.delta, 6)} {e.asset}
                      </div>
                      {Number(e.lockedDelta) !== 0 && (
                        <div className="text-yellow-400 text-xs">冻结: {Number(e.lockedDelta) >= 0 ? "+" : ""}{fmt(e.lockedDelta, 6)}</div>
                      )}
                    </div>
                  </div>
                ))}
                {(!userLedger || userLedger.length === 0) && <div className="text-gray-500">无流水记录</div>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
// ─── Section: Orders ────────────────────────────────────────────────────────────────────────────────────
function OrdersSection() {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [symbol, setSymbol] = useState("");
  const [status, setStatus] = useState<any>("all");
  const [userId, setUserId] = useState("");
  const [selected, setSelected] = useState<number[]>([]);

  const { data, isLoading } = trpc.admin.listAllOrders.useQuery(
    { page, pageSize: 50, symbol: symbol || undefined, status, userId: userId ? Number(userId) : undefined }
  );

  const forceCancel = trpc.admin.forceCancel.useMutation({
    onSuccess: () => { toast.success("订单已撤销"); utils.admin.listAllOrders.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const bulkCancel = trpc.admin.bulkCancel.useMutation({
    onSuccess: (r) => {
      const ok = r.results.filter((x) => x.ok).length;
      toast.success(`批量撤单完成: ${ok}/${r.results.length} 成功`);
      setSelected([]);
      utils.admin.listAllOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }, []);
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null);
  const { data: orderTrades } = trpc.admin.getTradesByOrder.useQuery(
    { orderId: expandedOrder! },
    { enabled: expandedOrder !== null }
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white">订单管理</h2>
        <input value={symbol} onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setPage(1); }}
          placeholder="交易对 (如 BTCUSDT)" className="px-3 py-1.5 rounded-lg text-sm text-white placeholder-gray-500 outline-none w-40"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
        <input value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1); }}
          placeholder="用户ID" className="px-3 py-1.5 rounded-lg text-sm text-white placeholder-gray-500 outline-none w-24"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }}>
          <option value="all">全部状态</option>
          <option value="new">待成交</option>
          <option value="partial">部分成交</option>
          <option value="filled">已成交</option>
          <option value="canceled">已撤销</option>
        </select>
        {selected.length > 0 && (
          <button onClick={() => bulkCancel.mutate({ orderIds: selected })}
            disabled={bulkCancel.isPending}
            className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50"
            style={{ background: "#7f1d1d" }}>
            批量撤单 ({selected.length})
          </button>
        )}
      </div>

      <div className="rounded-xl overflow-hidden" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-white/10">
                <th className="py-3 px-3 w-8">
                  <input type="checkbox" onChange={(e) => {
                    if (e.target.checked) setSelected((data?.rows ?? []).filter((r) => r.status === "new" || r.status === "partial").map((r) => r.id));
                    else setSelected([]);
                  }} />
                </th>
                <th className="text-left py-3 px-3">ID</th>
                <th className="text-left py-3 px-3">用户ID</th>
                <th className="text-left py-3 px-3">交易对</th>
                <th className="text-left py-3 px-3">方向</th>
                <th className="text-left py-3 px-3">类型</th>
                <th className="text-right py-3 px-3">委托价/单位</th>
                <th className="text-right py-3 px-3">委托量/单位</th>
                <th className="text-right py-3 px-3">已成交/单位</th>
                <th className="text-right py-3 px-3">手续费/单位</th>
                <th className="text-left py-3 px-3">状态</th>
                <th className="text-left py-3 px-3">时间</th>
                <th className="text-left py-3 px-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={13} className="text-center py-8 text-gray-500">加载中...</td></tr>}
              {data?.rows.map((o) => (
                <React.Fragment key={o.id}>
                  <tr className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-2 px-3">
                      {(o.status === "new" || o.status === "partial") && (
                        <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggleSelect(o.id)} />
                      )}
                    </td>
                    <td className="py-2 px-3 text-gray-400 font-mono">{o.id}</td>
                    <td className="py-2 px-3 text-gray-400">{o.userId}</td>
                    <td className="py-2 px-3 text-white font-medium">{o.symbol}</td>
                    <td className="py-2 px-3"><span className={o.side === "buy" ? "text-green-400" : "text-red-400"}>{o.side === "buy" ? "买入" : "卖出"}</span></td>
                    <td className="py-2 px-3 text-gray-400">{o.type === "limit" ? "限价" : "市价"}</td>
                    {(() => {
                      const units = splitSymbolUnits(o.symbol);
                      const quantityUnit = orderQuantityUnit(o);
                      return (
                        <>
                          <td className="py-2 px-3 text-right font-mono text-gray-300">{o.price ? withUnit(fmt(o.price, 4), units.quote) : withUnit("市价", units.quote)}</td>
                          <td className="py-2 px-3 text-right font-mono text-gray-300">{withUnit(fmt(o.quantity, quantityUnit === units.quote ? 2 : 8), quantityUnit)}</td>
                          <td className="py-2 px-3 text-right font-mono text-green-400">{withUnit(fmt((o as any).filledQty ?? 0, 8), units.base)}</td>
                          <td className="py-2 px-3 text-right font-mono text-yellow-400">{withUnit(fmt((o as any).feeAmount ?? 0, 6), units.quote)}</td>
                        </>
                      );
                    })()}
                    <td className="py-2 px-3"><StatusBadge status={o.status} /></td>
                    <td className="py-2 px-3 text-gray-500">{fmtDate(o.createdAt)}</td>
                    <td className="py-2 px-3">
                      {(o.status === "new" || o.status === "partial") && (
                        <button onClick={() => forceCancel.mutate({ orderId: o.id })}
                          className="px-2 py-0.5 rounded text-xs text-red-400" style={{ background: "#7f1d1d33" }}>
                          强制撤单
                        </button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); setExpandedOrder(expandedOrder === o.id ? null : o.id); }}
                        className="px-2 py-0.5 rounded text-xs text-blue-400 ml-1" style={{ background: "#1e3a5f33" }}>
                        {expandedOrder === o.id ? "收起" : "成交"}
                      </button>
                    </td>
                  </tr>
                  {expandedOrder === o.id && (
                    <tr>
                      <td colSpan={13} className="px-4 py-2" style={{ background: "oklch(0.15 0.03 258)" }}>
                        <div className="text-xs text-gray-400 mb-1">订单 #{o.id} 关联成交明细</div>
                        {!orderTrades || orderTrades.length === 0 ? (
                          <div className="text-gray-500 text-xs py-1">暂无成交记录</div>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-gray-500">
                                <th className="text-left py-1 px-2">成交ID</th>
                                <th className="text-left py-1 px-2">交易对</th>
                                <th className="text-right py-1 px-2">价格/单位</th>
                                <th className="text-right py-1 px-2">数量/单位</th>
                                <th className="text-right py-1 px-2">成交额/单位</th>
                                <th className="text-left py-1 px-2">角色</th>
                                <th className="text-right py-1 px-2">手续费/单位</th>
                                <th className="text-left py-1 px-2">时间</th>
                              </tr>
                            </thead>
                            <tbody>
                              {orderTrades.map((t) => {
                                const isBuyer = t.buyerOrderId === o.id;
                                const units = splitSymbolUnits(t.symbol);
                                const feeAmount = isBuyer ? t.buyerFee : t.sellerFee;
                                return (
                                  <tr key={t.id} className="border-t border-white/5">
                                    <td className="py-1 px-2 text-gray-400 font-mono">{t.id}</td>
                                    <td className="py-1 px-2 text-white">{t.symbol}</td>
                                    <td className="py-1 px-2 text-right font-mono text-gray-300">{withUnit(fmt(t.price, 4), units.quote)}</td>
                                    <td className="py-1 px-2 text-right font-mono text-gray-300">{withUnit(fmt(t.quantity, 8), units.base)}</td>
                                    <td className="py-1 px-2 text-right font-mono text-gray-300">{withUnit(fmt(t.quoteQty, 2), units.quote)}</td>
                                    <td className="py-1 px-2">
                                      <span className={isBuyer ? "text-green-400" : "text-red-400"}>{isBuyer ? "买方" : "卖方"}</span>
                                    </td>
                                    <td className="py-1 px-2 text-right font-mono text-yellow-400">{withUnit(fmt(feeAmount, 6), units.quote)}</td>
                                    <td className="py-1 px-2 text-gray-500">{fmtDate(t.createdAt)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {!isLoading && data?.rows.length === 0 && <tr><td colSpan={13} className="text-center py-8 text-gray-500">无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination page={page} total={data?.total ?? 0} pageSize={50} onChange={setPage} />
    </div>
  );
}

// ─── Section: Trades ──────────────────────────────────────────────────────────
function TradesSection() {
  const [page, setPage] = useState(1);
  const [symbol, setSymbol] = useState("");
  const [userId, setUserId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const { data, isLoading } = trpc.admin.listAllTrades.useQuery(
    { page, pageSize: 50, symbol: symbol || undefined, userId: userId ? Number(userId) : undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }
  );
  const { data: breakdown } = trpc.admin.feeIncomeBreakdown.useQuery({ days: 30 });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white">成交记录</h2>
        <input value={symbol} onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setPage(1); }}
          placeholder="交易对" className="px-3 py-1.5 rounded-lg text-sm text-white placeholder-gray-500 outline-none w-36"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
        <input value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1); }}
          placeholder="用户ID" className="px-3 py-1.5 rounded-lg text-sm text-white placeholder-gray-500 outline-none w-24"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
        <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
          className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)", colorScheme: "dark" }} />
        <span className="text-gray-500 text-xs">至</span>
        <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
          className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)", colorScheme: "dark" }} />
        {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(""); setDateTo(""); }} className="text-xs text-gray-500 hover:text-white">清除</button>}
      </div>

      {/* Fee breakdown */}
      {breakdown && breakdown.length > 0 && (
        <div className="rounded-xl p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
          <div className="text-sm font-medium text-gray-300 mb-3">近30天手续费收入（按交易对）</div>
          <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
            {breakdown.slice(0, 10).map((b) => (
              <div key={b.symbol} className="text-xs p-2 rounded" style={{ background: "oklch(0.22 0.03 258)" }}>
                <div className="text-white font-medium">{b.symbol.replace("USDT", "")}</div>
                <div className="text-yellow-400 font-mono">${fmt(b.totalFee)}</div>
                <div className="text-gray-500">{b.tradeCount} 笔</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl overflow-hidden" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-white/10">
                <th className="text-left py-3 px-3">ID</th>
                <th className="text-left py-3 px-3">交易对</th>
                <th className="text-right py-3 px-3">价格</th>
                <th className="text-right py-3 px-3">数量</th>
                <th className="text-right py-3 px-3">成交额</th>
                <th className="text-left py-3 px-3">买方ID</th>
                <th className="text-left py-3 px-3">卖方ID</th>
                <th className="text-right py-3 px-3">买方手续费</th>
                <th className="text-right py-3 px-3">卖方手续费</th>
                <th className="text-left py-3 px-3">时间</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={10} className="text-center py-8 text-gray-500">加载中...</td></tr>}
              {data?.rows.map((t) => (
                <tr key={t.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-2 px-3 text-gray-400 font-mono">{t.id}</td>
                  <td className="py-2 px-3 text-white font-medium">{t.symbol}</td>
                  <td className="py-2 px-3 text-right font-mono text-gray-300">{fmt(t.price, 4)}</td>
                  <td className="py-2 px-3 text-right font-mono text-gray-300">{fmt(t.quantity, 8)}</td>
                  <td className="py-2 px-3 text-right font-mono text-green-400">${fmt(t.quoteQty)}</td>
                  <td className="py-2 px-3 text-blue-400">{t.buyerUserId === 0 ? <span className="text-gray-500 italic">平台流动性</span> : t.buyerUserId}</td>
                  <td className="py-2 px-3 text-orange-400">{t.sellerUserId === 0 ? <span className="text-gray-500 italic">平台流动性</span> : t.sellerUserId}</td>
                  <td className="py-2 px-3 text-right font-mono text-yellow-400">{fmt(t.buyerFee, 6)}</td>
                  <td className="py-2 px-3 text-right font-mono text-yellow-400">{fmt(t.sellerFee, 6)}</td>
                  <td className="py-2 px-3 text-gray-500">{fmtDate(t.createdAt)}</td>
                </tr>
              ))}
              {!isLoading && data?.rows.length === 0 && <tr><td colSpan={10} className="text-center py-8 text-gray-500">无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination page={page} total={data?.total ?? 0} pageSize={50} onChange={setPage} />
    </div>
  );
}

// ─── Section: Deposits ────────────────────────────────────────────────────────
function DepositsSection() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<any>("all");
  const [userIdFilter, setUserIdFilter] = useState("");
  const { data, isLoading } = trpc.admin.listAllDeposits.useQuery(
    { page, pageSize: 50, status: statusFilter, userId: userIdFilter ? Number(userIdFilter) : undefined }
  );
  const { data: stats } = trpc.admin.depositStats.useQuery();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white">充值管理</h2>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }}>
          <option value="all">全部状态</option>
          <option value="pending">待确认</option>
          <option value="confirmed">已确认</option>
          <option value="failed">失败</option>
        </select>
        <input value={userIdFilter} onChange={(e) => { setUserIdFilter(e.target.value); setPage(1); }}
          placeholder="用户ID" className="px-3 py-1.5 rounded-lg text-sm text-white placeholder-gray-500 outline-none w-24"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
      </div>

      {/* Stats */}
      {stats && stats.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {stats.map((s) => (
            <KpiCard key={`${s.chain}-${s.status}`} label={`${s.chain?.toUpperCase()} ${s.status}`}
              value={`$${fmt(s.totalAmount)}`} sub={`${s.count} 笔`} color="#4ade80" />
          ))}
        </div>
      )}

      <div className="rounded-xl overflow-hidden" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-white/10">
                <th className="text-left py-3 px-3">ID</th>
                <th className="text-left py-3 px-3">用户ID</th>
                <th className="text-left py-3 px-3">链</th>
                <th className="text-left py-3 px-3">币种</th>
                <th className="text-right py-3 px-3">金额</th>
                <th className="text-left py-3 px-3">状态</th>
                <th className="text-left py-3 px-3">交易哈希</th>
                <th className="text-left py-3 px-3">时间</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={8} className="text-center py-8 text-gray-500">加载中...</td></tr>}
              {data?.rows.map((d) => (
                <tr key={d.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-2 px-3 text-gray-400 font-mono">{d.id}</td>
                  <td className="py-2 px-3 text-gray-400">{d.userId}</td>
                  <td className="py-2 px-3 text-blue-400">{d.chain?.toUpperCase()}</td>
                  <td className="py-2 px-3 text-white">{d.asset}</td>
                  <td className="py-2 px-3 text-right font-mono text-green-400">+{fmt(d.amount)}</td>
                  <td className="py-2 px-3"><StatusBadge status={d.status} /></td>
                  <td className="py-2 px-3 text-gray-500 font-mono truncate max-w-24">{d.txHash ? d.txHash.slice(0, 12) + "..." : "—"}</td>
                  <td className="py-2 px-3 text-gray-500">{fmtDate(d.createdAt)}</td>
                </tr>
              ))}
              {!isLoading && data?.rows.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-gray-500">无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination page={page} total={data?.total ?? 0} pageSize={50} onChange={setPage} />
    </div>
  );
}

// ─── Section: Withdrawals ─────────────────────────────────────────────────────
function WithdrawalsSection() {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<any>("all");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const { data, isLoading } = trpc.admin.listAllWithdrawals.useQuery(
    { page, pageSize: 50, status: statusFilter }
  );
  const { data: stats } = trpc.admin.withdrawalStats.useQuery();

  const review = trpc.admin.reviewWithdrawal.useMutation({
    onSuccess: (_, v) => { toast.success(v.decision === "approve" ? "已批准" : "已驳回"); utils.admin.listAllWithdrawals.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const bulkReview = trpc.admin.bulkReviewWithdrawals.useMutation({
    onSuccess: (res) => {
      toast.success(`批量操作完成：${res.successCount} 笔成功`);
      setSelectedIds(new Set());
      utils.admin.listAllWithdrawals.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const pendingRows = data?.rows.filter((w) => w.status === "pending") ?? [];
  const allPendingSelected = pendingRows.length > 0 && pendingRows.every((w) => selectedIds.has(w.id));

  function toggleSelectAll() {
    if (allPendingSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingRows.map((w) => w.id)));
    }
  }

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white">提现管理</h2>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); setSelectedIds(new Set()); }}
          className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }}>
          <option value="all">全部状态</option>
          <option value="pending">待审核</option>
          <option value="approved">已批准</option>
          <option value="rejected">已驳回</option>
          <option value="confirmed">已确认</option>
          <option value="failed">失败</option>
        </select>
        {selectedIds.size > 0 && (
          <>
            <span className="text-sm text-yellow-400">已选 {selectedIds.size} 笔</span>
            <button
              onClick={() => bulkReview.mutate({ ids: Array.from(selectedIds), action: "approve" })}
              disabled={bulkReview.isPending}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-green-400 disabled:opacity-50"
              style={{ background: "#14532d44", border: "1px solid #4ade8044" }}>
              批量批准
            </button>
            <button
              onClick={() => bulkReview.mutate({ ids: Array.from(selectedIds), action: "reject", reason: "管理员批量驳回" })}
              disabled={bulkReview.isPending}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 disabled:opacity-50"
              style={{ background: "#7f1d1d44", border: "1px solid #f8717144" }}>
              批量驳回
            </button>
          </>
        )}
      </div>

      {/* Stats */}
      {stats && stats.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {stats.map((s) => (
            <KpiCard key={`${s.chain}-${s.status}`} label={`${s.chain?.toUpperCase()} ${s.status}`}
              value={`$${fmt(s.totalAmount)}`} sub={`${s.count} 笔`}
              color={s.status === "pending" ? "#f59e0b" : s.status === "approved" ? "#4ade80" : "#6b7280"} />
          ))}
        </div>
      )}

      <div className="rounded-xl overflow-hidden" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-white/10">
                <th className="py-3 px-3">
                  <input type="checkbox" checked={allPendingSelected} onChange={toggleSelectAll}
                    className="w-3.5 h-3.5 rounded cursor-pointer" />
                </th>
                <th className="text-left py-3 px-3">ID</th>
                <th className="text-left py-3 px-3">用户ID</th>
                <th className="text-left py-3 px-3">链</th>
                <th className="text-left py-3 px-3">币种</th>
                <th className="text-right py-3 px-3">金额</th>
                <th className="text-right py-3 px-3">手续费/单位</th>
                <th className="text-right py-3 px-3">到账</th>
                <th className="text-left py-3 px-3">目标地址</th>
                <th className="text-left py-3 px-3">状态</th>
                <th className="text-left py-3 px-3">申请时间</th>
                <th className="text-left py-3 px-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={12} className="text-center py-8 text-gray-500">加载中...</td></tr>}
              {data?.rows.map((w) => (
                <tr key={w.id} className="border-b border-white/5 hover:bg-white/5"
                  style={{ background: w.status === "pending" ? "#78350f11" : undefined }}>
                  <td className="py-2 px-3">
                    {w.status === "pending" && (
                      <input type="checkbox" checked={selectedIds.has(w.id)} onChange={() => toggleSelect(w.id)}
                        className="w-3.5 h-3.5 rounded cursor-pointer" />
                    )}
                  </td>
                  <td className="py-2 px-3 text-gray-400 font-mono">{w.id}</td>
                  <td className="py-2 px-3 text-gray-400">{w.userId}</td>
                  <td className="py-2 px-3 text-blue-400">{w.chain?.toUpperCase()}</td>
                  <td className="py-2 px-3 text-white">{w.asset}</td>
                  <td className="py-2 px-3 text-right font-mono text-red-400">-{fmt(w.amount)}</td>
                  <td className="py-2 px-3 text-right font-mono text-yellow-400">{fmt(w.feeAmount)}</td>
                  <td className="py-2 px-3 text-right font-mono text-green-400">{fmt(Number(w.amount) - Number(w.feeAmount), 4)}</td>
                  <td className="py-2 px-3 text-gray-500 font-mono truncate max-w-24">{w.toAddress ? w.toAddress.slice(0, 10) + "..." : "—"}</td>
                  <td className="py-2 px-3"><StatusBadge status={w.status} /></td>
                  <td className="py-2 px-3 text-gray-500">{fmtDate(w.createdAt)}</td>
                  <td className="py-2 px-3">
                    {w.status === "pending" && (
                      <div className="flex gap-1">
                        <button onClick={() => review.mutate({ id: w.id, decision: "approve" })}
                          disabled={review.isPending}
                          className="px-2 py-0.5 rounded text-xs text-green-400 disabled:opacity-50" style={{ background: "#14532d33" }}>批准</button>
                        <button onClick={() => review.mutate({ id: w.id, decision: "reject", reason: "管理员驳回" })}
                          disabled={review.isPending}
                          className="px-2 py-0.5 rounded text-xs text-red-400 disabled:opacity-50" style={{ background: "#7f1d1d33" }}>驳回</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {!isLoading && data?.rows.length === 0 && <tr><td colSpan={12} className="text-center py-8 text-gray-500">无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination page={page} total={data?.total ?? 0} pageSize={50} onChange={setPage} />
    </div>
  );
}

// ─── Section: Ledger ──────────────────────────────────────────────────────────
function LedgerSection() {
  const [page, setPage] = useState(1);
  const [userId, setUserId] = useState("");
  const [asset, setAsset] = useState("");
  const [reason, setReason] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const { data, isLoading } = trpc.admin.getLedgerAudit.useQuery(
    { page, pageSize: 50, userId: userId ? Number(userId) : undefined, asset: asset || undefined, reason: reason || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white">账本流水</h2>
        <input value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1); }}
          placeholder="用户ID" className="px-3 py-1.5 rounded-lg text-sm text-white placeholder-gray-500 outline-none w-24"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
        <input value={asset} onChange={(e) => { setAsset(e.target.value.toUpperCase()); setPage(1); }}
          placeholder="币种 (如 USDT)" className="px-3 py-1.5 rounded-lg text-sm text-white placeholder-gray-500 outline-none w-28"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
        <select value={reason} onChange={(e) => { setReason(e.target.value); setPage(1); }}
          className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }}>
          <option value="">全部类型</option>
          <option value="deposit">充值</option>
          <option value="withdraw_freeze">提现冻结</option>
          <option value="withdraw_complete">提现完成</option>
          <option value="withdraw_revert">提现回滚</option>
          <option value="trade_fill">成交入账</option>
          <option value="trade_fee">手续费</option>
          <option value="order_freeze">订单冻结</option>
          <option value="order_unfreeze">订单解冻</option>
          <option value="transfer_in">划入</option>
          <option value="transfer_out">划出</option>
          <option value="admin_adjust">管理员调整</option>
        </select>
        <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
          className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)", colorScheme: "dark" }} />
        <span className="text-gray-500 text-xs">至</span>
        <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
          className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)", colorScheme: "dark" }} />
        {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(""); setDateTo(""); }} className="text-xs text-gray-500 hover:text-white">清除</button>}
      </div>

      <div className="rounded-xl overflow-hidden" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-white/10">
                <th className="text-left py-3 px-3">ID</th>
                <th className="text-left py-3 px-3">用户ID</th>
                <th className="text-left py-3 px-3">币种</th>
                <th className="text-right py-3 px-3">变动额</th>
                <th className="text-right py-3 px-3">冻结变动</th>
                <th className="text-left py-3 px-3">类型</th>
                <th className="text-left py-3 px-3">关联表</th>
                <th className="text-left py-3 px-3">关联ID</th>
                <th className="text-left py-3 px-3">时间</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={9} className="text-center py-8 text-gray-500">加载中...</td></tr>}
              {data?.rows.map((l) => {
                const delta = Number(l.delta);
                const locked = Number(l.lockedDelta);
                return (
                  <tr key={l.id} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-2 px-3 text-gray-400 font-mono">{l.id}</td>
                    <td className="py-2 px-3 text-gray-400">{l.userId}</td>
                    <td className="py-2 px-3 text-white font-medium">{l.asset}</td>
                    <td className="py-2 px-3 text-right font-mono" style={{ color: delta >= 0 ? "#4ade80" : "#f87171" }}>
                      {delta >= 0 ? "+" : ""}{fmt(delta, 6)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono" style={{ color: locked >= 0 ? "#f59e0b" : "#60a5fa" }}>
                      {locked !== 0 ? (locked >= 0 ? "+" : "") + fmt(locked, 6) : "—"}
                    </td>
                    <td className="py-2 px-3">
                      <span className="px-2 py-0.5 rounded text-xs" style={{ background: "oklch(0.25 0.04 258)", color: "#a78bfa" }}>{REASON_LABELS[l.reason] ?? l.reason}</span>
                    </td>
                    <td className="py-2 px-3 text-gray-500">{l.refTable ? (REF_TABLE_LABELS[l.refTable] ?? l.refTable) : "—"}</td>
                    <td className="py-2 px-3 text-gray-500 font-mono">{l.refId ?? "—"}</td>
                    <td className="py-2 px-3 text-gray-500">{fmtDate(l.createdAt)}</td>
                  </tr>
                );
              })}
              {!isLoading && data?.rows.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-gray-500">无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination page={page} total={data?.total ?? 0} pageSize={50} onChange={setPage} />
    </div>
  );
}

// ─── Section: Fees & Markets ──────────────────────────────────────────────────
function MarketsSection() {
  const utils = trpc.useUtils();
  const { data: markets, isLoading } = trpc.admin.listMarkets.useQuery();
  const [editing, setEditing] = useState<string | null>(null);
  const [editVals, setEditVals] = useState<MarketEditValues>({
    minNotional: "5",
    priceTick: "0.01",
    amountStep: "0.0001",
    marketMode: "binance_mirror",
    externalSymbol: "",
    marketDataSource: "binance",
    refExchange: "binance",
    priceRatio: "1",
    priceOffset: "0",
    spreadPct: "0.002",
    maxDepthLevels: "15",
    updateIntervalSec: "3",
    maxPriceJumpPct: "0.05",
    klineFollowMode: "scaled",
    allowRealTrade: true,
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

  const refreshMarkets = () => utils.admin.listMarkets.invalidate();

  const updateFees = trpc.admin.updateMarketFees.useMutation({
    onSuccess: () => { toast.success("手续费已更新"); refreshMarkets(); },
    onError: (e) => toast.error(e.message),
  });
  const createMarket = trpc.admin.createMarket.useMutation({
    onSuccess: () => { toast.success("交易对已创建"); setCreateVals(DEFAULT_CREATE_MARKET); setCreateOpen(false); refreshMarkets(); },
    onError: (e) => toast.error(e.message),
  });
  const updateMarket = trpc.admin.updateMarket.useMutation({
    onSuccess: () => { toast.success("交易对已更新"); setEditing(null); refreshMarkets(); },
    onError: (e) => toast.error(e.message),
  });

  const startEdit = (m: any) => {
    setEditing(m.symbol);
    setEditVals({
      minNotional: m.minNotional ?? "5",
      priceTick: m.priceTick ?? "0.01",
      amountStep: m.amountStep ?? "0.0001",
      marketMode: (m.marketMode ?? "binance_mirror") as MarketMode,
      externalSymbol: m.externalSymbol ?? m.symbol,
      marketDataSource: (m.marketDataSource ?? "binance") as MarketDataSource,
      refExchange: (m.refExchange ?? "binance") as RefExchange,
      priceRatio: m.priceRatio ?? "1",
      priceOffset: m.priceOffset ?? "0",
      spreadPct: m.spreadPct ?? "0.002",
      maxDepthLevels: String(m.maxDepthLevels ?? 15),
      updateIntervalSec: String(m.updateIntervalSec ?? 3),
      maxPriceJumpPct: m.maxPriceJumpPct ?? "0.05",
      klineFollowMode: (m.klineFollowMode ?? "scaled") as KlineFollowMode,
      allowRealTrade: m.allowRealTrade !== false,
      allowLimitOrder: m.allowLimitOrder !== false,
      allowMarketOrder: m.allowMarketOrder !== false,
      logoUrl: m.logoUrl ?? "",
      description: m.description ?? "",
      websiteUrl: m.websiteUrl ?? "",
      whitepaperUrl: m.whitepaperUrl ?? "",
      explorerUrl: m.explorerUrl ?? "",
      contractAddress: m.contractAddress ?? "",
    });
  };

  const saveEdit = (symbol: string) => {
    if (!isPositiveDecimalInput(editVals.minNotional) || !isPositiveDecimalInput(editVals.priceTick) || !isPositiveDecimalInput(editVals.amountStep) || !isPositiveDecimalInput(editVals.priceRatio)) {
      toast.error("最小名义额、价格步长、数量步长和价格倍率必须为大于 0 的数字");
      return;
    }
    if (!isNonNegativeDecimalInput(editVals.priceOffset) || !isNonNegativeDecimalInput(editVals.spreadPct) || !isNonNegativeDecimalInput(editVals.maxPriceJumpPct)) {
      toast.error("价格偏移、买卖价差和最大跳变必须为非负数字");
      return;
    }
    if (!isPositiveIntInput(editVals.maxDepthLevels, 1, 50) || !isPositiveIntInput(editVals.updateIntervalSec, 1, 3600)) {
      toast.error("盘口档位应为 1-50 的整数，刷新间隔应为 1-3600 秒");
      return;
    }
    updateMarket.mutate({
      symbol,
      ...editVals,
      maxDepthLevels: Number(editVals.maxDepthLevels),
      updateIntervalSec: Number(editVals.updateIntervalSec),
      externalSymbol: editVals.externalSymbol ? normalizeMarketSymbol(editVals.externalSymbol) : symbol,
    });
  };

  const createSymbolMismatch = Boolean(createVals.symbol && createVals.base && createVals.quote && createVals.symbol !== `${createVals.base}${createVals.quote}`);
  const createNumericInvalid = MARKET_NUMERIC_FIELDS.some((key) => !isPositiveDecimalInput(createVals[key]))
    || MARKET_NON_NEGATIVE_FIELDS.some((key) => !isNonNegativeDecimalInput(createVals[key]))
    || !isPositiveIntInput(createVals.maxDepthLevels, 1, 50)
    || !isPositiveIntInput(createVals.updateIntervalSec, 1, 3600);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">交易对与做市管理</h2>
          <div className="text-xs text-gray-400 mt-1">支持新增交易对、单独设置自动做市/订单簿撮合、行情源、限价/市价单开关，并提供明确的上架/下架操作。手续费以小数表示（如 0.001 = 0.1%）。</div>
        </div>
        <button onClick={() => setCreateOpen((v) => !v)} className="px-3 py-1.5 rounded-lg text-sm text-blue-100" style={{ background: "#1e3a8a66", border: "1px solid #60a5fa55" }}>
          {createOpen ? "收起新增" : "新增 / 上架交易对"}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div className="rounded-xl p-3" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
          <div className="font-medium text-blue-300">自动做市（平台流动性）</div>
          <div className="text-gray-400 mt-1">市价单直接由平台流动性成交，限价单可按行情触发或进入委托簿。适合跟随主行情通道快速上线交易对。</div>
        </div>
        <div className="rounded-xl p-3" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
          <div className="font-medium text-amber-300">订单簿撮合</div>
          <div className="text-gray-400 mt-1">仅依赖站内用户挂单撮合。切换前应确认深度、最小成交额、手续费和撤单释放均已验证。</div>
        </div>
      </div>

      {createOpen && (
        <div className="rounded-xl grid grid-cols-1 md:grid-cols-2 gap-3 text-xs p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
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
            ["价格倍率", "priceRatio", "1 = 与参考行情一致；0.01 = 参考价的 1/100"],
            ["价格偏移", "priceOffset", "0"],
            ["盘口价差", "spreadPct", "0.002"],
            ["最大档位", "maxDepthLevels", "15"],
            ["刷新间隔秒", "updateIntervalSec", "3"],
            ["最大跳变", "maxPriceJumpPct", "0.05"],
            ["Logo URL", "logoUrl", "https://.../logo.png"],
            ["官网", "websiteUrl", "https://..."],
            ["白皮书", "whitepaperUrl", "https://.../whitepaper.pdf"],
            ["区块浏览器", "explorerUrl", "https://..."],
            ["合约地址", "contractAddress", "可选，主链资产可留空"],
          ].map(([label, key, placeholder]) => {
            const isSymbolField = ["symbol", "base", "quote", "externalSymbol"].includes(key);
            const isNumericField = MARKET_NUMERIC_FIELDS.includes(key as (typeof MARKET_NUMERIC_FIELDS)[number]);
            const isNonNegativeField = MARKET_NON_NEGATIVE_FIELDS.includes(key as (typeof MARKET_NON_NEGATIVE_FIELDS)[number]);
            const isIntField = ["maxDepthLevels", "updateIntervalSec"].includes(key);
            const invalid = (isNumericField && !isPositiveDecimalInput((createVals as any)[key]))
              || (isNonNegativeField && !isNonNegativeDecimalInput((createVals as any)[key]))
              || (isIntField && !isPositiveIntInput((createVals as any)[key], key === "maxDepthLevels" ? 1 : 1, key === "maxDepthLevels" ? 50 : 3600));
            return (
              <label key={key} className="flex flex-col gap-1">
                <span className="text-gray-400">{label}</span>
                <input value={(createVals as any)[key]} onChange={(e) => setCreateVals(v => ({ ...v, [key]: isSymbolField ? normalizeMarketSymbol(e.target.value) : e.target.value.trim() }))}
                  placeholder={placeholder} className="h-8 px-2 rounded outline-none text-white"
                  style={{ background: "oklch(0.22 0.03 258)", border: invalid ? "1px solid #f87171" : "1px solid #ffffff1a" }} />
                {invalid && <span className="text-[10px] text-red-300">请输入大于 0 的有效数字</span>}
              </label>
            );
          })}
          <label className="md:col-span-2 flex flex-col gap-1">
            <span className="text-gray-400">币种介绍</span>
            <textarea value={createVals.description} onChange={(e) => setCreateVals(v => ({ ...v, description: e.target.value }))}
              placeholder="项目定位、核心功能、生态用途等，将展示在交易对资料页" rows={3}
              className="px-2 py-2 rounded outline-none resize-none text-white" style={{ background: "oklch(0.22 0.03 258)", border: "1px solid #ffffff1a" }} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">做市模式</span>
            <select value={createVals.marketMode} onChange={(e) => setCreateVals(v => ({ ...v, marketMode: e.target.value as MarketMode }))}
              className="h-8 px-2 rounded outline-none text-white" style={{ background: "oklch(0.22 0.03 258)", border: "1px solid #ffffff1a" }}>
              <option value="binance_mirror">{MARKET_MODE_LABEL.binance_mirror}</option>
              <option value="orderbook">{MARKET_MODE_LABEL.orderbook}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">行情源</span>
            <select value={createVals.marketDataSource} onChange={(e) => setCreateVals(v => ({ ...v, marketDataSource: e.target.value as MarketDataSource }))}
              className="h-8 px-2 rounded outline-none text-white" style={{ background: "oklch(0.22 0.03 258)", border: "1px solid #ffffff1a" }}>
              <option value="binance">{MARKET_DATA_SOURCE_LABEL.binance}</option>
              <option value="internal">{MARKET_DATA_SOURCE_LABEL.internal}</option>
              <option value="manual">{MARKET_DATA_SOURCE_LABEL.manual}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">参考交易所</span>
            <select value={createVals.refExchange} onChange={(e) => setCreateVals(v => ({ ...v, refExchange: e.target.value as RefExchange }))}
              className="h-8 px-2 rounded outline-none text-white" style={{ background: "oklch(0.22 0.03 258)", border: "1px solid #ffffff1a" }}>
              <option value="binance">{REF_EXCHANGE_LABEL.binance}</option>
              <option value="okx">{REF_EXCHANGE_LABEL.okx}</option>
              <option value="bybit">{REF_EXCHANGE_LABEL.bybit}</option>
              <option value="manual">{REF_EXCHANGE_LABEL.manual}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">K 线跟随</span>
            <select value={createVals.klineFollowMode} onChange={(e) => setCreateVals(v => ({ ...v, klineFollowMode: e.target.value as KlineFollowMode }))}
              className="h-8 px-2 rounded outline-none text-white" style={{ background: "oklch(0.22 0.03 258)", border: "1px solid #ffffff1a" }}>
              <option value="scaled">{KLINE_FOLLOW_LABEL.scaled}</option>
              <option value="synthetic">{KLINE_FOLLOW_LABEL.synthetic}</option>
            </select>
          </label>
          <div className="md:col-span-2 rounded-lg px-3 py-2 text-[11px] text-gray-400" style={{ background: "oklch(0.22 0.03 258 / 0.55)", border: "1px solid #ffffff14" }}>
            {MARKET_MODE_HELP[createVals.marketMode]}
          </div>
          <div className="md:col-span-2 flex flex-col md:flex-row md:items-center md:justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-4 text-gray-400">
              <label className="flex items-center gap-2"><Switch checked={createVals.allowLimitOrder} onCheckedChange={(v) => setCreateVals(s => ({ ...s, allowLimitOrder: v }))} />允许限价单</label>
              <label className="flex items-center gap-2"><Switch checked={createVals.allowMarketOrder} onCheckedChange={(v) => setCreateVals(s => ({ ...s, allowMarketOrder: v }))} />允许市价单</label>
              <label className="flex items-center gap-2"><Switch checked={createVals.allowRealTrade} onCheckedChange={(v) => setCreateVals(s => ({ ...s, allowRealTrade: v }))} />允许真实成交</label>
              <label className="flex items-center gap-2"><Switch checked={createVals.isActive} onCheckedChange={(v) => setCreateVals(s => ({ ...s, isActive: v }))} />创建后立即上架</label>
            </div>
            <div className="flex gap-2">
              <button className="px-3 py-1.5 rounded text-gray-300" style={{ background: "oklch(0.22 0.03 258)" }} onClick={() => setCreateOpen(false)}>取消</button>
              <button disabled={createMarket.isPending || !createVals.symbol || createSymbolMismatch || createNumericInvalid}
                onClick={() => createMarket.mutate({ ...createVals, maxDepthLevels: Number(createVals.maxDepthLevels), updateIntervalSec: Number(createVals.updateIntervalSec), symbol: normalizeMarketSymbol(createVals.symbol), base: normalizeMarketSymbol(createVals.base), quote: normalizeMarketSymbol(createVals.quote), externalSymbol: createVals.externalSymbol ? normalizeMarketSymbol(createVals.externalSymbol) : undefined })}
                className="px-3 py-1.5 rounded text-white disabled:opacity-40" style={{ background: "#2563eb" }}>
                创建并{createVals.isActive ? "上架" : "保持下架"}
              </button>
            </div>
          </div>
          {createSymbolMismatch && <div className="md:col-span-2 text-[11px] text-red-300">交易对代码必须等于基础币种 + 计价币种，例如 BTC + USDT = BTCUSDT。</div>}
        </div>
      )}

      <div className="rounded-xl overflow-hidden" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[1680px]">
            <thead>
              <tr className="text-gray-500 border-b border-white/10">
                <th className="text-left py-3 px-3">交易对</th>
                <th className="text-left py-3 px-3">基础币</th>
                <th className="text-left py-3 px-3">报价币</th>
                <th className="text-right py-3 px-3">Taker 费率</th>
                <th className="text-right py-3 px-3">Maker 费率</th>
                <th className="text-right py-3 px-3">最小名义额</th>
                <th className="text-right py-3 px-3">价格步长</th>
                <th className="text-right py-3 px-3">数量步长</th>
                <th className="text-center py-3 px-3">做市方式</th>
                <th className="text-center py-3 px-3">外部标的</th>
                <th className="text-center py-3 px-3">行情源</th>
                <th className="text-center py-3 px-3">参考交易所</th>
                <th className="text-right py-3 px-3">价格倍率</th>
                <th className="text-right py-3 px-3">偏移</th>
                <th className="text-right py-3 px-3">盘口</th>
                <th className="text-center py-3 px-3">K线</th>
                <th className="text-center py-3 px-3">真实成交</th>
                <th className="text-center py-3 px-3">限价</th>
                <th className="text-center py-3 px-3">市价</th>
                <th className="text-center py-3 px-3">上架状态</th>
                <th className="text-right py-3 px-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={21} className="text-center py-8 text-gray-500">加载中...</td></tr>}
              {markets?.map((m: any) => {
                const isEditing = editing === m.symbol;
                return (
                  <tr key={m.symbol} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-2 px-3 text-white font-medium">{m.symbol}</td>
                    <td className="py-2 px-3 text-blue-300">{m.base ?? m.symbol.replace('USDT','')}</td>
                    <td className="py-2 px-3 text-yellow-300">{m.quote ?? 'USDT'}</td>
                    <td className="py-2 px-3 text-right">
                      {isEditing ? (
                        <input defaultValue={m.takerFee} onBlur={(ev) => updateFees.mutate({ symbol: m.symbol, takerFee: ev.target.value, makerFee: m.makerFee })}
                          className="w-20 px-1.5 py-0.5 rounded text-right font-mono text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }} />
                      ) : <span className="font-mono text-yellow-400">{(Number(m.takerFee) * 100).toFixed(3)}%</span>}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {isEditing ? (
                        <input defaultValue={m.makerFee} onBlur={(ev) => updateFees.mutate({ symbol: m.symbol, takerFee: m.takerFee, makerFee: ev.target.value })}
                          className="w-20 px-1.5 py-0.5 rounded text-right font-mono text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }} />
                      ) : <span className="font-mono text-yellow-400">{(Number(m.makerFee) * 100).toFixed(3)}%</span>}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      {isEditing ? <input value={editVals.minNotional} onChange={(e) => setEditVals(v => ({ ...v, minNotional: e.target.value }))} className="w-20 px-1.5 py-0.5 rounded text-right text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }} /> : m.minNotional}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      {isEditing ? <input value={editVals.priceTick} onChange={(e) => setEditVals(v => ({ ...v, priceTick: e.target.value }))} className="w-24 px-1.5 py-0.5 rounded text-right text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }} /> : (Number(m.priceTick).toFixed(8).replace(/\.?0+$/, '') || '0')}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      {isEditing ? <input value={editVals.amountStep} onChange={(e) => setEditVals(v => ({ ...v, amountStep: e.target.value }))} className="w-24 px-1.5 py-0.5 rounded text-right text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }} /> : (Number(m.amountStep).toFixed(8).replace(/\.?0+$/, '') || '0')}
                    </td>
                    <td className="py-2 px-3 text-center">
                      {isEditing ? (
                        <select value={editVals.marketMode} onChange={(e) => setEditVals(v => ({ ...v, marketMode: e.target.value as MarketMode }))} className="h-7 px-2 rounded text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }}>
                          <option value="binance_mirror">{MARKET_MODE_LABEL.binance_mirror}</option>
                          <option value="orderbook">{MARKET_MODE_LABEL.orderbook}</option>
                        </select>
                      ) : <span className={`px-2 py-0.5 rounded-full border ${m.marketMode === "orderbook" ? "text-amber-300 border-amber-300/30" : "text-blue-300 border-blue-300/30"}`} title={MARKET_MODE_HELP[(m.marketMode ?? "binance_mirror") as MarketMode]}>{MARKET_MODE_LABEL[(m.marketMode ?? "binance_mirror") as MarketMode]}</span>}
                    </td>
                    <td className="py-2 px-3 text-center font-mono">
                      {isEditing ? <input value={editVals.externalSymbol} onChange={(e) => setEditVals(v => ({ ...v, externalSymbol: normalizeMarketSymbol(e.target.value) }))} className="w-24 px-1.5 py-0.5 rounded text-center text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }} /> : (m.externalSymbol ?? m.symbol)}
                    </td>
                    <td className="py-2 px-3 text-center">
                      {isEditing ? (
                        <select value={editVals.marketDataSource} onChange={(e) => setEditVals(v => ({ ...v, marketDataSource: e.target.value as MarketDataSource }))} className="h-7 px-2 rounded text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }}>
                          <option value="binance">{MARKET_DATA_SOURCE_LABEL.binance}</option>
                          <option value="internal">{MARKET_DATA_SOURCE_LABEL.internal}</option>
                          <option value="manual">{MARKET_DATA_SOURCE_LABEL.manual}</option>
                        </select>
                      ) : (MARKET_DATA_SOURCE_LABEL[(m.marketDataSource ?? "binance") as MarketDataSource] ?? MARKET_DATA_SOURCE_LABEL.binance)}
                    </td>
                    <td className="py-2 px-3 text-center">
                      {isEditing ? (
                        <select value={editVals.refExchange} onChange={(e) => setEditVals(v => ({ ...v, refExchange: e.target.value as RefExchange }))} className="h-7 px-2 rounded text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }}>
                          <option value="binance">Binance</option>
                          <option value="okx">OKX</option>
                          <option value="bybit">Bybit</option>
                          <option value="manual">手动</option>
                        </select>
                      ) : (REF_EXCHANGE_LABEL[(m.refExchange ?? "binance") as RefExchange] ?? REF_EXCHANGE_LABEL.binance)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">{isEditing ? <input value={editVals.priceRatio} onChange={(e) => setEditVals(v => ({ ...v, priceRatio: e.target.value }))} className="w-24 px-1.5 py-0.5 rounded text-right text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }} /> : (m.priceRatio ?? "1")}</td>
                    <td className="py-2 px-3 text-right font-mono">{isEditing ? <input value={editVals.priceOffset} onChange={(e) => setEditVals(v => ({ ...v, priceOffset: e.target.value }))} className="w-20 px-1.5 py-0.5 rounded text-right text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }} /> : (m.priceOffset ?? "0")}</td>
                    <td className="py-2 px-3 text-right font-mono">
                      {isEditing ? (
                        <div className="flex justify-end gap-1">
                          <input title="盘口价差" value={editVals.spreadPct} onChange={(e) => setEditVals(v => ({ ...v, spreadPct: e.target.value }))} className="w-20 px-1.5 py-0.5 rounded text-right text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }} />
                          <input title="最大档位" value={editVals.maxDepthLevels} onChange={(e) => setEditVals(v => ({ ...v, maxDepthLevels: e.target.value }))} className="w-12 px-1.5 py-0.5 rounded text-right text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }} />
                        </div>
                      ) : `${m.spreadPct ?? "0.002"}/${m.maxDepthLevels ?? 15}`}
                    </td>
                    <td className="py-2 px-3 text-center">
                      {isEditing ? (
                        <select value={editVals.klineFollowMode} onChange={(e) => setEditVals(v => ({ ...v, klineFollowMode: e.target.value as KlineFollowMode }))} className="h-7 px-2 rounded text-white outline-none" style={{ background: "oklch(0.25 0.04 258)", border: "1px solid #60a5fa44" }}>
                          <option value="scaled">跟随缩放</option>
                          <option value="synthetic">独立合成</option>
                        </select>
                      ) : (m.klineFollowMode === "synthetic" ? "独立合成" : "跟随缩放")}
                    </td>
                    <td className="py-2 px-3 text-center">{isEditing ? <Switch checked={editVals.allowRealTrade} onCheckedChange={(checked) => setEditVals(v => ({ ...v, allowRealTrade: checked }))} /> : <span className={m.allowRealTrade === false ? "text-amber-300" : "text-green-400"}>{m.allowRealTrade === false ? "仅行情" : "允许"}</span>}</td>
                    <td className="py-2 px-3 text-center">{isEditing ? <Switch checked={editVals.allowLimitOrder} onCheckedChange={(checked) => setEditVals(v => ({ ...v, allowLimitOrder: checked }))} /> : <span className={m.allowLimitOrder === false ? "text-red-400" : "text-green-400"}>{m.allowLimitOrder === false ? "关闭" : "开启"}</span>}</td>
                    <td className="py-2 px-3 text-center">{isEditing ? <Switch checked={editVals.allowMarketOrder} onCheckedChange={(checked) => setEditVals(v => ({ ...v, allowMarketOrder: checked }))} /> : <span className={m.allowMarketOrder === false ? "text-red-400" : "text-green-400"}>{m.allowMarketOrder === false ? "关闭" : "开启"}</span>}</td>
                    <td className="py-2 px-3 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Switch checked={m.isActive} onCheckedChange={() => updateMarket.mutate({ symbol: m.symbol, isActive: !m.isActive })} />
                        <button disabled={updateMarket.isPending} onClick={() => updateMarket.mutate({ symbol: m.symbol, isActive: !m.isActive })}
                          className={`px-2 py-0.5 rounded-full border text-[11px] ${m.isActive ? "text-red-300 border-red-300/30 hover:bg-red-400/10" : "text-green-300 border-green-300/30 hover:bg-green-400/10"}`}
                          title={m.isActive ? "下架后用户端不再允许新下单，历史订单和成交保留" : "上架后用户端可见并允许按配置下单"}>
                          {m.isActive ? "下架" : "上架"}
                        </button>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right">
                      {isEditing ? (
                        <div className="flex gap-1 justify-end">
                          <button onClick={() => saveEdit(m.symbol)} disabled={updateMarket.isPending} className="px-2 py-0.5 rounded text-xs text-green-400 disabled:opacity-40" style={{ background: "#14532d33" }}>保存</button>
                          <button onClick={() => setEditing(null)} className="px-2 py-0.5 rounded text-xs text-gray-400" style={{ background: "oklch(0.22 0.03 258)" }}>取消</button>
                        </div>
                      ) : <button onClick={() => startEdit(m)} className="px-2 py-0.5 rounded text-xs text-blue-400" style={{ background: "#1e3a5f33" }}>编辑</button>}
                    </td>
                  </tr>
                );
              })}
              {!isLoading && (markets?.length ?? 0) === 0 && <tr><td colSpan={21} className="text-center py-8 text-gray-500">暂无交易对</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── PlatformPnLCard ────────────────────────────────────────────────────────
function PlatformPnLCard() {
  const { data: breakdown } = trpc.admin.feeIncomeBreakdown.useQuery();
  if (!breakdown || breakdown.length === 0) return <div className="text-gray-500 text-sm">暂无收入数据</div>;
  const totalFee = breakdown.reduce((sum, b) => sum + Number(b.totalFee), 0);
  const totalTrades = breakdown.reduce((sum, b) => sum + b.tradeCount, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-lg" style={{ background: "oklch(0.22 0.03 258)" }}>
          <div className="text-xs text-gray-500">手续费总收入</div>
          <div className="text-lg font-bold text-green-400 font-mono">${totalFee.toFixed(2)}</div>
        </div>
        <div className="p-3 rounded-lg" style={{ background: "oklch(0.22 0.03 258)" }}>
          <div className="text-xs text-gray-500">总成交笔数</div>
          <div className="text-lg font-bold text-blue-400 font-mono">{totalTrades}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
        {breakdown.slice(0, 10).map((b) => (
          <div key={b.symbol} className="text-xs p-2 rounded" style={{ background: "oklch(0.22 0.03 258)" }}>
            <div className="text-white font-medium">{b.symbol.replace('USDT', '')}</div>
            <div className="text-yellow-400 font-mono">${Number(b.totalFee).toFixed(2)}</div>
            <div className="text-gray-500">{b.tradeCount} 笔</div>
          </div>
        ))}
      </div>
    </div>
  );
}


// ─── Section: API Keys ───────────────────────────────────────────────────────
function ApiKeysSection() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const { data, isLoading, refetch } = trpc.admin.listApiKeys.useQuery({ page, pageSize: 30, search: search || undefined, includeRevoked });
  const revoke = trpc.admin.revokeApiKey.useMutation({
    onSuccess: () => { toast.success("API Key 已撤销"); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const active = data?.rows.filter((k) => !k.revokedAt).length ?? 0;
  const used = data?.rows.filter((k) => k.lastUsedAt && !k.revokedAt).length ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white">API Key 风控</h2>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="搜索 Key / 标签 / 用户ID" className="px-3 py-1.5 rounded-lg text-sm text-white placeholder-gray-500 outline-none w-64"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={includeRevoked} onChange={(e) => { setIncludeRevoked(e.target.checked); setPage(1); }} />
          包含已撤销
        </label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <KpiCard label="当前页活跃 Key" value={active} sub="未撤销" color="#4ade80" />
        <KpiCard label="当前页曾使用 Key" value={used} sub="lastUsedAt 非空" color="#60a5fa" />
        <KpiCard label="检索总数" value={data?.total ?? 0} sub="符合筛选条件" color="#f59e0b" />
      </div>
      <div className="rounded-xl overflow-hidden" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-white/10">
                <th className="text-left py-3 px-3">ID</th>
                <th className="text-left py-3 px-3">用户</th>
                <th className="text-left py-3 px-3">标签</th>
                <th className="text-left py-3 px-3">Public Key</th>
                <th className="text-left py-3 px-3">权限</th>
                <th className="text-left py-3 px-3">IP 白名单</th>
                <th className="text-left py-3 px-3">最近使用</th>
                <th className="text-left py-3 px-3">状态</th>
                <th className="text-left py-3 px-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={9} className="text-center py-8 text-gray-500">加载中...</td></tr>}
              {data?.rows.map((k) => (
                <tr key={k.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-2 px-3 text-gray-400 font-mono">{k.id}</td>
                  <td className="py-2 px-3 text-gray-300 font-mono">#{k.userId}</td>
                  <td className="py-2 px-3 text-white">{k.label}</td>
                  <td className="py-2 px-3 text-gray-400 font-mono">{k.maskedKey}</td>
                  <td className="py-2 px-3 text-gray-300">读取{k.permissions.trade ? "、交易" : ""}{k.permissions.withdraw ? "、提现" : ""}</td>
                  <td className="py-2 px-3 text-gray-400 max-w-xs">{k.ipWhitelist?.length ? k.ipWhitelist.join(", ") : "不限"}</td>
                  <td className="py-2 px-3 text-gray-500">{fmtDate(k.lastUsedAt)}</td>
                  <td className="py-2 px-3">
                    <span className="px-2 py-0.5 rounded text-xs" style={{ background: k.revokedAt ? "#6b728022" : "#4ade8022", color: k.revokedAt ? "#9ca3af" : "#4ade80" }}>
                      {k.revokedAt ? "已撤销" : "活跃"}
                    </span>
                    <span className="ml-2 text-[10px] text-gray-500">{k.secretEncrypted ? "已加密" : "旧版明文"}</span>
                  </td>
                  <td className="py-2 px-3">
                    {!k.revokedAt && (
                      <button onClick={() => revoke.mutate({ id: k.id, note: "后台风控撤销" })} disabled={revoke.isPending}
                        className="px-2 py-1 rounded text-xs text-red-300 disabled:opacity-50" style={{ background: "#ef444422" }}>
                        撤销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!isLoading && data?.rows.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-gray-500">无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination page={page} total={data?.total ?? 0} pageSize={30} onChange={setPage} />
    </div>
  );
}

// ─── Section: Risk ──────────────────────────────────────────────────────────
function RiskSection() {
  const [checkUserId, setCheckUserId] = useState("");
  const { data: alerts } = trpc.admin.riskAlerts.useQuery(undefined, { refetchInterval: 30000 });
  const { data: snapshot } = trpc.admin.balanceSnapshot.useQuery();
  const { data: check } = trpc.admin.balanceConsistencyCheck.useQuery(
    { userId: Number(checkUserId) },
    { enabled: !!checkUserId && !isNaN(Number(checkUserId)) }
  );

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white">风控系统</h2>

      {/* Risk alerts */}
      <div className="rounded-xl p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="text-sm font-medium text-gray-300 mb-3">实时风险预警</div>
        {(!alerts || alerts.length === 0) && <div className="text-green-400 text-sm">✓ 暂无风险预警</div>}
        {alerts?.map((a, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3 rounded-lg text-sm mb-2"
            style={{ background: a.level === "critical" ? "#7f1d1d33" : a.level === "high" ? "#78350f33" : "#1e3a5f33", border: `1px solid ${a.level === "critical" ? "#f87171" : a.level === "high" ? "#f59e0b" : "#60a5fa"}44` }}>
            <span style={{ color: a.level === "critical" ? "#f87171" : a.level === "high" ? "#f59e0b" : "#60a5fa" }}>
              {a.level === "critical" ? "🔴 严重" : a.level === "high" ? "🟠 高" : "🔵 中"}
            </span>
            <span className="text-gray-200">{a.message}</span>
          </div>
        ))}
      </div>

      {/* Balance snapshot */}
      <div className="rounded-xl p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="text-sm font-medium text-gray-300 mb-3">平台资产快照</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {snapshot?.map((s) => (
            <div key={s.asset} className="p-3 rounded-lg" style={{ background: "oklch(0.22 0.03 258)" }}>
              <div className="text-white font-bold">{s.asset}</div>
              <div className="text-xs mt-1">
                <div className="text-green-400">可用: {fmt(s.totalAvailable)}</div>
                <div className="text-yellow-400">冻结: {fmt(s.totalLocked)}</div>
                <div className="text-gray-400">账户数: {s.accountCount}</div>
              </div>
            </div>
          ))}
          {(!snapshot || snapshot.length === 0) && <div className="text-gray-500 text-sm col-span-4">暂无数据</div>}
        </div>
      </div>

      {/* Platform PnL estimate */}
      <div className="rounded-xl p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="text-sm font-medium text-gray-300 mb-3">平台损益估算（近30天）</div>
        <PlatformPnLCard />
      </div>

      {/* Balance consistency check */}
      <div className="rounded-xl p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="text-sm font-medium text-gray-300 mb-3">余额一致性校验</div>
        <div className="flex gap-3 mb-3">
          <input value={checkUserId} onChange={(e) => setCheckUserId(e.target.value)}
            placeholder="输入用户ID进行校验" className="px-3 py-1.5 rounded-lg text-sm text-white placeholder-gray-500 outline-none"
            style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }} />
        </div>
        {check && check.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-white/10">
                  <th className="text-left py-2 px-3">币种</th>
                  <th className="text-right py-2 px-3">账户可用</th>
                  <th className="text-right py-2 px-3">账本累计</th>
                  <th className="text-right py-2 px-3">差额</th>
                  <th className="text-left py-2 px-3">状态</th>
                </tr>
              </thead>
              <tbody>
                {check.map((c) => (
                  <tr key={c.asset} className="border-b border-white/5">
                    <td className="py-2 px-3 text-white font-medium">{c.asset}</td>
                    <td className="py-2 px-3 text-right font-mono text-gray-300">{fmt(c.actualAvailable, 6)}</td>
                    <td className="py-2 px-3 text-right font-mono text-gray-300">{fmt(c.ledgerAvailable, 6)}</td>
                    <td className="py-2 px-3 text-right font-mono" style={{ color: c.availableMatch ? "#4ade80" : "#f87171" }}>
                      {fmt(c.availableDiff, 8)}
                    </td>
                    <td className="py-2 px-3">
                      {c.availableMatch
                        ? <span className="text-green-400">✓ 一致</span>
                        : <span className="text-red-400">⚠ 不一致</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Section: System ──────────────────────────────────────────────────────────
function SystemSection() {
  const utils = trpc.useUtils();
  const { data: mode } = trpc.admin.getPlatformMode.useQuery();
  const { data: sources } = trpc.admin.marketSources.useQuery(undefined, { refetchInterval: 10000 });
  const { data: hedgeLog } = trpc.admin.hedgeLog.useQuery();
  const setMode = trpc.admin.setPlatformMode.useMutation({
    onSuccess: (r) => { toast.success(`已切换为「${r.mode === "hedged" ? "自动做市模式" : "撮合成交模式"}」`); utils.admin.getPlatformMode.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const currentMode = mode?.mode ?? "internal_only";
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white">系统设置</h2>
      {/* Platform mode switch */}
      <div className="rounded-xl p-5" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-semibold text-white">成交模式</div>
            <div className="text-xs text-gray-500 mt-0.5">控制用户挂单的成交方式</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium px-2 py-1 rounded-full" style={{ background: currentMode === "hedged" ? "rgba(74,222,128,0.15)" : "rgba(96,165,250,0.15)", color: currentMode === "hedged" ? "#4ade80" : "#60a5fa" }}>
              {currentMode === "hedged" ? "● 自动做市" : "● 撮合成交"}
            </span>
          </div>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          {/* Mode 1: internal_only */}
          <button
            onClick={() => setMode.mutate({ mode: "internal_only" })}
            disabled={setMode.isPending}
            className="relative rounded-xl p-4 text-left transition-all disabled:opacity-50"
            style={{
              background: currentMode === "internal_only" ? "oklch(0.22 0.06 262)" : "oklch(0.20 0.02 258)",
              border: currentMode === "internal_only" ? "2px solid oklch(0.62 0.22 262)" : "2px solid oklch(0.28 0.04 258)",
              cursor: "pointer",
            }}>
            {currentMode === "internal_only" && (
              <span className="absolute top-3 right-3 text-xs px-2 py-0.5 rounded-full" style={{ background: "oklch(0.62 0.22 262)", color: "#fff" }}>当前</span>
            )}
            <div className="text-2xl mb-2">🔄</div>
            <div className="text-sm font-semibold text-white mb-1">撮合成交模式</div>
            <div className="text-xs leading-relaxed" style={{ color: "#9ca3af" }}>
              用户挂单只与订单簿中的真实对手方撮合成交。平台可通过 API 向订单簿注入买卖单提供流动性，纯市场化定价。
            </div>
            <div className="mt-3 text-xs" style={{ color: "#60a5fa" }}>适合：用户量大 / 有做市商接入</div>
          </button>
          {/* Mode 2: hedged */}
          <button
            onClick={() => setMode.mutate({ mode: "hedged" })}
            disabled={setMode.isPending}
            className="relative rounded-xl p-4 text-left transition-all disabled:opacity-50"
            style={{
              background: currentMode === "hedged" ? "oklch(0.20 0.06 145)" : "oklch(0.20 0.02 258)",
              border: currentMode === "hedged" ? "2px solid #4ade80" : "2px solid oklch(0.28 0.04 258)",
              cursor: "pointer",
            }}>
            {currentMode === "hedged" && (
              <span className="absolute top-3 right-3 text-xs px-2 py-0.5 rounded-full" style={{ background: "#4ade80", color: "#000" }}>当前</span>
            )}
            <div className="text-2xl mb-2">⚡</div>
            <div className="text-sm font-semibold text-white mb-1">自动做市模式</div>
            <div className="text-xs leading-relaxed" style={{ color: "#9ca3af" }}>
              当主行情通道价格满足用户挂单条件时，系统可按配置提供平台流动性补充，提升早期市场成交连续性。
            </div>
            <div className="mt-3 text-xs" style={{ color: "#4ade80" }}>适合：平台初期 / 流动性不足时</div>
          </button>
        </div>
        <div className="mt-4 p-3 rounded-lg text-xs" style={{ background: "oklch(0.15 0.02 258)", color: "#9ca3af" }}>
          {currentMode === "hedged"
            ? "自动流动性模式：主行情通道满足挂单条件时，系统按风控配置补充流动性；内部订单簿撮合仍保持优先。"
            : "订单簿撮合模式：挂单在平台订单簿内等待对手方成交，行情通道仅用于价格展示与风控参考。"}
        </div>
      </div>
      {/* Data sources */}
      <div className="rounded-xl p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="text-sm font-medium text-gray-300 mb-3">行情数据源状态</div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { name: "主行情通道", key: "binance" as const },
            { name: "备行情通道 A", key: "okx" as const },
            { name: "备行情通道 B", key: "hyperliquid" as const },
          ].map(({ name, key }) => (
            <div key={key} className="flex items-center gap-3 p-3 rounded-lg" style={{ background: "oklch(0.22 0.03 258)" }}>
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: sources?.[key] ? "#4ade80" : "#f87171", boxShadow: sources?.[key] ? "0 0 6px #4ade80" : "0 0 6px #f87171" }} />
              <span className="text-white text-sm">{name}</span>
              <span className="text-xs ml-auto" style={{ color: sources?.[key] ? "#4ade80" : "#f87171" }}>
                {sources?.[key] ? "在线" : "离线"}
              </span>
            </div>
          ))}
        </div>
      </div>
      {/* Hedge log */}
      <div className="rounded-xl p-4" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="text-sm font-medium text-gray-300 mb-3">风险覆盖意图日志（最近100条）</div>
        {(!hedgeLog || hedgeLog.length === 0) && <div className="text-gray-500 text-sm">暂无风险覆盖记录</div>}
        <div className="max-h-64 overflow-y-auto">
          {hedgeLog?.map((h: any, i: number) => (
            <div key={i} className="flex items-center gap-3 py-1.5 border-b border-white/5 text-xs">
              <span className="text-gray-500">{fmtDate(h.ts)}</span>
              <span className={h.side === "buy" ? "text-green-400" : "text-red-400"}>{h.side?.toUpperCase()}</span>
              <span className="text-white">{h.symbol}</span>
              <span className="font-mono text-gray-300">{fmt(h.qty, 4)}</span>
              <span className="font-mono text-gray-400">@ {fmt(h.price, 4)}</span>
              <span className="text-gray-500">{{ binance: "主行情通道", okx: "备行情通道 A", hyperliquid: "备行情通道 B" }[String(h.exchange || "").toLowerCase()] || "运营通道"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
// ─── Section: Admin Logs ──────────────────────────────────────────────────────
function LogsSection() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const { data, isLoading } = trpc.admin.getAdminLogs.useQuery(
    { page, pageSize: 50, action: action || undefined }
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white">管理员操作日志</h2>
        <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}
          className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
          style={{ background: "oklch(0.22 0.03 258)", border: "1px solid oklch(0.32 0.04 258)" }}>
          <option value="">全部操作</option>
          <option value="ban_user">封禁用户</option>
          <option value="unban_user">解封用户</option>
          <option value="set_user_role">修改角色</option>
          <option value="adjust_balance">调整余额</option>
          <option value="simulate_deposit">运营入账</option>
          <option value="force_cancel_order">强制撤单</option>
          <option value="bulk_cancel_orders">批量撤单</option>
          <option value="approve_withdrawal">批准提现</option>
          <option value="reject_withdrawal">驳回提现</option>
          <option value="update_market_fees">修改手续费</option>
          <option value="update_market">修改交易对</option>
          <option value="set_platform_mode">切换模式</option>
        </select>
      </div>

      <div className="rounded-xl overflow-hidden" style={{ background: "oklch(0.18 0.03 258)", border: "1px solid oklch(0.28 0.04 258)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-white/10">
                <th className="text-left py-3 px-3">ID</th>
                <th className="text-left py-3 px-3">管理员</th>
                <th className="text-left py-3 px-3">操作</th>
                <th className="text-left py-3 px-3">目标类型</th>
                <th className="text-left py-3 px-3">目标ID</th>
                <th className="text-left py-3 px-3">变更前</th>
                <th className="text-left py-3 px-3">变更后</th>
                <th className="text-left py-3 px-3">备注</th>
                <th className="text-left py-3 px-3">时间</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={9} className="text-center py-8 text-gray-500">加载中...</td></tr>}
              {data?.rows.map((l) => (
                <tr key={l.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-2 px-3 text-gray-400 font-mono">{l.id}</td>
                  <td className="py-2 px-3 text-purple-300">{l.adminName ?? `#${l.adminId}`}</td>
                  <td className="py-2 px-3">
                    <span className="px-2 py-0.5 rounded text-xs" style={{ background: "oklch(0.25 0.04 258)", color: "#60a5fa" }}>{ACTION_LABELS[l.action] ?? l.action}</span>
                  </td>
                  <td className="py-2 px-3 text-gray-400">{TARGET_TYPE_LABELS[l.targetType ?? ""] ?? l.targetType ?? "—"}</td>
                  <td className="py-2 px-3 text-gray-400 font-mono">{l.targetId ?? "—"}</td>
                  <td className="py-2 px-3 text-gray-500 max-w-xs">{formatLogChange(l.before)}</td>
                  <td className="py-2 px-3 text-gray-300 max-w-xs">{formatLogChange(l.after)}</td>
                  <td className="py-2 px-3 text-gray-500">{l.note ?? "—"}</td>
                  <td className="py-2 px-3 text-gray-500">{fmtDate(l.createdAt)}</td>
                </tr>
              ))}
              {!isLoading && data?.rows.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-gray-500">无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination page={page} total={data?.total ?? 0} pageSize={50} onChange={setPage} />
    </div>
  );
}

// ─── Sidebar nav config ───────────────────────────────────────────────────────
const NAV_ITEMS: { section: Section; label: string; icon: string; group: string }[] = [
  { section: "overview", label: "概览仪表盘", icon: "📊", group: "主要" },
  { section: "users", label: "用户管理", icon: "👥", group: "业务" },
  { section: "orders", label: "订单管理", icon: "📋", group: "业务" },
  { section: "trades", label: "成交记录", icon: "💹", group: "业务" },
  { section: "deposits", label: "充值管理", icon: "⬇️", group: "资金" },
  { section: "withdrawals", label: "提现管理", icon: "⬆️", group: "资金" },
  { section: "ledger", label: "账本流水", icon: "📒", group: "资金" },
  { section: "fees", label: "手续费 & 交易对", icon: "⚙️", group: "配置" },
  { section: "apiKeys", label: "API Key", icon: "🔑", group: "安全" },
  { section: "risk", label: "风控系统", icon: "🛡️", group: "安全" },
  { section: "system", label: "系统设置", icon: "🔧", group: "安全" },
  { section: "logs", label: "操作日志", icon: "📝", group: "安全" },
];

const isSection = (value: string | undefined): value is Section =>
  Boolean(value && NAV_ITEMS.some((item) => item.section === value));

function sectionFromBrowserPath(pathname: string): Section {
  const path = pathname.split("?")[0].split("#")[0];
  const parts = path.split("/").filter(Boolean);
  const candidate = (parts[0] === "admin" || parts[0] === "admin-panel") ? parts[1] : undefined;
  return isSection(candidate) ? candidate : "overview";
}

function adminBrowserPath(section: Section) {
  return section === "overview" ? "/admin" : `/admin/${section}`;
}

// ─── Main AdminPanel component ────────────────────────────────────────────────
export default function AdminPanel() {
  const [location, navigate] = useLocation();
  const { user, loading: authLoading } = useAuth();
  const [section, setSection] = useState<Section>(() => sectionFromBrowserPath(location));

  useEffect(() => {
    const next = sectionFromBrowserPath(location);
    setSection((current) => (current === next ? current : next));
  }, [location]);

  const openSection = useCallback((next: Section) => {
    setSection(next);
    navigate(adminBrowserPath(next));
  }, [navigate]);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: "oklch(0.12 0.03 260)" }}>
        <div className="text-gray-400">验证身份中...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: "oklch(0.12 0.03 260)" }}>
        <div className="text-center">
          <div className="text-gray-300 mb-4">请先登录</div>
          <button onClick={() => navigate("/")} className="px-4 py-2 rounded-lg text-white text-sm" style={{ background: "oklch(0.62 0.22 262)" }}>
            返回首页
          </button>
        </div>
      </div>
    );
  }

  if (user.role !== "admin") {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: "oklch(0.12 0.03 260)" }}>
        <div className="text-center">
          <div className="text-red-400 text-lg mb-2">🚫 权限不足</div>
          <div className="text-gray-400 text-sm mb-4">仅管理员可访问后台系统</div>
          <button onClick={() => navigate("/")} className="px-4 py-2 rounded-lg text-white text-sm" style={{ background: "oklch(0.62 0.22 262)" }}>
            返回首页
          </button>
        </div>
      </div>
    );
  }

  const groups = Array.from(new Set(NAV_ITEMS.map((n) => n.group)));

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "oklch(0.12 0.03 260)", color: "#e2e8f0", fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 flex flex-col border-r overflow-y-auto" style={{ background: "oklch(0.15 0.03 260)", borderColor: "oklch(0.25 0.04 258)" }}>
        {/* Logo */}
        <div className="px-4 py-4 border-b" style={{ borderColor: "oklch(0.25 0.04 258)" }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold" style={{ background: "oklch(0.62 0.22 262)" }}>A</div>
            <div>
              <div className="text-sm font-bold text-white">Admin Panel</div>
              <div className="text-xs text-gray-500">管理后台</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3">
          {groups.map((group) => (
            <div key={group} className="mb-4">
              <div className="px-2 py-1 text-xs font-medium text-gray-600 uppercase tracking-wider">{group}</div>
              {NAV_ITEMS.filter((n) => n.group === group).map((item) => (
                <button key={item.section} onClick={() => openSection(item.section)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors mb-0.5"
                  style={{
                    background: section === item.section ? "oklch(0.62 0.22 262 / 0.2)" : "transparent",
                    color: section === item.section ? "oklch(0.75 0.18 262)" : "#9ca3af",
                    borderLeft: section === item.section ? "2px solid oklch(0.62 0.22 262)" : "2px solid transparent",
                  }}>
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* User info */}
        <div className="px-3 py-3 border-t" style={{ borderColor: "oklch(0.25 0.04 258)" }}>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: "oklch(0.62 0.22 262)" }}>
              {(user.name ?? "A")[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-white truncate">{user.name ?? "管理员"}</div>
              <div className="text-xs text-purple-400">admin</div>
            </div>
          </div>
          <button onClick={() => navigate("/")}
            className="w-full py-1.5 rounded-lg text-xs text-gray-400 transition-colors hover:text-white"
            style={{ background: "oklch(0.22 0.03 258)" }}>
            ← 返回交易所
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-3 border-b flex-shrink-0" style={{ background: "oklch(0.15 0.03 260)", borderColor: "oklch(0.25 0.04 258)" }}>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span>后台管理</span>
            <span>/</span>
            <span className="text-white">{NAV_ITEMS.find((n) => n.section === section)?.label}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>管理员: {user.name}</span>
            <div className="w-2 h-2 rounded-full bg-green-400" title="系统正常" />
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {section === "overview" && <OverviewSection />}
          {section === "users" && <UsersSection />}
          {section === "orders" && <OrdersSection />}
          {section === "trades" && <TradesSection />}
          {section === "deposits" && <DepositsSection />}
          {section === "withdrawals" && <WithdrawalsSection />}
          {section === "ledger" && <LedgerSection />}
          {section === "fees" && <MarketsSection />}
          {section === "apiKeys" && <ApiKeysSection />}
          {section === "risk" && <RiskSection />}
          {section === "system" && <SystemSection />}
          {section === "logs" && <LogsSection />}
        </div>
      </main>
    </div>
  );
}
