"use client";

import { useEffect, useRef, useState } from "react";

// 从一批持仓行的 asset(CLOB token id)里去重:12 档跟单持仓大面积重叠
// (设计文档 §9.1——同一市场经常同时命中多个信号源,「激进」是「保守」的
// 超集之类),60 个持仓可能只对应 20 个不同 token,不去重会把请求量放大
// 2-3 倍。过滤掉空字符串/undefined/null(老仓位或异常数据兜底,不能让一个
// 缺失的 asset 污染整批请求),保留首次出现的顺序——顺序本身不影响请求量,
// 只是让调用方行为可预期、可测。
export function dedupeAssets(assets: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of assets) {
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/**
 * 合并一批 /api/current-price 响应到调用方的价格表——与 useWalletIntel 的
 * mergeStatsBatch 同一套区分:响应里显式给出 null(服务端已经问过 CLOB、
 * 明确取不到)算「已解析」,不再重试,调用方稳定显示「—」;响应里完全缺失
 * 这个 asset(fetch 失败、响应格式异常等)才是「需要重试」,不能把网络层
 * 失败误记成「这个 token 确实没有行情」这条持久性结论。
 */
export function mergeCurrentPrices(
  want: string[],
  json: { prices?: Record<string, number | null> },
): { prices: Record<string, number | null>; retry: string[] } {
  const prices: Record<string, number | null> = {};
  const retry: string[] = [];
  for (const a of want) {
    const p = json.prices?.[a];
    if (p === undefined) retry.push(a);
    else prices[a] = p; // number 或显式 null 都算已解析
  }
  return { prices, retry };
}

/**
 * 持仓中列表「当前价」的惰性加载:不随 /api/follow 同步返回——那是结算
 * 口径的战绩接口,当前价是市价快照,两者刷新节奏与失败域完全不同,揉进
 * 一个接口只会互相拖累(见 OpenTable 列头 title「仅供参考,不进战绩口径」)。
 * 与 useWalletIntel 同一套「稳定 key + 已请求集合」写法:key 只随「去重后
 * 的 asset 集合内容」变化,不随每次父组件重渲染(如 30s 自动刷新)重新生成
 * 的数组身份变化——否则每次刷新都会把已经拿到的价格重新请求一遍。
 *
 * 返回值三态(与 useWalletIntel 的 stats 同一约定,调用方据此分三档渲染):
 *   - 键不存在于 prices → 仍在加载中(「…」)
 *   - 值为 null → 已请求但取价失败/无数据(「—」)
 *   - 值为 number → 当前价(0–1 概率)
 */
export function useCurrentPrices(assets: (string | undefined | null)[]): {
  prices: Record<string, number | null>;
} {
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const requested = useRef<Set<string>>(new Set());

  const key = dedupeAssets(assets).sort().join(",");

  useEffect(() => {
    // 从 key(而不是外层闭包的 assets/dedupeAssets 结果)重新拆出 want——
    // 与 useWalletIntel 的写法同一个理由:key 已经完整表达了"这次 effect
    // 该处理哪些 asset",不需要再让 effect 依赖 assets 数组本身(它每次
    // 父组件渲染都是新引用,会破坏"只在去重集合真的变化时才请求"这条
    // 设计)。
    const want = (key ? key.split(",") : []).filter(
      (a) => !requested.current.has(a),
    );
    if (want.length === 0) return;
    for (const a of want) requested.current.add(a);
    // bug 修复(真机验证时实测复现):这里曾经有一个 `active` 标志,在
    // cleanup 里置 false、setPrices 前判断 if(active)——开发环境 React
    // Strict Mode 会为每个 effect 故意"挂载→清理→再挂载"一次来暴露副作用
    // 泄漏,而 requested ref 在这两次挂载之间是同一个(ref 不随 Strict
    // Mode 的模拟卸载重置)。于是第一次挂载发起请求并把 asset 标记进
    // requested,Strict Mode 立即清理(active→false),第二次挂载因为
    // requested 里已经有这些 asset 而直接跳过([want.length===0] 提前
    // return)——不会有第二次请求。等第一次挂载的 fetch 真正拿到结果时,
    // 它的 active 早已是 false,setPrices 被那个判断挡住:请求成功了、
    // 数据也对,但从来没有写进 state,单元格永远停在「…」。与
    // useWalletIntel 同一个教训:那边的 setStats/setSmart 就没有这层
    // "是否已卸载"判断,只用 disposed 标志防止在清理后开始新一轮请求——
    // 不阻止已经在飞的这一轮把结果写回去。这里直接复用同一个原则:不guard
    // setPrices,失败只影响 requested(释放后可重试),成功必须无条件落地。
    (async () => {
      try {
        const res = await fetch("/api/current-price", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assets: want }),
        });
        const json = (await res.json()) as {
          prices?: Record<string, number | null>;
        };
        const { prices: resolved, retry } = mergeCurrentPrices(want, json);
        // 失败的(响应里缺失的)释放出去,下次去重 key 变化时会再请求一遍。
        for (const a of retry) requested.current.delete(a);
        setPrices((prev) => ({ ...prev, ...resolved }));
      } catch {
        for (const a of want) requested.current.delete(a);
      }
    })();
  }, [key]);

  return { prices };
}
