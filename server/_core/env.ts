/**
 * Environment configuration for WallDex Exchange.
 * All values are read from process.env at import time.
 */
function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function list(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw === null) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const isProduction = process.env.NODE_ENV === "production";
const MIN_PRODUCTION_SECRET_LENGTH = 32;

function assertProductionSecret(key: string, value: string | undefined) {
  if (!isProduction) return;
  if (!value || value.length < MIN_PRODUCTION_SECRET_LENGTH) {
    throw new Error(
      `${key} must be set to a high-entropy value of at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`
    );
  }
}

assertProductionSecret("JWT_SECRET", process.env.JWT_SECRET);

export const ENV = {
  /** Application identifier (used in JWT payload) */
  appId: process.env.APP_ID ?? "walldex",
  /** Secret for signing JWT session tokens */
  cookieSecret: process.env.JWT_SECRET ?? "",
  /** Database connection URL */
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** Owner wallet address — this address gets admin role on first login */
  ownerAddress: process.env.OWNER_ADDRESS ?? "",
  isProduction,
  /** Rabbit App Bridge: Public address of the App-level signing key */
  rabbitAppAddress: process.env.RABBIT_APP_ADDRESS ?? "",
  /** Rabbit App Bridge: Maximum timestamp skew in seconds (default: 60) */
  rabbitMaxSkewSeconds: num("RABBIT_MAX_SKEW_SECONDS", 60),
  /** SIWE (EIP-4361) Configuration */
  siwe: {
    domain: process.env.SIWE_DOMAIN ?? "walldex.io",
    uri: process.env.SIWE_URI ?? "https://walldex.io",
    statement: process.env.SIWE_STATEMENT ?? "Sign in to WallDex Exchange with your Rabbit Wallet",
    chainId: num("SIWE_CHAIN_ID", 1),
    expirationMinutes: num("SIWE_EXPIRATION_MINUTES", 10),
  },
  exchange: {
    marketDataSources: list("MARKET_DATA_SOURCES", [
      "binance",
      "okx",
      "hyperliquid",
    ]),
    marketDataProxy: process.env.MARKET_DATA_PROXY_URL ?? "",
    hedge: {
      binanceKey: process.env.HEDGE_BINANCE_KEY ?? "",
      binanceSecret: process.env.HEDGE_BINANCE_SECRET ?? "",
      okxKey: process.env.HEDGE_OKX_KEY ?? "",
      okxSecret: process.env.HEDGE_OKX_SECRET ?? "",
      okxPassphrase: process.env.HEDGE_OKX_PASSPHRASE ?? "",
      maxLegNotionalUsdt: num("HEDGE_MAX_LEG_NOTIONAL_USDT", 50_000),
    },
    walletSync: {
      secret: process.env.WALLET_SYNC_SECRET ?? "",
      maxSkewSeconds: num("WALLET_SYNC_MAX_SKEW_SECONDS", 300),
    },
    hdWallet: {
      mnemonic: process.env.HD_WALLET_MNEMONIC ?? "",
      xpub: process.env.HD_WALLET_XPUB ?? "",
      accountIndex: num("HD_WALLET_ACCOUNT_INDEX", 0),
    },
    apiRateLimit: {
      perMinute: num("API_RATE_LIMIT_PER_MIN", 600),
      burst: num("API_RATE_LIMIT_BURST", 120),
    },
  },
};
