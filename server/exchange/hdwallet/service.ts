/**
 * Exchange HD wallet placeholder service.
 *
 * This module centralizes deposit-address allocation for the exchange-side HD
 * wallet. The current implementation intentionally does not keep private keys
 * in the online service. When HD_WALLET_XPUB is configured, a future watcher or
 * derivation library can replace `deriveManagedDepositAddress()` with true xpub
 * derivation while keeping the database contract unchanged: each address stores
 * the BIP-44-style derivation path in `deposit_addresses.derivationPath`.
 */
import { createHash } from "node:crypto";
import { Chain, SUPPORTED_CHAINS } from "@shared/wallet";
import { ENV } from "../../_core/env";

const CHAIN_BRANCH: Record<Chain, number> = Object.fromEntries(
  SUPPORTED_CHAINS.map((chain, index) => [chain, index])
) as Record<Chain, number>;

const CHAIN_COIN_TYPE: Record<Chain, number> = {
  erc20: 60,
  trc20: 195,
  bep20: 60,
  polygon: 60,
  arbitrum: 60,
  optimism: 60,
  solana: 501,
  bitcoin: 0,
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function rootFingerprint(): string {
  const root = ENV.exchange.hdWallet.xpub || ENV.exchange.hdWallet.mnemonic || "walldex-dev-hd-wallet-placeholder";
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

function hashHex(seed: string): string {
  return createHash("sha3-256").update(seed).digest("hex");
}

function pseudoBase58(hex: string, length: number): string {
  const bytes = Buffer.from(hex, "hex");
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += BASE58_ALPHABET[bytes[i % bytes.length] % BASE58_ALPHABET.length];
  }
  return out;
}

export function getDepositDerivationPath(userId: number, chain: Chain): string {
  const accountIndex = Math.max(0, Math.trunc(ENV.exchange.hdWallet.accountIndex));
  const branch = CHAIN_BRANCH[chain];
  const coinType = CHAIN_COIN_TYPE[chain];
  return `m/44'/${coinType}'/${accountIndex}'/${branch}/${userId}`;
}

export function deriveManagedDepositAddress(userId: number, chain: Chain): string {
  const path = getDepositDerivationPath(userId, chain);
  const hash = hashHex(`walldex-hd:${rootFingerprint()}:${chain}:${path}`);

  if (["erc20", "bep20", "polygon", "arbitrum", "optimism"].includes(chain)) {
    return `0x${hash.slice(0, 40)}`;
  }

  if (chain === "trc20") {
    return `T${pseudoBase58(hash, 33)}`;
  }

  if (chain === "solana") {
    return pseudoBase58(hash + hashHex(`${hash}:solana`), 44);
  }

  return `bc1q${pseudoBase58(hash + hashHex(`${hash}:btc`), 38).toLowerCase()}`;
}

export function getHDWalletStatus() {
  return {
    mode: ENV.exchange.hdWallet.xpub ? "xpub_configured" : ENV.exchange.hdWallet.mnemonic ? "mnemonic_configured" : "placeholder",
    accountIndex: Math.max(0, Math.trunc(ENV.exchange.hdWallet.accountIndex)),
    rootFingerprint: rootFingerprint(),
  } as const;
}
