import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // 客户端路由缓存:全站页面都是 force-dynamic,Next 默认几乎不缓存它们的
    // RSC payload,于是每次点击导航都要一次服务端往返(线上还叠加网络延迟)。
    // 这里的 payload 只是页面骨架 —— 各页真实数据一律由客户端自己 fetch,
    // 所以缓存 60s 不会让任何数字变旧,只是省掉重复的 shell 往返。
    staleTimes: {
      dynamic: 60,
      static: 180,
    },
  },
  // Keep the native better-sqlite3 module out of the server bundle so the
  // read-only dashboard can require it at runtime (Next 15+ stable key).
  serverExternalPackages: ["better-sqlite3"],
  // Pin the workspace root: a stray lockfile in the parent dir otherwise makes
  // Next infer the wrong root (it warns about multiple lockfiles).
  turbopack: {
    root: projectRoot,
  },
  // Webpack fallback (`next dev --webpack`, used when running from a git
  // worktree without local node_modules). serverExternalPackages externalizes
  // better-sqlite3 for route handlers under Turbopack, but does NOT cover the
  // instrumentation bundle under Webpack — so the native module gets bundled
  // and its `bindings → require('fs')` fails to resolve. Externalize it
  // explicitly for server builds. No effect on the default Turbopack runtime.
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Node builtins (fs/path/crypto — used by lib/dbBackup and lib/apiGuard)
      // hit the same instrumentation-bundle gap as better-sqlite3: webpack
      // refuses both the "node:" scheme (UnhandledSchemeError) and the bare
      // names (module-not-found) there. Externalizing maps them back to
      // runtime require(), which is exactly right for a server bundle.
      config.externals = [
        ...config.externals,
        "better-sqlite3",
        "fs",
        "path",
        "crypto",
      ];
    }
    return config;
  },
};

export default nextConfig;
