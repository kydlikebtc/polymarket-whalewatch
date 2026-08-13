# 反向对照策略实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给 6 个负 EV 档各建一个「同信号、买对面」的反向对照档,与正向档并排持续观察。

**Architecture:** 通用 reverse 变换(设计文档 §2 方案 B):`MarketMeta` 新增
`clobTokenIds`(META_V 2→3)→ 纯函数 `reverseCandidate` 在开仓循环里把候选翻到
对面 outcome → `StrategyParams.reverse` 由 parseStrategy 消毒 → 种子 v4 只 INSERT
6 条新档。护栏/执行层/结算/markout 零改动。设计全文见
`docs/plans/2026-08-13-reverse-control-design.md`。

**Tech Stack:** TypeScript / better-sqlite3 / vitest / Next.js(既有栈,零新依赖)

---

### Task 1: MarketMeta.clobTokenIds + META_V 3

**Files:** Modify `lib/gamma.ts`(interface + normalize + META_V);Test `lib/gamma.test.ts`;
tsc 会指出全部 MarketMeta 字面量构造点(预计集中在测试桩),逐一补 `clobTokenIds`。

1. 失败测试:normalize 从 stringified 数组解析 `clobTokenIds`(与 outcomes 对齐);
   缺失/坏形状 → `[]`;META_V=2 的缓存行(含 closed 永久缓存行)按 stale-shape 重抓一次。
2. 实现:`clobTokenIds: string[]`(必填)+ `jsonArr(row.clobTokenIds).map(String)`
   - `META_V = 3`(注释追加 `2 → 3: clobTokenIds`)。
3. `npx tsc --noEmit` 清零构造点报错 → `npx vitest run lib/gamma.test.ts` 绿 → commit。

### Task 2: reverseCandidate 纯函数

**Files:** Create `lib/reverse.ts` + `lib/reverse.test.ts`。

1. 失败测试组(设计 §3 逐条对应):
   - 二元市场翻转:outcome/outcomeIndex/asset 换到对面,referencePrice=1−p,
     formationTs/sourceKind/walletCount/totalNetUsd/title 原样;
   - fail-closed 每条原因独立可断言:meta 缺失 / outcomes 或 clobTokenIds ≠ 2 元素 /
     `clobTokenIds[idx] !== c.asset`(对齐破坏)/ outcomeIndex ∉ {0,1} /
     镜像 referencePrice 越出 (0,1) / 翻转后 asset 与原 asset 相同(退化元数据)。
2. 实现:`reverseCandidate(c, meta): { candidate } | { skip: string }` ——
   带原因的弃权(调试日志纪律:弃权必须能回答"为什么")。
3. vitest 绿 → commit。

### Task 3: StrategyParams.reverse + parseStrategy

**Files:** Modify `lib/followCandidate.ts`(类型)、`lib/follow.ts` parseStrategy;
Test `lib/follow.test.ts` parseStrategy 套件。

1. 失败测试:缺失 → false(既有 13 条零迁移);显式 true → true;非布尔 →
   warn + false(side 同一套「显式合法生效、缺失静默、非法留痕」纪律)。
2. 实现 + vitest 绿 → commit。

### Task 4: runFollowCycle 翻转接线

**Files:** Modify `lib/follow.ts` 开仓循环;Test `lib/followCycle.test.ts`。

1. 失败测试:
   - reverse 档开对面仓:heavy 信号 Yes@0.6 → 仓位 outcome=No / asset=对面 token /
     smart_avg_price≈0.4 / entry=对面现价;
   - **配对对称(对照语义核心)**:正反两档同轮开仓、方向相反,结算后恰好一赢一输;
   - meta 缺失 → reverse 档 fail-closed 弃权(同轮 consensus 档照常开,对比断言);
   - 3-way 市场(outcomes 3 元素)→ 弃权;
   - 结算用翻转后的 outcome_index 取 outcomePrices。
2. 实现:开仓循环候选进守卫链前,`s.reverse` 时过 `reverseCandidate`,
   弃权 continue + 带 strategy id/cid/原因的日志。
3. vitest 绿 → commit。

### Task 5: 种子 v4(6 档)

**Files:** Modify `lib/db.ts`;Test `lib/follow.db.test.ts`。

1. 失败测试(v3 套件同构延伸):全新库 19 条名字集合;v3 库(13 条+marker '3')
   升级 → 19 条、既有 13 条 params_json 逐字节不变、marker '4';
   6 条反向档与正向档的共享检测字段逐字节同值 + `reverse:true`(配对同步测试,
   仿既有 C1/逆势少数边 字面量同步测试)。
2. 实现:门控加宽 `!== "4"`,追加 6 条种子(反巨鲸/反超级巨鲸/反巨鲸精英/
   反分歧解除/反高分独狼/反早期赢家)。
3. vitest 绿 → commit。

### Task 6: 展示层

**Files:** Modify `lib/follow.ts` parseParamsView、`app/follow/page.tsx`
(STRATEGY_EMOJI / FAMILY_META blurb / sourceCoreHint / 卡片+列表 Tag)。
Test:`lib/follow.test.ts`(parseParamsView/buildFollowView 既有套件补 reverse)。

1. parseParamsView 透出 `reverse`(=== true 才真);页面类型补字段。
2. emoji 六映射(🪝/⚓/🎣/🏴/🐑/🍂,已核无撞车)+ 名字旁「反向对照」Tag
   (卡片与列表两处)+ sourceCoreHint 反向前缀 + 三族 blurb 各补对照读法一句。
3. vitest 绿 + tsc 清零 → commit。

### Task 7: 全量验证

`npx vitest run`(982 基线全绿 + 新增)→ `npx tsc --noEmit` → 终检
`git log --oneline` 提交序完整。
