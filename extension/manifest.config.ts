import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

// 服务器地址在**构建期**注入(做法同 aisee 的 FRONTEND_URL):它同时决定
// host_permissions 与配置桥 content script 的 matches。
//
// matches 绝不能写 <all_urls> —— 那意味着任何网站都能给插件推配置(改服务器
// 地址、换 API key),是扩展里最经典的一类漏洞。宁可换服务器时重新打包。
const WW_BASE_URL = process.env.WW_BASE_URL ?? "http://localhost:3000";
const origin = new URL(WW_BASE_URL).origin;

export default defineManifest({
  manifest_version: 3,
  name: "WhaleWatch 𝕏 Publisher",
  version: pkg.version,
  description:
    "把 whalewatch 的信号帖通过本机已登录的 X 会话发出去（不经 X API）",
  // 权限对照 aisee 砍到最小集。刻意**不要** cookies(我们不读会话)、
  // debugger(不需要原生击键,且它是权限清单里最扎眼的一个)、
  // activeTab(不看当前页)。
  permissions: ["storage", "alarms", "tabs", "scripting", "notifications"],
  host_permissions: ["https://x.com/*", "https://twitter.com/*", `${origin}/*`],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "WhaleWatch 𝕏 Publisher",
  },
  content_scripts: [
    {
      // 只在自己的域名上跑。
      matches: [`${origin}/*`],
      js: ["src/content/bridge.ts"],
      run_at: "document_idle",
    },
  ],
});
