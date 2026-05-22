import { ALL_ASSETS } from "./markets";

export const SUPPORTED_CHAINS = [
  "erc20",
  "trc20",
  "bep20",
  "polygon",
  "arbitrum",
  "optimism",
  "solana",
  "bitcoin",
] as const;

export type Chain = (typeof SUPPORTED_CHAINS)[number];

export type ChainMeta = {
  id: Chain;
  title: string;
  shortName: string;
  subtitle: string;
  confirmations: string;
  arrival: string;
  minDeposit: string;
  withdrawFeeUSDT: string;
  addressHint: string;
};

export const CHAIN_META: Record<Chain, ChainMeta> = {
  erc20: {
    id: "erc20",
    title: "Ethereum",
    shortName: "ERC20",
    subtitle: "以太坊主网 · 兼容主流钱包与交易所",
    confirmations: "12 个区块确认",
    arrival: "约 3–12 分钟",
    minDeposit: "1",
    withdrawFeeUSDT: "3",
    addressHint: "0x 开头的 EVM 地址",
  },
  trc20: {
    id: "trc20",
    title: "TRON",
    shortName: "TRC20",
    subtitle: "TRON 网络 · USDT 常用低成本通道",
    confirmations: "20 个区块确认",
    arrival: "约 1–3 分钟",
    minDeposit: "1",
    withdrawFeeUSDT: "1",
    addressHint: "T 开头的 TRON 地址",
  },
  bep20: {
    id: "bep20",
    title: "BNB Smart Chain",
    shortName: "BEP20",
    subtitle: "BNB Chain · 手续成本低，到账较快",
    confirmations: "15 个区块确认",
    arrival: "约 1–5 分钟",
    minDeposit: "1",
    withdrawFeeUSDT: "0.8",
    addressHint: "0x 开头的 EVM 地址",
  },
  polygon: {
    id: "polygon",
    title: "Polygon",
    shortName: "Polygon",
    subtitle: "Polygon PoS · 适合低成本稳定币转账",
    confirmations: "128 个区块确认",
    arrival: "约 3–10 分钟",
    minDeposit: "1",
    withdrawFeeUSDT: "0.8",
    addressHint: "0x 开头的 EVM 地址",
  },
  arbitrum: {
    id: "arbitrum",
    title: "Arbitrum One",
    shortName: "Arbitrum",
    subtitle: "以太坊 Layer 2 · 成本低且生态活跃",
    confirmations: "64 个区块确认",
    arrival: "约 2–8 分钟",
    minDeposit: "1",
    withdrawFeeUSDT: "0.6",
    addressHint: "0x 开头的 EVM 地址",
  },
  optimism: {
    id: "optimism",
    title: "Optimism",
    shortName: "Optimism",
    subtitle: "以太坊 Layer 2 · 适合 OP 生态资产",
    confirmations: "64 个区块确认",
    arrival: "约 2–8 分钟",
    minDeposit: "1",
    withdrawFeeUSDT: "0.6",
    addressHint: "0x 开头的 EVM 地址",
  },
  solana: {
    id: "solana",
    title: "Solana",
    shortName: "Solana",
    subtitle: "Solana 网络 · 适合 SOL 与 Solana 稳定币",
    confirmations: "32 个确认",
    arrival: "约 1–3 分钟",
    minDeposit: "1",
    withdrawFeeUSDT: "0.5",
    addressHint: "32–44 位 Base58 地址",
  },
  bitcoin: {
    id: "bitcoin",
    title: "Bitcoin",
    shortName: "BTC",
    subtitle: "比特币网络 · 仅用于 BTC 主网充值提现",
    confirmations: "3 个区块确认",
    arrival: "约 10–60 分钟",
    minDeposit: "0.0001",
    withdrawFeeUSDT: "0",
    addressHint: "bc1、1 或 3 开头的 BTC 地址",
  },
};

export const ON_CHAIN_ASSETS = ALL_ASSETS;
export type OnChainAsset = (typeof ON_CHAIN_ASSETS)[number];

const ASSET_CHAIN_ALLOWLIST: Record<string, Chain[]> = {
  BTC: ["bitcoin", "bep20"],
  ETH: ["erc20", "arbitrum", "optimism", "bep20", "polygon"],
  USDT: ["trc20", "erc20", "bep20", "polygon", "arbitrum", "optimism", "solana"],
  BNB: ["bep20"],
  SOL: ["solana", "bep20"],
  TRX: ["trc20"],
  MATIC: ["polygon", "erc20", "bep20"],
  ARB: ["arbitrum", "erc20"],
  OP: ["optimism", "erc20"],
};

export function getSupportedChainsForAsset(asset: string): Chain[] {
  const normalized = asset.trim().toUpperCase();
  return ASSET_CHAIN_ALLOWLIST[normalized] ?? ["erc20", "bep20"];
}

export function isSupportedChain(value: string): value is Chain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}
