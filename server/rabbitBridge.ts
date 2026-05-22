/**
 * Rabbit Bridge Authentication Module v2.0
 *
 * Replaces the static token approach with dynamic ECDSA signature verification.
 * Rabbit App signs each request with its embedded private key; CEX backend
 * verifies using the pre-configured public key (address).
 *
 * Request Headers:
 *   X-Rabbit-Timestamp: Unix timestamp in seconds (string)
 *   X-Rabbit-Nonce: Random unique string per request (UUID recommended)
 *   X-Rabbit-Signature: ECDSA secp256k1 signature (EIP-191 personal_sign hex)
 *
 * Signed Payload:
 *   keccak256(abi.encodePacked(timestamp, nonce, bodyHash))
 *   where bodyHash = keccak256(JSON.stringify(body)) for POST, or keccak256("") for GET
 *
 * Security:
 *   - Timestamp must be within MAX_SKEW_SECONDS of server time (prevents replay)
 *   - Nonce is stored and rejected if reused within TTL window (prevents replay)
 *   - Signature is verified against RABBIT_APP_ADDRESS (the public address
 *     corresponding to Rabbit App's embedded private key)
 */
import type { Request, Response, NextFunction } from "express";
import { verifyMessage, hashMessage, keccak256, toBytes, encodePacked } from "viem";

// ── Configuration ──────────────────────────────────────────────────────────

/**
 * The Ethereum address corresponding to Rabbit App's embedded signing key.
 * This is NOT a user wallet — it's the App-level identity key.
 * Set in .env as RABBIT_APP_ADDRESS=0x...
 */
const RABBIT_APP_ADDRESS = (process.env.RABBIT_APP_ADDRESS ?? "").toLowerCase() as `0x${string}`;

/**
 * Maximum allowed time skew between client and server (in seconds).
 * Requests older than this are rejected to prevent replay attacks.
 */
const MAX_SKEW_SECONDS = Number(process.env.RABBIT_MAX_SKEW_SECONDS ?? "60");

/**
 * Nonce TTL for deduplication (in milliseconds).
 * Nonces are stored for this duration to prevent reuse.
 */
const NONCE_TTL_MS = (MAX_SKEW_SECONDS + 30) * 1000;

// ── Nonce Deduplication Store ──────────────────────────────────────────────

const usedNonces = new Map<string, number>(); // nonce → timestamp

function pruneUsedNonces() {
  const now = Date.now();
  for (const [nonce, ts] of usedNonces) {
    if (now - ts > NONCE_TTL_MS) {
      usedNonces.delete(nonce);
    }
  }
}

// Prune every 60 seconds
setInterval(pruneUsedNonces, 60_000);

// ── Middleware ──────────────────────────────────────────────────────────────

/**
 * Express middleware that verifies Rabbit App dynamic signature.
 *
 * Usage:
 *   app.use("/api/web3", rabbitBridgeGuard);
 */
export function rabbitBridgeGuard(req: Request, res: Response, next: NextFunction) {
  // Fail-closed: if RABBIT_APP_ADDRESS is not configured, reject all
  if (!RABBIT_APP_ADDRESS || RABBIT_APP_ADDRESS.length < 42) {
    console.warn("[RabbitBridge] RABBIT_APP_ADDRESS not configured — rejecting request");
    return res.status(503).json({
      ok: false,
      error: "Bridge authentication not configured",
    });
  }

  const timestamp = req.header("x-rabbit-timestamp") ?? "";
  const nonce = req.header("x-rabbit-nonce") ?? "";
  const signature = req.header("x-rabbit-signature") ?? "";

  // Check all required headers are present
  if (!timestamp || !nonce || !signature) {
    return res.status(403).json({
      ok: false,
      error: "Access denied: missing bridge authentication headers",
    });
  }

  // Validate timestamp format and skew
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    return res.status(403).json({
      ok: false,
      error: "Access denied: invalid timestamp",
    });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) {
    return res.status(403).json({
      ok: false,
      error: "Access denied: timestamp expired or too far in the future",
    });
  }

  // Check nonce hasn't been used before
  if (usedNonces.has(nonce)) {
    return res.status(403).json({
      ok: false,
      error: "Access denied: nonce already used",
    });
  }

  // Build the message that Rabbit App should have signed
  // For GET requests, body is empty string; for POST, it's JSON.stringify(body)
  const bodyStr = req.method === "GET" || !req.body
    ? ""
    : JSON.stringify(req.body);

  const payload = `${timestamp}.${nonce}.${bodyStr}`;

  // Verify ECDSA signature (EIP-191 personal_sign)
  verifyMessage({
    address: RABBIT_APP_ADDRESS,
    message: payload,
    signature: signature as `0x${string}`,
  })
    .then((valid) => {
      if (!valid) {
        return res.status(403).json({
          ok: false,
          error: "Access denied: invalid signature",
        });
      }

      // Mark nonce as used
      usedNonces.set(nonce, Date.now());

      // Signature valid — proceed
      next();
    })
    .catch((err) => {
      console.error("[RabbitBridge] signature verification error:", err);
      return res.status(403).json({
        ok: false,
        error: "Access denied: signature verification failed",
      });
    });
}

/**
 * Utility to check if the Rabbit Bridge is properly configured.
 */
export function isRabbitBridgeConfigured(): boolean {
  return RABBIT_APP_ADDRESS.length === 42 && RABBIT_APP_ADDRESS.startsWith("0x");
}
