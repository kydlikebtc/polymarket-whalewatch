// Net-position primitives shared by every directional detector (P0.6).
//
// The old measure everywhere was `buyUsd − sellUsd` — a CASHFLOW, not a
// position. Buy 20k shares at 75¢ ($15k) and sell all 20k at 25¢ ($5k): the
// USD "net buy" reads +$10k while the wallet holds NOTHING. Detection floors
// applied to that number admit flat (round-tripped) positions as conviction.
//
// The honest measure is share-based:
//   netShares   = buyShares − sellShares      (0 when round-tripped, always)
//   exposureUsd = netShares × avgBuyPrice     (cost basis of what was BOUGHT
//                                              and not sold BACK, in-window)
// exposureUsd is 0 whenever netShares ≤ 0, so any positive USD floor
// automatically rejects flat and net-short-in-window wallets. For a pure buyer
// (no sells) exposureUsd === buyUsd, so thresholds keep their historical
// meaning on the common path.
//
// ── 结算盲区(这里必须读完再用) ──────────────────────────────────────
// 上面两个式子的**唯一**输入是 BUY/SELL 成交流水。而 Polymarket 的赎回是
// 另一种活动类型(data-api /activity 的 `REDEEM`),**永远不会**出现在
// /trades 里。所以市场一旦结算、钱包一赎回:
//   · netShares 永久冻结在结算前的水位;
//   · exposureUsd 继续报出一笔谁都不再持有的"仓位"。
// 输的那一边更糟 —— 份额归零没人去赎,于是**永远**没有 REDEEM 事件,敞口
// 就永久挂在成本价上。("没有 REDEEM" ≠ "仓位还在"。)
//
// 实测(2026-08-21,7131 条生产告警 × gamma closedTime):73.6% 的市场在 6h
// 检测窗口内结算,结算后中位 1.8 分钟就赎完。所以这不是边角情况,是常态。
//
// 因此本文件的三个函数只回答一个问题:**窗口内净投入了多少**(净买入)。
// 它们回答不了「现在还持有多少」(敞口/留仓)。两种口径的分界线是结算:
//   · 「净买入」——  结算后依然为真,照常使用;
//   · 「敞口/留仓」—— 结算后为假,调用方必须先过 lib/gamma 的 `isSettled`。
// 现有守卫(别再各写一份):
//   · lib/consensus    runConsensusCycle 的「已结算闸门」整组不推;
//   · lib/marketBrief  展示侧把每个 exposureUsd 归零、文案改说「净股数 /
//     窗口净买入」—— 随 position-data-inconsistency 分支合入,本分支尚无;
//   · lib/follow       开仓前 `meta.closed === true` 跳过(比 isSettled 更严,
//     争议中的 closed 市场也不开 —— 那里问的是"能不能动手",不是"是否终局")。
// 不需要守卫的(结论已复核,别顺手加):
//   · lib/discovery    证据行是**回溯行为**记录(文案本就写「净买」),且成交
//     不可能发生在结算之后 —— 加闸门只会删掉真实证据、饿死准入漏斗;
//   · lib/disagreement 输出只被用来"抑制"(共识互斥),结算不会凭空造出对立边;
//   · lib/sourceWallet 只喂 follow,已由上面那道开仓闸门兜住。

export interface PositionAcc {
  buyUsd: number;
  sellUsd: number;
  buyShares: number;
  sellShares: number;
}

export function netShares(acc: PositionAcc): number {
  return acc.buyShares - acc.sellShares;
}

export function avgBuyPrice(acc: PositionAcc): number {
  return acc.buyShares > 0 ? acc.buyUsd / acc.buyShares : 0;
}

/**
 * Cost basis of the position retained **within the trade window**; 0 when
 * nothing (or negative) is held.
 *
 * ⚠️ 结算之后这个数字不再是"还持有" —— 见文件头的「结算盲区」段。想表达
 * 「现在还在场上」的调用方必须自己先过 lib/gamma 的 `isSettled` 闸门；只想
 * 表达「窗口内投进去多少」(净买入)的调用方不受影响。
 */
export function exposureUsd(acc: PositionAcc): number {
  const shares = netShares(acc);
  if (shares <= 0) return 0;
  return shares * avgBuyPrice(acc);
}
