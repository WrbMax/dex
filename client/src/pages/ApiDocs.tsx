import { Link } from "wouter";
import { ChevronLeft } from "lucide-react";

/**
 * Developer documentation page for the exchange's public REST + WebSocket
 * API. The public interface follows a standard spot-trading REST + WebSocket style
 * and keeps implementation details transparent to end users.
 */
export default function ApiDocs() {
  return (
    <div className="w-full px-4 pt-3 pb-8 safe-top text-[13.5px] leading-relaxed">
      <header className="flex items-center gap-2 mb-4">
        <Link href="/me">
          <button className="p-1 -ml-1 text-muted-foreground">
            <ChevronLeft className="w-6 h-6" />
          </button>
        </Link>
        <h1 className="text-lg font-semibold">开发者 API 文档</h1>
      </header>

      <section className="bg-card rounded-2xl p-4 mb-4">
        <div className="font-semibold mb-2">概览</div>
        <p className="text-muted-foreground">
          本交易所对外提供标准现货交易 REST + WebSocket 接口，覆盖行情查询、订单簿、近期成交、账户余额、下单与撤单等核心能力。
          所有 timestamp 以毫秒为单位；所有金额、价格均为字符串以避免精度损失。
        </p>
      </section>

      <section className="bg-card rounded-2xl p-4 mb-4">
        <div className="font-semibold mb-2">认证与签名</div>
        <ul className="list-disc list-inside space-y-1 text-muted-foreground">
          <li>
            在「我的 · API 管理」创建 API Key，可选配置 IP 白名单，拿到 <code>apiKey</code> 与
            <code> secret</code>。请求头 <code>X-WALLDEX-APIKEY</code> 传入 apiKey。
          </li>
          <li>
            对完整 query string（不含 <code>signature</code>）做 HMAC-SHA256，
            密钥为 secret，将 hex 结果作为 <code>signature</code> 查询参数附加。
          </li>
          <li>
            必须带 <code>timestamp</code>（毫秒），服务器允许 ±60s 窗口；
            超时拒绝。<code>recvWindow</code> 暂不支持自定义。
          </li>
          <li>
            充值与提现以页面提交为准，支持用户输入任意代币符号与任意目标地址；API Key 当前聚焦现货交易，不开放独立链上划转接口。
          </li>
        </ul>
      </section>

      <section className="bg-card rounded-2xl p-4 mb-4">
        <div className="font-semibold mb-2">限流</div>
        <ul className="list-disc list-inside space-y-1 text-muted-foreground">
          <li>默认 600 req/min per API Key（私密路径）+ 120 次突发。</li>
          <li>public 路径按客户端 IP 计；配额相同。</li>
          <li>触发时返回 <code>HTTP 429</code>，body: <code>{"{ code: -1003 }"}</code>；响应头包含 <code>Retry-After</code>、<code>X-RateLimit-Limit</code>。</li>
        </ul>
      </section>

      <section className="bg-card rounded-2xl p-4 mb-4">
        <div className="font-semibold mb-2">公开 REST 端点（无需签名）</div>
        <Endpoint method="GET" path="/api/v1/ping" desc="心跳检测" />
        <Endpoint method="GET" path="/api/v1/time" desc="服务器时间（毫秒）" />
        <Endpoint method="GET" path="/api/v1/exchangeInfo" desc="交易对元数据（精度、步长）" />
        <Endpoint method="GET" path="/api/v1/ticker/24hr?symbol=BTCUSDT" desc="24 小时统计" />
        <Endpoint method="GET" path="/api/v1/klines?symbol=BTCUSDT&interval=1m" desc="K 线（当前仅支持 1m）" />
        <Endpoint method="GET" path="/api/v1/depth?symbol=BTCUSDT&limit=20" desc="订单簿快照" />
        <Endpoint method="GET" path="/api/v1/trades?symbol=BTCUSDT&limit=30" desc="最近成交" />
      </section>

      <section className="bg-card rounded-2xl p-4 mb-4">
        <div className="font-semibold mb-2">私密 REST 端点（需签名）</div>
        <Endpoint method="GET" path="/api/v1/account" desc="账户余额" />
        <Endpoint method="GET" path="/api/v1/openOrders" desc="未完结订单列表" />
        <Endpoint method="GET" path="/api/v1/order?orderId=..." desc="查询单笔订单" />
        <Endpoint method="GET" path="/api/v1/myTrades?symbol=BTCUSDT" desc="个人成交记录" />
        <Endpoint method="POST" path="/api/v1/order" desc="下单：symbol,side,type,quantity,price?" />
        <Endpoint method="DELETE" path="/api/v1/order?orderId=..." desc="撤单" />
      </section>

      <section className="bg-card rounded-2xl p-4 mb-4">
        <div className="font-semibold mb-2">WebSocket</div>
        <p className="text-muted-foreground mb-2">连接到 <code>wss://&lt;host&gt;/ws/v1/public</code>，发送以下格式订阅：</p>
        <pre className="bg-secondary rounded-lg p-3 text-xs overflow-auto">
{`{
  "method": "SUBSCRIBE",
  "params": [
    "btcusdt@ticker",
    "btcusdt@depth",
    "btcusdt@trade",
    "btcusdt@kline_1m"
  ],
  "id": 1
}`}
        </pre>
        <p className="text-muted-foreground mt-2">
          每个频道都会在订阅时发送快照，并随后持续推送增量。<code>UNSUBSCRIBE</code> 与 SUBSCRIBE 对称。
        </p>
      </section>

      <section className="bg-card rounded-2xl p-4 text-muted-foreground text-xs">
        本 API 当前聚焦现货交易场景；若需要保证金、合约、多报价币种或机构级扩展字段，请联系平台方开通。流动性与风控策略由平台后台统一调度，对 API 用户保持透明。
      </section>
    </div>
  );
}

function Endpoint({ method, path, desc }: { method: string; path: string; desc: string }) {
  const badge =
    method === "GET"
      ? "bg-primary/10 text-primary"
      : method === "POST"
      ? "bg-up/10 text-up"
      : "bg-down/10 text-down";
  return (
    <div className="flex gap-2 py-1.5 border-b last:border-0 border-border/50">
      <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${badge} shrink-0`}>
        {method}
      </span>
      <code className="text-xs font-mono shrink-0">{path}</code>
      <span className="text-xs text-muted-foreground ml-auto text-right">{desc}</span>
    </div>
  );
}
