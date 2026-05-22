/**
 * useRabbitBridge — Rabbit App Bridge authentication hook
 *
 * This hook handles communication with the Rabbit App via postMessage Bridge.
 * It replaces the old useWeb3Auth hook (MetaMask direct connection).
 *
 * Flow:
 *   1. H5 sends "requestWalletAddress" to Rabbit App via postMessage
 *   2. Rabbit App returns the user's wallet address
 *   3. H5 calls CEX backend /api/web3/nonce with X-Rabbit-App-Token header
 *   4. H5 sends nonce to Rabbit App for signing
 *   5. Rabbit App signs and returns signature
 *   6. H5 calls CEX backend /api/web3/verify with X-Rabbit-App-Token header
 *   7. Session cookie is set, user is authenticated
 */
import { useState, useCallback, useEffect } from "react";

export type RabbitBridgeState =
  | { status: "idle" }
  | { status: "requesting_address" }
  | { status: "fetching_nonce" }
  | { status: "requesting_signature" }
  | { status: "verifying" }
  | { status: "success"; address: string }
  | { status: "error"; message: string };

// The Rabbit App Token is embedded in the H5 bundle.
// In production, this should be injected via environment variable at build time.
const RABBIT_APP_TOKEN = (import.meta as any).env?.VITE_RABBIT_APP_TOKEN ?? "";

/**
 * Build the sign message — must match server-side buildSignMessage exactly.
 */
function buildSignMessage(address: string, nonce: string): string {
  return `Welcome to WallDex Exchange!\n\nPlease sign this message to verify your wallet ownership.\n\nWallet: ${address}\nNonce: ${nonce}\n\nThis signature will not initiate any on-chain transaction or cost gas.`;
}

/**
 * Send a message to Rabbit App via postMessage Bridge.
 * Returns a Promise that resolves when Rabbit App responds.
 */
function sendToRabbit<T = any>(action: string, payload: Record<string, any> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const messageId = `${action}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error(`Rabbit Bridge timeout: ${action}`));
    }, 30000); // 30s timeout for user interaction (signing)

    function handler(event: MessageEvent) {
      const data = event.data;
      if (data?.source !== "rabbit-app" || data?.messageId !== messageId) return;
      window.removeEventListener("message", handler);
      clearTimeout(timeout);
      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve(data.payload as T);
      }
    }

    window.addEventListener("message", handler);

    // Send to parent (Rabbit App WebView)
    const message = {
      source: "walldex-h5",
      messageId,
      action,
      payload,
    };

    // In WebView, parent is the native app bridge
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, "*");
    } else if ((window as any).ReactNativeWebView) {
      // React Native WebView bridge
      (window as any).ReactNativeWebView.postMessage(JSON.stringify(message));
    } else if ((window as any).webkit?.messageHandlers?.rabbitBridge) {
      // iOS WKWebView bridge
      (window as any).webkit.messageHandlers.rabbitBridge.postMessage(message);
    } else if ((window as any).RabbitBridge) {
      // Android JSInterface bridge
      (window as any).RabbitBridge.postMessage(JSON.stringify(message));
    } else {
      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      reject(new Error("未检测到 Rabbit App 环境"));
    }
  });
}

/**
 * Check if we are running inside Rabbit App WebView
 */
export function isInRabbitApp(): boolean {
  return Boolean(
    (window.parent && window.parent !== window) ||
    (window as any).ReactNativeWebView ||
    (window as any).webkit?.messageHandlers?.rabbitBridge ||
    (window as any).RabbitBridge
  );
}

export function useRabbitBridge() {
  const [state, setState] = useState<RabbitBridgeState>({ status: "idle" });

  const connect = useCallback(async () => {
    setState({ status: "requesting_address" });
    try {
      // 1. Request wallet address from Rabbit App
      const { address } = await sendToRabbit<{ address: string }>("getWalletAddress");
      if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        setState({ status: "error", message: "从 Rabbit 获取的钱包地址无效" });
        return;
      }
      const normalized = address.toLowerCase();

      // 2. Fetch nonce from CEX backend (with Rabbit App Token)
      setState({ status: "fetching_nonce" });
      const nonceRes = await fetch(`/api/web3/nonce?address=${encodeURIComponent(normalized)}`, {
        headers: {
          "X-Rabbit-App-Token": RABBIT_APP_TOKEN,
        },
      });
      if (!nonceRes.ok) {
        const err = await nonceRes.json().catch(() => ({}));
        setState({ status: "error", message: `获取 nonce 失败: ${err.error ?? nonceRes.statusText}` });
        return;
      }
      const { nonce } = await nonceRes.json();

      // 3. Request Rabbit App to sign the message
      setState({ status: "requesting_signature" });
      const message = buildSignMessage(normalized, nonce);
      const { signature } = await sendToRabbit<{ signature: string }>("signMessage", {
        message,
        address: normalized,
      });
      if (!signature) {
        setState({ status: "error", message: "签名失败：未获取到签名" });
        return;
      }

      // 4. Verify signature on CEX backend (with Rabbit App Token)
      setState({ status: "verifying" });
      const verifyRes = await fetch("/api/web3/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rabbit-App-Token": RABBIT_APP_TOKEN,
        },
        body: JSON.stringify({ address: normalized, signature, nonce }),
      });
      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        setState({ status: "error", message: `验证失败: ${err.error ?? verifyRes.statusText}` });
        return;
      }

      setState({ status: "success", address: normalized });
      // Reload to refresh auth state
      window.location.href = "/";
    } catch (err: any) {
      setState({ status: "error", message: err?.message ?? "连接 Rabbit 失败" });
    }
  }, []);

  const reset = useCallback(() => setState({ status: "idle" }), []);

  // Auto-connect when in Rabbit App environment
  useEffect(() => {
    if (isInRabbitApp() && state.status === "idle") {
      // Small delay to let the bridge initialize
      const timer = setTimeout(() => connect(), 300);
      return () => clearTimeout(timer);
    }
  }, []);

  return { state, connect, reset, isInRabbitApp: isInRabbitApp() };
}
