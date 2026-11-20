import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

// 开发期把 API/SSE 代理到本地云服务；生产同源部署，无需代理。
const backend = process.env.PCP_BACKEND ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [vue()],
  define: {
    // PWA 快照版本守卫：每次构建变化的常量，页面用它判断安装副本是否过期
    __PCP_WEB_VERSION: JSON.stringify(String(Date.now())),
  },
  resolve: {
    alias: {
      // 线格式唯一真相源，位于仓库根 protocol/ts
      "@wire": fileURLToPath(new URL("../protocol/ts/wire.ts", import.meta.url)),
    },
  },
  server: {
    port: 5180,
    fs: { allow: [".."] },
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/pair": { target: backend, changeOrigin: true },
      // SSE 必须关闭缓冲，vite 代理默认是流式的，这里显式声明即可
      "/sse": { target: backend, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
