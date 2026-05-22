/**
 * Asset logo URL resolver. Uses Coinbase official CDN (fast, CORS-open, high
 * resolution) as primary; falls back to the Cryptologos.cc CDN, and finally
 * to a text circle rendered by the AssetIcon React component.
 *
 * All 30 base assets + USDT are covered. No opaque third-party dependency
 * bundled in the repo — only remote URLs.
 */

type LogoEntry = { primary: string; fallback?: string };

const CB = (symbol: string) =>
  `https://assets.coincap.io/assets/icons/${symbol.toLowerCase()}@2x.png`;
const TW = (slug: string) =>
  `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${slug}/info/logo.png`;

// Some assets live on non-"coin"-type blockchain entries in TrustWallet.
// Use token-address-based paths for ERC20 tokens.
const TW_ERC20 = (addr: string) =>
  `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${addr}/logo.png`;
const TW_BSC20 = (addr: string) =>
  `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/${addr}/logo.png`;

const LOGOS: Record<string, LogoEntry> = {
  USDT: { primary: CB("usdt"), fallback: TW_ERC20("0xdAC17F958D2ee523a2206206994597C13D831ec7") },
  BTC: { primary: CB("bitcoin"), fallback: TW("bitcoin") },
  ETH: { primary: CB("ethereum"), fallback: TW("ethereum") },
  SOL: { primary: CB("solana"), fallback: TW("solana") },
  BNB: { primary: CB("binance-coin"), fallback: TW("binance") },
  XRP: { primary: CB("xrp"), fallback: TW("ripple") },
  DOGE: { primary: CB("dogecoin"), fallback: TW("doge") },
  ADA: { primary: CB("cardano"), fallback: TW("cardano") },
  AVAX: { primary: CB("avalanche"), fallback: TW("avalanchec") },
  LINK: { primary: CB("chainlink"), fallback: TW_ERC20("0x514910771AF9Ca656af840dff83E8264EcF986CA") },
  DOT: { primary: CB("polkadot"), fallback: TW("polkadot") },
  MATIC: { primary: CB("polygon"), fallback: TW("polygon") },
  TRX: { primary: CB("tron"), fallback: TW("tron") },
  TON: { primary: CB("the-open-network"), fallback: TW("ton") },
  SHIB: { primary: CB("shiba-inu"), fallback: TW_ERC20("0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE") },
  LTC: { primary: CB("litecoin"), fallback: TW("litecoin") },
  UNI: { primary: CB("uniswap"), fallback: TW_ERC20("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984") },
  ATOM: { primary: CB("cosmos"), fallback: TW("cosmos") },
  BCH: { primary: CB("bitcoin-cash"), fallback: TW("bitcoincash") },
  NEAR: { primary: CB("near-protocol"), fallback: TW("near") },
  APT: { primary: CB("aptos"), fallback: TW("aptos") },
  ARB: { primary: CB("arbitrum"), fallback: TW("arbitrum") },
  OP: { primary: CB("optimism"), fallback: TW("optimism") },
  PEPE: { primary: CB("pepe"), fallback: TW_ERC20("0x6982508145454Ce325dDbE47a25d4ec3d2311933") },
  SUI: { primary: CB("sui"), fallback: TW("sui") },
  FIL: { primary: CB("filecoin"), fallback: TW("filecoin") },
  IMX: { primary: CB("immutable-x"), fallback: TW_ERC20("0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF") },
  RNDR: { primary: CB("render-token"), fallback: TW_ERC20("0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24") },
  TIA: { primary: CB("celestia"), fallback: TW("celestia") },
  HBAR: { primary: CB("hedera-hashgraph"), fallback: TW("hedera") },
  INJ: { primary: CB("injective-protocol"), fallback: TW("injective") },
};

export function getAssetLogo(asset: string): LogoEntry | undefined {
  return LOGOS[asset.toUpperCase()];
}
