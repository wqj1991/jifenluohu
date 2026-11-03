import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { HttpsProxyAgent } from "https-proxy-agent";

/**
 * 数据只有服务器那一份：开发默认把 /api 直接打到线上实例。
 * 想在本地起 API 时用 `pnpm dev:local`（读 .env.local 里的 LUOHU_API）。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.LUOHU_API || "https://luohu.allen1991.cc.cd";
  const target = new URL(apiTarget);
  const apiOrigin = target.origin;

  // 公司网络里直连不到外网，Node 的 http-proxy 又不认 HTTP(S)_PROXY 环境变量，得自己挂 agent。
  const envProxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || "";
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.hostname);
  const agent = envProxy && !loopback ? new HttpsProxyAgent(envProxy) : undefined;

  /**
   * 后端的 /api/* 有同源校验（防 CSRF）：Origin 的 host 必须等于转发后的 Host。
   * 浏览器给的是 http://localhost:5273，代理又把 Host 改成了线上域名，POST 就全 403。
   * 在进代理之前把 Origin 改成后端自己的 origin，这一步只在 dev server 里发生。
   */
  const rewriteOrigin = {
    name: "luohu-api-origin",
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && req.url.startsWith("/api")) req.headers.origin = apiOrigin;
        next();
      });
    },
  };

  return {
    plugins: [react(), tailwindcss(), rewriteOrigin],
    server: {
      port: 5273,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true, secure: true, agent },
      },
    },
  };
});
