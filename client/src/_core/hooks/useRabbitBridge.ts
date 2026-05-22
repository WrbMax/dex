/**
 * useRabbitBridge — Rabbit App Bridge authentication hook (v2.0)
 *
 * Architecture:
 *   - H5 (this code) runs inside Rabbit App's WebView
 *   - Rabbit App holds the App-level signing private key
 *   - H5 requests Rabbit App to generate signed headers for CEX API calls
 *   - H5 also requests Rabbit App to sign SIWE messages for user login
 *
 * Login Flow:
 *   1. H5 asks Rabbit App for user's wallet address
 *   2. H5 asks Rabbit App to generate signed headers (timestamp + nonce + bodyHash)
 *   3. H5 calls CEX /api/web3/nonce with signed headers → gets SIWE message
 *   4. H5 asks Rabbit App to personal_sign the SIWE message (user confirms)
 *   5. H5 asks Rabbit App to generate signed headers for verify request
 *   6. H5 calls CEX /api/web3/verify with signed headers + SIWE signature
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

// ── Bridge Communication ───────────────────────────────────────────────────

/**
 * Send a message to Rabbit App via the appropriate bridge channel.
 * Returns a promise that resolves with the App's response payload.
 */
export function sendToRabbit<T = any>(action: string, payload: Record<string, any> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const messageId = `${action}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error(`Rabbit Bridge timeout: ${action}`));
    }, 60000); // 60s timeout for user interaction (signing)

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

    const message = {
      source: "walldex-h5",
      messageId,
      action,
      payload,
    };

    // Try multiple bridge channels
    if ((window as any).ReactNativeWebView) {
      // React Native WebView bridge
      (window as any).ReactNativeWebView.postMessage(JSON.stringify(message));
    } else if ((window as any).webkit?.messageHandlers?.rabbitBridge) {
      // iOS WKWebView bridge
      (window as any).webkit.messageHandlers.rabbitBridge.postMessage(message);
    } else if ((window as any).RabbitBridge) {
      // Android JSInterface bridge
      (window as any).RabbitBridge.postMessage(JSON.stringify(message));
    } else if (window.parent && window.parent !== window) {
      // iframe postMessage fallback
      window.parent.postMessage(message, "*");
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
    (window as any).ReactNativeWebView ||
    (window as any).webkit?.messageHandlers?.rabbitBridge ||
    (window as any).RabbitBridge ||
    (window.parent && window.parent !== window)
  );
}

// ── Types for Bridge Responses ─────────────────────────────────────────────

interface SignedHeaders {
  "x-rabbit-timestamp": string;
  "x-rabbit-nonce": string;
  "x-rabbit-signature": string;
}

// ── Main Hook ──────────────────────────────────────────────────────────────

export function useRabbitBridge() {
  const [state, setState] = useState<RabbitBridgeState>({ status: "idle" });

  const connect = useCallback(async () => {
    setState({ status: "requesting_address" });

    try {
      // Step 1: Get user's wallet address from Rabbit App
      const { address } = await sendToRabbit<{ address: string }>("getWalletAddress");

      if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        setState({ status: "error", message: "从 Rabbit 获取的钱包地址无效" });
        return;
      }

      const normalized = address.toLowerCase();

      // Step 2: Request Rabbit App to generate signed headers for nonce request
      setState({ status: "fetching_nonce" });

      const nonceUrl = `/api/web3/nonce?address=${encodeURIComponent(normalized)}`;
      const nonceHeaders = await sendToRabbit<SignedHeaders>("signRequest", {
        method: "GET",
        path: nonceUrl,
        body: "",
      });

      // Step 3: Call CEX backend /api/web3/nonce with signed headers
      const nonceRes = await fetch(nonceUrl, {
        headers: {
          ...nonceHeaders,
        },
      });

      if (!nonceRes.ok) {
        const err = await nonceRes.json().catch(() => ({}));
        setState({ status: "error", message: `获取登录信息失败: ${err.error ?? nonceRes.statusText}` });
        return;
      }

      const { message: siweMessage } = await nonceRes.json();

      // Step 4: Request Rabbit App to sign the SIWE message (user sees structured login info)
      setState({ status: "requesting_signature" });

      const { signature } = await sendToRabbit<{ signature: string }>("personalSign", {
        message: siweMessage,
        address: normalized,
      });

      if (!signature) {
        setState({ status: "error", message: "用户取消了签名" });
        return;
      }

      // Step 5: Request Rabbit App to generate signed headers for verify request
      setState({ status: "verifying" });

      const verifyBody = JSON.stringify({ message: siweMessage, signature });
      const verifyHeaders = await sendToRabbit<SignedHeaders>("signRequest", {
        method: "POST",
        path: "/api/web3/verify",
        body: verifyBody,
      });

      // Step 6: Call CEX backend /api/web3/verify with signed headers + SIWE signature
      const verifyRes = await fetch("/api/web3/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...verifyHeaders,
        },
        body: verifyBody,
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        setState({ status: "error", message: `登录验证失败: ${err.error ?? verifyRes.statusText}` });
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
      const timer = setTimeout(() => connect(), 300);
      return () => clearTimeout(timer);
    }
  }, []);

  return { state, connect, reset, isInRabbitApp: isInRabbitApp() };
}
