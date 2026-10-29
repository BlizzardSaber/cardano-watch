import { defineConfig, type Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

// Dev/preview proxy hardening: only the read-only Koios endpoints this
// watch app uses may pass through, POST-only, fixed pagination queries.
// The dev server intentionally binds the LAN so an iPhone can load the page;
// the endpoint allowlist keeps that exposure read-only.
const ALLOWED: Array<{ path: string; order?: string }> = [
  { path: "/address_outputs", order: "tx_hash.asc,tx_index.asc" },
  { path: "/address_utxos", order: "tx_hash.asc,tx_index.asc" },
  { path: "/address_txs", order: "block_height.desc,tx_hash.desc" },
  { path: "/address_info", order: "select=address" },
  { path: "/tx_info" },
  { path: "/account_info" },
  { path: "/pool_info" },
  { path: "/asset_info", order: "select=policy_id,asset_name,token_registry_metadata->>decimals,token_registry_metadata->>ticker,token_registry_metadata->>name,token_registry_metadata->>logo" },
];
const ALLOWED_ORIGINS = (host: string) => [`http://${host}`, `https://${host}`];

function koiosGuard(): Plugin {
  const install = (middlewares: { use(handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void }) => {
    middlewares.use((req, res, next) => {
      const url = req.url ?? "";
      const prefix = ["/koios-mainnet", "/koios-preprod"].find((item) => url.startsWith(item));
      if (!prefix) return next();
      const parsed = new URL(url, "http://localhost");
      const route = parsed.pathname.slice(prefix.length).replace(/^\/api\/v1/, "");
      const rule = ALLOWED.find((item) => item.path === route);
      const host = req.headers.host ?? "";
      const sameOrigin = !req.headers.origin || ALLOWED_ORIGINS(host).includes(String(req.headers.origin));
      const queryOk = rule?.path === "/asset_info" || rule?.path === "/address_info" ? decodeURIComponent(parsed.search) === `?${rule.order}` :
        rule?.order ? parsed.search === `?order=${rule.order}` : !parsed.search;
      const pagingOk = rule?.order && rule.path !== "/asset_info" && rule.path !== "/address_info"
        ? typeof req.headers.range === "string" && /^\d{1,7}-\d{1,7}$/.test(req.headers.range) &&
          (req.headers.prefer === "count=exact" || (rule.path === "/address_txs" && req.headers.prefer === "count=planned"))
        : !req.headers.range && !req.headers.prefer;
      if (!rule || req.method !== "POST" || !sameOrigin || !queryOk || !pagingOk) {
        res.statusCode = 405;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Blocked by Koios dev-proxy allowlist");
        return;
      }
      next();
    });
  };
  return {
    name: "koios-dev-guard",
    configureServer(server) { install(server.middlewares); },
    configurePreviewServer(server) { install(server.middlewares); },
  };
}

export default defineConfig({
  base: "./",
  // The CSL wasm build breaks under Vite dependency pre-bundling; keep it as-is.
  optimizeDeps: { exclude: ["@emurgo/cardano-serialization-lib-browser"] },
  build: { target: "safari16", outDir: "dist" },
  plugins: [koiosGuard()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/koios-mainnet": { target: "https://api.koios.rest", changeOrigin: true,
        rewrite: (path) => path.replace(/^\/koios-mainnet/, "") },
      "/koios-preprod": { target: "https://preprod.koios.rest", changeOrigin: true,
        rewrite: (path) => path.replace(/^\/koios-preprod/, "") },
    },
  },
  preview: {
    proxy: {
      "/koios-mainnet": { target: "https://api.koios.rest", changeOrigin: true,
        rewrite: (path) => path.replace(/^\/koios-mainnet/, "") },
      "/koios-preprod": { target: "https://preprod.koios.rest", changeOrigin: true,
        rewrite: (path) => path.replace(/^\/koios-preprod/, "") },
    },
  },
});
