/**
 * useWeb3Auth — Web3 wallet sign-in hook
 *
 * Supports MetaMask (window.ethereum) and any EIP-1193 provider.
 * Falls back to a "copy address" manual flow for embedded wallet contexts.
 */
import { useState, useCallback } from "react";

export type Web3AuthState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "signing" }
  | { status: "verifying" }
  | { status: "success"; address: string }
  | { status: "error"; message: string };

function buildSignMessage(address: string, nonce: string): string {
  return `欢迎登录 WallDex 交易所！\n\n请签名此消息以验证您的钱包所有权。\n\n钱包地址: ${address}\n随机码: ${nonce}\n\n此签名不会产生任何链上交易，也不会消耗 Gas。`;
}

export function useWeb3Auth() {
  const [state, setState] = useState<Web3AuthState>({ status: "idle" });

  const connect = useCallback(async () => {
    setState({ status: "connecting" });
    try {
      // 1. Request wallet connection
      const provider = (window as any).ethereum;
      if (!provider) {
        setState({ status: "error", message: "未检测到钱包插件，请安装 MetaMask 或使用支持 Web3 的浏览器" });
        return;
      }

      let accounts: string[];
      try {
        accounts = await provider.request({ method: "eth_requestAccounts" });
      } catch (err: any) {
        if (err?.code === 4001) {
          setState({ status: "error", message: "用户拒绝了钱包连接请求" });
        } else {
          setState({ status: "error", message: `连接钱包失败: ${err?.message ?? err}` });
        }
        return;
      }

      const address = accounts[0]?.toLowerCase();
      if (!address) {
        setState({ status: "error", message: "未获取到钱包地址" });
        return;
      }

      // 2. Fetch nonce from server
      setState({ status: "signing" });
      const nonceRes = await fetch(`/api/web3/nonce?address=${encodeURIComponent(address)}`);
      if (!nonceRes.ok) {
        const err = await nonceRes.json().catch(() => ({}));
        setState({ status: "error", message: `获取 nonce 失败: ${err.error ?? nonceRes.statusText}` });
        return;
      }
      const { nonce } = await nonceRes.json();

      // 3. Sign the message
      const message = buildSignMessage(address, nonce);
      let signature: string;
      try {
        signature = await provider.request({
          method: "personal_sign",
          params: [message, address],
        });
      } catch (err: any) {
        if (err?.code === 4001) {
          setState({ status: "error", message: "用户拒绝了签名请求" });
        } else {
          setState({ status: "error", message: `签名失败: ${err?.message ?? err}` });
        }
        return;
      }

      // 4. Verify on server
      setState({ status: "verifying" });
      const verifyRes = await fetch("/api/web3/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, signature, nonce }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        setState({ status: "error", message: `验证失败: ${err.error ?? verifyRes.statusText}` });
        return;
      }

      setState({ status: "success", address });
      // Reload to refresh auth state
      window.location.href = "/";
    } catch (err: any) {
      setState({ status: "error", message: err?.message ?? "未知错误" });
    }
  }, []);

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, connect, reset };
}
