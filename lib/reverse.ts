import type { FollowCandidate } from "./followCandidate";
import type { MarketMeta } from "./gamma";

// 反向对照档的核心变换(设计:docs/plans/2026-08-13-reverse-control-design.md §3)。
// 正向 detector 产出的候选在开仓循环里经此翻到「对面 outcome」—— 检测判据、
// formationTs、归因字段全部与正向档共享,分叉只发生在"买哪一边"这一步,
// 两档战绩才构成同信号同时刻的干净对照(与 lopsided side="minor" 对
// 「一边倒分歧」的既有对照同一哲学,但对任意 source 通用:lopsided 能在
// detector 内翻边是因为分歧分析天然算出了两边,heavy/resolved/wallet 族的
// 候选只带自己一边的 token,对面 token 只能靠 MarketMeta.clobTokenIds 定位,
// 而 meta 在开仓循环之前才按候选取好 —— 所以翻转必须发生在这里,不在 detector)。

/**
 * 翻转结果:成功给出翻转后的候选,失败给出人话原因(调用方原样落日志)。
 * 不用裸 null:六种弃权前提各自对应不同的现实故障(meta 降级 / 3-way 市场 /
 * gamma 解析失败 / 元数据漂移…),调试时第一个问题就是"这轮反向档为什么没
 * 开仓",不带原因的 null 回答不了(日志记录原则:弃权必须能自答)。
 */
export type ReverseResult = { candidate: FollowCandidate } | { skip: string };

/**
 * 把候选翻到二元市场的对面 outcome。纯函数、不修改入参。
 *
 * 翻转规则:
 *  - outcome/outcomeIndex/asset → meta.outcomes / clobTokenIds 的另一个下标;
 *  - referencePrice → 1 − p:被反向信号的**镜像成本基准**(巨鲸 0.60 买 Yes,
 *    对面基准即 0.40 买 No)。落库后 smart_avg_price 存的就是它,追价成本
 *    (positionSlippage)与偏离护栏的回退基准语义随之成立;
 *  - formationTs **不变**:对照要成立,两档必须在同一时刻开仓 —— 翻转绝不
 *    引入「择时不同」变量(同 lib/sourceLopsided.ts「formationTs 恒取
 *    sides[0]」的论证);
 *  - sourceKind/walletCount/totalNetUsd 等归因字段不变(归因的是被反向的那个
 *    信号本身)。
 *
 * fail-closed 前提(任一不满足即弃权,宁可这档本轮空仓也不翻错边):
 *  - meta 在场;outcomes 与 clobTokenIds 恰为 2 元素(3-way 市场「对面」不良
 *    定义 —— lib/sourceResolved.ts 注释实证 3-way 真实存在);
 *  - clobTokenIds[c.outcomeIndex] === c.asset:gamma 元数据与成交流的 index
 *    对齐是结算已依赖的既有不变量(outcomePrices[outcome_index]),这里升格为
 *    翻边前的运行时校验 —— 对不上说明元数据漂移,继续翻可能买到完全无关的
 *    token,比不开仓危险得多;
 *  - 镜像 referencePrice 落在 (0,1) 开区间(极端价 1.0 的镜像是 0,份额除法
 *    与护栏都会被污染)。
 */
export function reverseCandidate(
  c: FollowCandidate,
  meta: MarketMeta | undefined,
): ReverseResult {
  if (!meta) {
    return { skip: "meta 缺失(getMeta 本轮降级?),下轮再试" };
  }
  if (meta.outcomes.length !== 2 || meta.clobTokenIds.length !== 2) {
    return {
      skip:
        `非二元市场或 clobTokenIds 坏形状(outcomes=${meta.outcomes.length}、` +
        `tokens=${meta.clobTokenIds.length}),「买对面」不良定义`,
    };
  }
  if (c.outcomeIndex !== 0 && c.outcomeIndex !== 1) {
    return { skip: `outcomeIndex=${c.outcomeIndex} 越界(需 0/1)` };
  }
  if (meta.clobTokenIds[c.outcomeIndex] !== c.asset) {
    return {
      skip:
        `clobTokenIds[${c.outcomeIndex}]=${meta.clobTokenIds[c.outcomeIndex]} ` +
        `与候选 asset=${c.asset} 对不上(元数据漂移?),拒绝翻边`,
    };
  }
  const flippedIndex = 1 - c.outcomeIndex;
  const asset = meta.clobTokenIds[flippedIndex];
  if (asset === c.asset) {
    return { skip: "两个 token id 相同(退化元数据),翻转后 asset 未变" };
  }
  const referencePrice = 1 - c.referencePrice;
  if (
    !Number.isFinite(referencePrice) ||
    referencePrice <= 0 ||
    referencePrice >= 1
  ) {
    return {
      skip: `镜像 referencePrice=${referencePrice} 越出 (0,1)(原值 ${c.referencePrice})`,
    };
  }
  return {
    candidate: {
      ...c,
      outcome: meta.outcomes[flippedIndex],
      outcomeIndex: flippedIndex,
      asset,
      referencePrice,
    },
  };
}
