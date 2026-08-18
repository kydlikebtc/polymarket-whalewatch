import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config.ts";

// 产物在 dist/,用 chrome://extensions 的「加载已解压的扩展程序」装。
// 换服务器地址要重新打包:WW_BASE_URL=https://… npm run build
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // MV3 service worker 不吃 legacy chunk;保持现代目标,产物也小。
    target: "es2022",
  },
  // crxjs 的 HMR 需要固定端口
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
});
