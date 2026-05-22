# Walldex / Dex

This repository contains the Walldex exchange application source code.

## Stack

The project uses React, Vite, TypeScript, TailwindCSS, Express, tRPC, Drizzle ORM, MySQL, PM2, and Nginx in the test deployment environment.

## Development

```bash
pnpm install
cp .env.example .env
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

## Market mode boundary

The matching logic keeps the two market modes separated:

- `binance_mirror`: automated market making where the platform is the counterparty and internal orderbook matching is not used.
- `orderbook`: user orderbook matching where platform counterparty fills are not used.

Do not mix these two execution paths.

## 产品与技术说明

详细的产品定位、系统架构、数据模型、撮合逻辑、接口、安全、部署、测试与维护说明，请阅读：[`docs/WALLDEX_PRODUCT_TECHNICAL_GUIDE.md`](docs/WALLDEX_PRODUCT_TECHNICAL_GUIDE.md)。
