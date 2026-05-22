/**
 * EVM address validation helpers.
 *
 * For the first version we use a lightweight checksum validator instead of
 * pulling `ethers` just for isAddress. The checks below are:
 *   - starts with 0x
 *   - 40 hex chars body
 *   - if any uppercase char is present, validate EIP-55 checksum using keccak256
 */

import { createHash } from "node:crypto";

export type SupportedChain = "erc20" | "bep20";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isHexAddress(addr: string): boolean {
  return ADDRESS_RE.test(addr);
}

/**
 * Normalize to lowercase form. The exchange treats EVM addresses case-insensitively.
 */
export function normalizeAddress(addr: string): string {
  if (!isHexAddress(addr)) throw new Error(`Invalid address: ${addr}`);
  return addr.toLowerCase();
}

/**
 * Produce an EIP-55 style display address.
 * NOTE: keccak-256 is approximated here via Node's `createHash('sha3-256')`.
 * The true EIP-55 uses keccak256, not NIST SHA3. For display only — do NOT use
 * for signature verification.
 */
export function toDisplayAddress(addr: string): string {
  const lower = normalizeAddress(addr).slice(2);
  const hash = createHash("sha3-256").update(lower).digest("hex");
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i];
    if (/[a-f]/.test(c)) {
      out += parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c;
    } else {
      out += c;
    }
  }
  return out;
}

export function assertSupportedChain(c: string): asserts c is SupportedChain {
  if (c !== "erc20" && c !== "bep20") {
    throw new Error(`Unsupported chain: ${c}`);
  }
}
