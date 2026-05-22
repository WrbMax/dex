import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerWeb3AuthRoutes } from "../web3auth";
import { registerWalletSyncRoutes } from "../walletSync";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { registerExchangeRestApi } from "../exchange/api/rest";
import { registerExchangeWs } from "../exchange/api/ws";
import { ensureMarketsLoaded } from "../exchange/markets/registry";
import { getMatchingEngine } from "../exchange/matching/engine";
import { getMarketDataHub } from "../exchange/marketdata/hub";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  // Authentication routes (Rabbit Bridge + SIWE)
  registerWeb3AuthRoutes(app);
  registerWalletSyncRoutes(app);

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // External REST API (Binance-compatible shape)
  registerExchangeRestApi(app);

  // Initialize exchange subsystems (idempotent)
  await ensureMarketsLoaded();
  const engine = await getMatchingEngine();
  const hub = getMarketDataHub();
  hub.on("ticker", (snap: { symbol: string; lastPrice: string }) => {
    void engine.onTicker(snap.symbol, snap.lastPrice);
  });

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // External WebSocket push for market data
  registerExchangeWs(server);

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
