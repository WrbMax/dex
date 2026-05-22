/**
 * ConnectWallet — Rabbit App Bridge login screen
 *
 * Shown when user is not authenticated. In Rabbit App WebView environment,
 * it auto-initiates the bridge login flow. Shows a loading/status screen
 * while authentication is in progress.
 */
import { AlertCircle, Loader2, ShieldCheck, TrendingUp, Wallet } from "lucide-react";
import { useRabbitBridge, isInRabbitApp } from "@/_core/hooks/useRabbitBridge";

const statusText: Record<string, string> = {
  requesting_address: "正在获取钱包地址...",
  fetching_nonce: "正在请求认证...",
  requesting_signature: "等待签名确认...",
  verifying: "正在验证身份...",
  success: "登录成功",
};

export function ConnectWallet() {
  const { state, connect, reset, isInRabbitApp: inApp } = useRabbitBridge();
  const isLoading = ["requesting_address", "fetching_nonce", "requesting_signature", "verifying"].includes(state.status);

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-6 py-10 relative overflow-hidden">
      {/* Background decorative elements */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute rounded-full"
          style={{
            top: "-15%",
            left: "-15%",
            width: "70%",
            paddingBottom: "70%",
            background:
              "radial-gradient(circle, oklch(0.62 0.22 262 / 0.12) 0%, transparent 65%)",
          }}
        />
        <div
          className="absolute rounded-full"
          style={{
            bottom: "-20%",
            right: "-20%",
            width: "60%",
            paddingBottom: "60%",
            background:
              "radial-gradient(circle, oklch(0.55 0.22 300 / 0.10) 0%, transparent 65%)",
          }}
        />
      </div>
      <div className="relative z-10 w-full max-w-[360px] flex flex-col items-center gap-8">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg"
            style={{
              background:
                "linear-gradient(135deg, oklch(0.62 0.22 262), oklch(0.52 0.24 280))",
            }}
          >
            <TrendingUp className="w-8 h-8 text-white" />
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold tracking-tight text-foreground">
              WallDex
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              Rabbit Wallet Exchange
            </div>
          </div>
        </div>
        {/* Card */}
        <div
          className="w-full rounded-2xl p-6 flex flex-col gap-5"
          style={{
            background: "oklch(0.17 0.035 258 / 0.85)",
            border: "1px solid oklch(1 0 0 / 10%)",
            backdropFilter: "blur(20px)",
          }}
        >
          <div className="text-center">
            <div className="text-base font-semibold text-foreground">
              {inApp ? "正在连接 Rabbit 钱包" : "请在 Rabbit App 中打开"}
            </div>
            <div className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              {inApp
                ? "通过 Rabbit 钱包验证身份，无需额外操作"
                : "本交易所仅支持通过 Rabbit App 访问"}
            </div>
          </div>
          {/* Features */}
          <div className="flex flex-col gap-2.5">
            {[
              { icon: ShieldCheck, text: "签名不产生链上交易，无 Gas 费用" },
              { icon: Wallet, text: "Rabbit 钱包地址即账户，无需注册" },
              { icon: ShieldCheck, text: "安全加密通信，保护您的资产" },
            ].map(({ icon: Icon, text }, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <Icon className="w-4 h-4 text-primary shrink-0" />
                <span className="text-xs text-muted-foreground">{text}</span>
              </div>
            ))}
          </div>
          {/* Status / Error */}
          {state.status === "error" && (
            <div
              className="flex items-start gap-2 p-3 rounded-xl text-xs"
              style={{ background: "oklch(0.66 0.22 20 / 0.1)", border: "1px solid oklch(0.66 0.22 20 / 0.25)" }}
            >
              <AlertCircle className="w-4 h-4 text-down shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-down mb-0.5">连接失败</div>
                <div className="text-muted-foreground">{state.message}</div>
              </div>
            </div>
          )}
          {isLoading && (
            <div
              className="flex items-center gap-2 p-3 rounded-xl text-xs"
              style={{ background: "oklch(0.62 0.22 262 / 0.1)", border: "1px solid oklch(0.62 0.22 262 / 0.25)" }}
            >
              <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
              <span className="text-primary">{statusText[state.status]}</span>
            </div>
          )}
          {/* Connect Button — only shown if not auto-connecting or on error */}
          {(!inApp || state.status === "error" || state.status === "idle") && (
            <button
              className="w-full h-12 rounded-xl font-semibold text-sm text-white flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background:
                  "linear-gradient(135deg, oklch(0.62 0.22 262), oklch(0.52 0.24 280))",
                boxShadow: "0 4px 20px oklch(0.62 0.22 262 / 0.3)",
              }}
              onClick={state.status === "error" ? () => { reset(); connect(); } : connect}
              disabled={isLoading || state.status === "success"}
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wallet className="w-4 h-4" />
              )}
              {state.status === "error" ? "重新连接" : "连接 Rabbit 钱包"}
            </button>
          )}
          {/* Auto-connecting indicator when in Rabbit App */}
          {inApp && state.status === "idle" && (
            <div className="flex items-center justify-center gap-2 py-2">
              <Loader2 className="w-4 h-4 text-primary animate-spin" />
              <span className="text-xs text-muted-foreground">正在初始化...</span>
            </div>
          )}
          <div className="text-center text-[11px] text-muted-foreground leading-relaxed">
            连接即表示您同意本平台的服务条款
          </div>
        </div>
        {/* Footer */}
        <div className="text-[11px] text-muted-foreground/50 text-center">
          WallDex · Powered by Rabbit Wallet
        </div>
      </div>
    </div>
  );
}
