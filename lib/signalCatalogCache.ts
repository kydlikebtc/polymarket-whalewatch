import { createPromiseCache } from "./promiseCache";
import type { buildSignalCatalog } from "./signalCatalog";

// /api/signals/list 的名录缓存 —— 连同它的测试重置钩子。
//
// 之所以是**独立模块**而不是留在 route.ts 里:App Router 在构建期校验路由文件的
// 导出面,只认白名单字段(GET/POST/runtime/dynamic/revalidate…),多导出一个
// `__resetCatalogCache` 就是 `next build` 直接失败。而 `tsc --noEmit` 看不见这层
// 校验 —— 它跑在源码集合上,校验用的断言文件是 next build 生成到 .next/types 下
// 的,所以这类错误只有真跑构建才暴露。缓存与钩子搬进普通模块,路由只 import 使用。
//
// (同类先例:lib/marketWindow.ts 的 __resetWindows —— 测试专用重置钩子放 lib 是
// 本仓惯例。)

const CACHE_TTL_MS = 30_000;

export type SignalCatalogBody = {
  updatedAt: number;
  tier: string;
  signals: ReturnType<typeof buildSignalCatalog>;
};

// let 而非 const:测试要能把缓存清干净(越权隔离那条用例的全部意义就在于
// 「先烤热、再换 key」,带着上一条用例的残留跑等于没测)。
let catalogCache = createPromiseCache<SignalCatalogBody>(CACHE_TTL_MS);

/** 走名录缓存:同键在 TTL 内共用同一个在途 promise。 */
export function cachedCatalog(
  key: string,
  load: () => Promise<SignalCatalogBody>,
): Promise<SignalCatalogBody> {
  return catalogCache(key, load);
}

/** 仅供测试:丢弃当前缓存。 */
export function __resetCatalogCache(): void {
  catalogCache = createPromiseCache<SignalCatalogBody>(CACHE_TTL_MS);
}
