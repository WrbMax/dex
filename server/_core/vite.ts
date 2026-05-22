import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    // HMR disabled: the reverse proxy environment cannot maintain a stable WebSocket
    // connection, causing constant reconnect loops that make the page flicker/reload.
    hmr: false as const,
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      let page = await vite.transformIndexHtml(url, template);
      // Remove @vite/client script injection - HMR is disabled and the WS
      // connection attempts in a reverse-proxy env cause page flicker/reload loops.
      page = page.replace(/<script type="module" src="\/@vite\/client"><\/script>\s*/g, "");
      res.status(200).set({ "Content-Type": "text/html", "Cache-Control": "no-store" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));

  // Missing built assets must not fall through to index.html. If a browser still
  // holds an old HTML document that references removed hashed assets, returning
  // a real 404 forces the stale asset request to fail instead of silently serving
  // the SPA shell as CSS/JS.
  app.use("*", (req, res, next) => {
    const requestPath = new URL(req.originalUrl || req.url || "/", "http://localhost").pathname;
    if (requestPath.startsWith("/assets/") || path.extname(requestPath)) {
      res.status(404).set({ "Cache-Control": "no-store" }).send("Not found");
      return;
    }
    next();
  });

  // fall through to index.html for client-side routes only
  app.use("*", (_req, res) => {
    res.set({ "Cache-Control": "no-store" });
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
