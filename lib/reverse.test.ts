import { describe, it, expect } from "vitest";
import type { FollowCandidate } from "./followCandidate";
import type { MarketMeta } from "./gamma";
import { reverseCandidate } from "./reverse";

// 正向候选桩:巨鲸在 Yes(index 0,token tok-yes)@0.60 的信号。
const cand = (over: Partial<FollowCandidate> = {}): FollowCandidate => ({
  conditionId: "0xc1",
  outcome: "Yes",
  outcomeIndex: 0,
  asset: "tok-yes",
  title: "T",
  slug: "s",
  eventSlug: "e",
  formationTs: 1000,
  referencePrice: 0.6,
  sourceKind: "heavy",
  walletCount: 1,
  totalNetUsd: 60000,
  ...over,
});

const meta = (over: Partial<MarketMeta> = {}): MarketMeta => ({
  conditionId: "0xc1",
  volume24hr: null,
  liquidity: null,
  endDate: null,
  closed: false,
  category: null,
  outcomes: ["Yes", "No"],
  outcomePrices: [0.6, 0.4],
  clobTokenIds: ["tok-yes", "tok-no"],
  feesEnabled: false,
  feeType: null,
  feeSchedule: null,
  umaDisputed: null,
  ...over,
});

describe("reverseCandidate — 二元市场翻到对面", () => {
  it("index 0 → 1:outcome/outcomeIndex/asset 换对面,referencePrice 镜像为 1−p", () => {
    const r = reverseCandidate(cand(), meta());
    if ("skip" in r) throw new Error(`unexpected skip: ${r.skip}`);
    expect(r.candidate.outcome).toBe("No");
    expect(r.candidate.outcomeIndex).toBe(1);
    expect(r.candidate.asset).toBe("tok-no");
    expect(r.candidate.referencePrice).toBeCloseTo(0.4);
  });

  it("index 1 → 0 同样成立(翻转是对合的:翻两次回到自身)", () => {
    const first = reverseCandidate(cand(), meta());
    if ("skip" in first) throw new Error(first.skip);
    const back = reverseCandidate(first.candidate, meta());
    if ("skip" in back) throw new Error(back.skip);
    // referencePrice 用 closeTo:1−(1−p) 的浮点往返不保证逐位相等,
    // 其余字段必须逐位还原。
    expect(back.candidate).toEqual({
      ...cand(),
      referencePrice: expect.closeTo(0.6, 10),
    });
  });

  it("formationTs 与归因字段(sourceKind/walletCount/totalNetUsd/title)原样保留", () => {
    // 对照成立的前提:两档在同一时刻、以同一笔信号开仓 —— 翻转绝不能引入
    // 「择时不同」变量(与 lopsided「formationTs 恒取 sides[0]」同一论证)。
    const r = reverseCandidate(cand(), meta());
    if ("skip" in r) throw new Error(r.skip);
    expect(r.candidate.formationTs).toBe(1000);
    expect(r.candidate.sourceKind).toBe("heavy");
    expect(r.candidate.walletCount).toBe(1);
    expect(r.candidate.totalNetUsd).toBe(60000);
    expect(r.candidate.title).toBe("T");
    expect(r.candidate.conditionId).toBe("0xc1");
  });

  it("不修改入参候选(纯函数纪律)", () => {
    const c = cand();
    reverseCandidate(c, meta());
    expect(c).toEqual(cand());
  });
});

describe("reverseCandidate — fail-closed 弃权(每条原因独立可断言)", () => {
  const skipOf = (c: FollowCandidate, m: MarketMeta | undefined): string => {
    const r = reverseCandidate(c, m);
    if (!("skip" in r)) throw new Error("expected skip, got candidate");
    return r.skip;
  };

  it("meta 缺失 → 弃权(本轮 getMeta 降级时反向档不开仓,下轮再试)", () => {
    expect(skipOf(cand(), undefined)).toContain("meta");
  });

  it("3-way 市场(outcomes 3 元素)→ 弃权:「买对面」在多元市场不良定义", () => {
    // sourceResolved 注释实证 3-way 市场真实存在 —— 三个 outcome 里「对面」
    // 是哪两个的组合没有唯一答案,宁可这档不开也不猜。
    const m = meta({
      outcomes: ["A", "B", "C"],
      clobTokenIds: ["t1", "t2", "t3"],
    });
    expect(skipOf(cand({ asset: "t1", outcome: "A" }), m)).toContain("二元");
  });

  it("clobTokenIds 坏形状(gamma 解析失败落 [])→ 弃权", () => {
    expect(skipOf(cand(), meta({ clobTokenIds: [] }))).toContain("二元");
  });

  it("index 对齐破坏(clobTokenIds[idx] ≠ 候选 asset)→ 弃权:翻错边比不开仓危险", () => {
    // gamma 的 outcomes/clobTokenIds 与成交流 outcomeIndex 的对齐是结算已依赖
    // 的既有不变量(outcomePrices[outcome_index]);这里把它升格为翻边前的
    // 运行时校验 —— 对不上说明元数据漂移,买到的可能根本不是这个市场的对面。
    const m = meta({ clobTokenIds: ["tok-other", "tok-no"] });
    expect(skipOf(cand(), m)).toContain("对不上");
  });

  it("outcomeIndex 越界(非 0/1)→ 弃权", () => {
    expect(skipOf(cand({ outcomeIndex: 2 }), meta())).toContain("outcomeIndex");
  });

  it("镜像 referencePrice 越出 (0,1) → 弃权(极端价 1.0 的镜像是 0,无意义)", () => {
    expect(skipOf(cand({ referencePrice: 1 }), meta())).toContain(
      "referencePrice",
    );
    expect(skipOf(cand({ referencePrice: 0 }), meta())).toContain(
      "referencePrice",
    );
  });

  it("退化元数据(两个 token 相同,翻转后 asset 未变)→ 弃权", () => {
    const m = meta({ clobTokenIds: ["tok-yes", "tok-yes"] });
    expect(skipOf(cand(), m)).toContain("相同");
  });
});
