# Walk-forward 阈值重推 — 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 全程遵循 @superpowers:test-driven-development（红→绿→重构），频繁提交。
>
> 日期：2026-08-28 · 上位文档：[设计文档](2026-08-28-walkforward-rederivation-design.md)（所有裁决以它为准；本计划只把它翻译成任务）
> 基线：1785 tests / 139 files 全绿 + `tsc --noEmit` 0 错误。完成定义 = 基线保持全绿 + 新增测试全绿 + CHANGELOG/docs 索引同步 + 真机证据。

**Goal:** 交付 `lib/walkforward.ts` 纯函数层 + `scripts/walkforward.ts` 只读报告脚本 + `walkforward_reports` 落库表 + /manage「🧪 阈值重推」卡——对 13 个厚档在收紧/平移方向做网格×子集选择的 walk-forward 评估，产出通过三道显著性闸的变体建议。**绝不自动修改任何存量档参数。**

**Architecture:** 与 edge-audit 同款分层——`lib/` 放纯函数（零 DB 句柄，TDD 直测），脚本负责 SQL 取数、组装、终端渲染与落库；/manage 卡经 `/api/admin/walkforward`（ADMIN_TOKEN 后）读最新报告行。统计三件套（CRVE 聚类稳健 + Bonferroni 按实际评分格数 + 方向随机化）全部在 lib 层。

**Tech Stack:** 既有栈零新增依赖（better-sqlite3 / vitest / tsx / Next.js App Router）。

---

## 0. 口径裁决（设计文档没钉死、实现必须钉死的地方）

设计文档定了方法论骨架；下面是勘探数据坐标后补钉的实现级裁决。**每条都要落进代码注释或报告固定段落**，不许只活在本计划里。

### 0.1 主指标：逐仓贡献（概率点）

```
contrib_i = pnlPerShare_i − feePerShare_i
  pnlPerShare_i = rulePnl_i / shares_i     // hold → realized_pnl；九规则 → position_exit_sims.pnl
  feePerShare_i = fee_usd_i / shares_i     // fee_usd=0 是确知免费；null 行不进宇宙（§0.2）
```

- 二元结算下 `realized_pnl/shares = resolution − entry = won − q`——**入场赔率调整天然内建**（entry_price 就是市场隐含概率），与 `gradeRows` 的 excess=wins−implied 同族（Σcontrib = excess − Σfee）；提前退出时自然推广为 `exit_price − entry_price`。
- 逐仓等权（sizeUsd 刻意不进网格，同一理由不做金额加权）；市场聚类（cluster = condition_id）只修区间不修点估计，CRVE 口径原样移植 edge-audit 的 `stat()`。
- **记账基准 = entry_price**（realized_pnl 与九规则 sims 都建立在它上），不混入 exec_price——换基准等于让报告数字与全站已发布战绩打架。exec/滑点属于诊断维度，v1 不进指标。

### 0.2 分析宇宙（每档）

```
status='settled' AND realized_pnl IS NOT NULL AND formation_ts IS NOT NULL
AND fee_usd IS NOT NULL AND entry_price ∈ (0,1) AND shares > 0
```

- `fee_usd IS NULL`（08-04 之前的老仓 + meta 取不到的仓）**整行出宇宙**——绝不当 0（edge-audit 教训），也不学它「组内有 null 整组报 null」（那会把大半分组打成费用未知）。剔了多少逐档披露。
- `formation_ts NULL`（形成价取失败的仓）无法归折，同样出宇宙、披露。
- 每档同时打印**原始 settled 总数**（与线上 `/api/follow` 口径可直接对表）与宇宙数。

### 0.3 事实覆盖窗（哪个维度从哪天起可回放）

| 事实                                 | 落库起点   | 影响的过滤维度                              |
| ------------------------------------ | ---------- | ------------------------------------------- |
| formation_ts/price、entry、markout   | 2026-07-08 | 偏离护栏、freshSec、maxPrice（全窗覆盖）    |
| fee_usd                              | 2026-08-04 | 宇宙本身（干净窗第一周=无费周，整周出宇宙） |
| market_tilt_history                  | 2026-08-11 | tiltPct 维度                                |
| strategy_signals（position_id 关联） | 2026-08-15 | wallet_count / total_net_usd 系维度         |
| position_exit_sims                   | 存量已回填 | 退出维度（墓碑仓除外）                      |

某维度事实缺失的仓**从该维度变体的子集里剔除**（`filter` 返回 null），不猜值；剔除量进报告。信号系维度只有后半窗——最小样本闸门会诚实地把它们打进观察名单，这是结论不是故障。

### 0.4 网格：单维平移 × 赛道 × 退出（不做维度间全叉积）

设计 §5 的算术（13 档 × ≤24 入场变体 × 10 退出 ≈ 3,000）只在**一次只动一维**下成立；全叉积也会把 Bonferroni 分母炸大、且多维同动的胜出变体无法翻译成一条可解释的挑战者档参数。

- 阶梯全部**固定值 ∩ 严格紧于当前值**（当前值=parseStrategy 消毒后的生效值，含默认兜底）：

| 族（source）           | 维度                   | 阶梯                     | 回放事实                                                                                       |
| ---------------------- | ---------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| heavy                  | minSingleFillUsd       | ×1.5 / ×2                | signals.total_net_usd（heavy 的 totalNetUsd=那一笔）                                           |
| heavy                  | maxPrice               | 0.90 / 0.85              | entry_price（引擎护栏原样：`entry > maxPrice` 跳过）                                           |
| heavy                  | maxEntryDeviationCents | 6 / 4                    | \|entry_price − formation_price\|×100（引擎护栏原样）                                          |
| consensus              | minWallets             | 当前+1                   | signals.wallet_count                                                                           |
| consensus              | minPerWalletUsd        | ×1.5 / ×2                | **均值口径** total/count（见下）                                                               |
| consensus              | freshSec               | 600 / 300 ∩ <当前        | entry_ts − formation_ts（≈检测时新鲜度，披露近似）                                             |
| lopsided/resolved      | minTiltPct             | 当前+0.1（cap <1）       | market_tilt_history atOrBefore(formation_ts, ≤1h)                                              |
| lone_wolf/early_winner | minNetUsd              | ×1.5 / ×2                | signals.total_net_usd                                                                          |
| 全族横切               | 赛道                   | 全部 / 仅体育 / 仅非体育 | event_category（categoriesFor 同口径，category='Sports'；null=未知，两个受限子集都不进，披露） |
| 全族横切               | 退出                   | hold + 九规则查表        | position_exit_sims                                                                             |

- **score 下限维度（设计 §5 原表）不可回放**：仓位/信号行都没记录触发钱包与彼时评分，smart_wallets.score 是当前值（前视污染）。以 minNetUsd 平移代之，报告固定段落写明「score 维度需先向前落 wallet+score 才能网格化（v2）」。这是可观测锥纪律对设计网格表的一次修正，不是偷工。
- **minPerWalletUsd 均值口径**：逐钱包金额未落库，`total/count ≥ k·X` 是「每钱包 ≥ k·X」的**必要不充分**条件——该子集是真收紧子集的超集。报告固定段落声明；胜出变体建挑战者档时配的仍是真 minPerWalletUsd，向前对照给出无偏读数（champion/challenger 是所有近似的最终安全网）。
- 入场变体数/档 = 1（基线）+ Σ各维阶梯档数；×3 赛道 ≤ 24 ✓；×10 退出。无效变体（阶梯与当前重合、维度参数缺失如 heavy 档没配 minSingleFillUsd）在网格生成期就剔除。

### 0.5 折与选择/评价分离

- 折 = UTC 整周（`utcWeekStart`），按 **formation_ts** 归折。闸门起点 `GATE_START = 2026-07-28 00:00 UTC`（写死常量+注释，与 /api/continuity 的 streak 起点同源）。
- **设计前提修正（实现期发现）**：2026-07-28 实际是 UTC **周二**，不是设计 §4.1 说的「恰为周一」（独立验算：2026-01-01 周四 +208 天=周二；`utcWeekStart` 同判）。设计的「4 整折」按错历推的。实现按真实日历走：首个干净整周顺延到 2026-08-03（周一），07-28～08-02 的残段与闸门前数据一样只进 train；截至 2026-08-28，validate 折 = **08-10、08-17 两折**（08-31 起自然长出第三折）。有测试钉住这条修正。
- validate 折 = 首个干净整周之后的**完整周**（跑的当天所在的不完整周不做 validate——「已结算」子集在新折里天然偏向快结算市场，报告代表性一节披露这层偏置）。
- train(折 k) = formation_ts < 折 k 起点的**全部历史**（含闸门前旧数据——只进 train 永不 validate）。
- **折对某变体可评** ⇔ train 与 validate 双侧都过最小样本闸（settled ≥ 10 且去重市场 ≥ 5；train 侧也设闸，否则 3 仓 train 的噪声排序会白烧 validate 与 Bonferroni 名额）。
- **入围（train 只选）**：变体在其每个可评折上 train contrib 均值 **严格大于** 基线同折 train 均值 → 才成为候选、才允许看 validate。未入围的变体**连 validate 数字都不发布**（发布即烧 OOS）。
- 可评折 < 2 → 观察名单（只报名字与原因，无 validate 数字）。基线自己可评折 < 2 → **整档薄档**：跳过网格，只报当前全样本的聚类 CI 现状。

### 0.6 三道闸（全部在候选的 pooled validate 仓上）

- pooled = 各可评折 validate 仓合并（折是不相交时间片；跨折同市场由 cluster 兜住）。
- **闸 A（聚类 CI × Bonferroni）**：CRVE 下 `point − z* · seC > 0`，`z* = normalQuantile(1 − (0.05/G)/2)`，G = **实际发布过 validate 成绩的格数**（候选 + 各档基线；脚本如实统计打印）。
- **闸 B（方向随机化）**：一次抽签/市场——u ~ U(0,1)，与簇参考 outcome 同边的仓 `won = u < q_i`，对边的仓 `won = u ≥ 1 − q_j`（保各自边际 q，同市场内完全相关：同边共单调、对边反相关——不做逐仓独立重掷，那会重犯 clusteredInterval 修过的那个错）。null 统计量 = mean(won − q − fee)，`p = (1+#{null ≥ 实测})/(1+次数)`；判过 ⇔ `p ≤ 0.05/G`。生产 10,000 次、种子写死默认值（重跑可复现）；G > 500 时 10k 次的最小 p 都过不了闸——脚本检测并明说。
- **退出≠hold 的格**：闸 A 用该格自己的 rule-pnl 贡献；闸 B **继承同一入场子集 hold 基准的 p**（随机化只能重掷结算、不能重掷路径；退出规则不产生方向技能，方向技能不成立的子集叠什么退出规则都不建议）。报告固定段落带 exitCounterfactual 的红线原话：纸面对纸面、~10min 蜡烛盲区、推及实盘须另计退出侧盘口与费。
- 存活 = A ∧ B。「无变体存活」逐档一等结论。

### 0.7 产出与红线

- 每次运行 INSERT 一行 `walkforward_reports`（历史留痕，月度节律天然成立）；同库同种子重跑结果逐字节确定。
- 报告固定段落（设计 §7 逐条 + §0.4 的两条近似声明 + §0.6 的退出红线）。
- **本批不改任何 follow_strategies 行、不动种子版本、不新增公开 API 端点**（/api/admin/* 在 ADMIN_TOKEN 后，不属 api-access.md 管辖——已核对该守卫不枚举路由目录）。

---

## 约定

- 跑单测：`npx vitest run lib/walkforward.test.ts`；全套 `npm test`；类型 `npm run typecheck`。
- worktree 里 dev 用 `npm run dev:webpack -- -p 3457`。
- 每任务 TDD 五步：失败测试 → 确认失败 → 最小实现 → 通过 → commit。

---

### Task 1: 折切分（lib/walkforward.ts 起步）

**Files:** Create `lib/walkforward.ts`, `lib/walkforward.test.ts`

失败测试（describe "折切分"）：

- `listValidateFolds(gateStart, nowSec)`：now 落在 W5 中段 → 返回 [W2, W3, W4] 的周一起点；now 恰为周一 00:00 → 上一周成为最后一个完整周；now < gateStart+14d → 返回 []。
- `foldOf(formationTs, folds)`：闸门前时间戳 → "train-only"；W2 内 → W2；折起点边界（周一 00:00 归本周，前一秒归上周——直接复用 `utcWeekStart`，测试钉边界）。

实现：`WfFold { start: number }`；validate 折 = start ≥ gateStart+7d 且 start+7d ≤ utcWeekStart(now) 的周。`GATE_START_TS` 常量放脚本侧（lib 收参数，保持纯函数可测）。

Commit: `feat: walk-forward 折切分 —— UTC 周对齐/formation 归折/旧数据只进 train`

### Task 2: 网格生成

**Files:** Modify `lib/walkforward.ts`(+test)

失败测试（describe "网格生成"）：

- heavy 档（minSingleFillUsd=50000, maxPrice=0.95, dev=10）→ 入场维度变体 = 基线 + fill×1.5/×2 + maxPrice 0.90/0.85 + dev 6/4 = 7；×3 赛道 ×10 退出 = 210 格；每格 key 稳定、label 人读。
- maxPrice 当前已 0.90 → 只剩 0.85 一档（阶梯 ∩ 严格紧于当前）。
- heavy 档没配 minSingleFillUsd → 该维不出变体（不猜默认）。
- consensus 档 freshSec=300（已最紧）→ freshSec 维为空。
- lopsided minTiltPct=0.95 → +0.1 越界，维为空。
- lone_wolf → minNetUsd ×1.5/×2；**不存在任何 score 维度**（钉死替代裁决）。
- 全网格 `gridTotal` = Σ档，与手算一致。

实现：`buildVariantGrid(params: StrategyParams): WfVariant[]`；`WfVariant { key, label, dim, entryFilter(p): boolean|null, category, exitRule }`（entryFilter 返回 null = 该仓缺此维事实）。类型 `WfPosition` 同步落定（§0.2/0.3 的字段）。

Commit: `feat: walk-forward 网格 —— 单维平移×赛道×退出,固定阶梯∩紧于当前`

### Task 3: 子集过滤语义

失败测试（describe "子集过滤"）：逐族一条红一条绿——

- heavy fill ×1.5：totalNetUsd 75k 进 / 74k 出 / null → null（剔除且计数）。
- maxPrice 0.90：entry 0.90 进（引擎语义 `entry > max` 才拦）/ 0.901 出。
- dev 6：|entry−formation|=5.9¢ 进 / 6.1¢ 出 / formation null → null。
- consensus minWallets+1、minPerWalletUsd 均值口径、freshSec 600（entry−formation 600s 进 / 601 出）。
- tilt +0.1：tiltPct null → null。
- 赛道：sports 只留 category==='Sports'；nonsports 留非 null 非 Sports；null 两边都 null。
- `subsetOf(positions, variant)` 返回 {included, droppedMissing}。

Commit: `feat: walk-forward 子集过滤器 —— 收紧语义逐族钉死,缺事实剔除不猜值`

### Task 4: 退出查表合成

失败测试（describe "退出合成"）：

- hold：contrib = realized_pnl/shares − fee/shares。
- tp10 触发仓：用 sims.pnl；未触发仓 sims 表里 pnl 已等于 realized_pnl（exitCounterfactual 落库语义），直接查表不特判。
- exitSims null（未回填/墓碑）→ 退出≠hold 的格里该仓剔除（hold 格保留）。

实现：`contribOf(p, exitRule): number | null`。

Commit: `feat: walk-forward 退出维度 —— position_exit_sims 逐仓查表,零新模拟`

### Task 5: CRVE 统计核心

失败测试（describe "聚类稳健统计"）——直接移植 edge-audit `--selftest` 的三条性质到新签名：

- 每行独立 → 聚类 ≈ 朴素（差 G/(G−1)）。
- 20 市场×10 复制 → 区间 ≈ √10 倍、点估计不变。
- 同市场对边各自入账，点估计不被挑边带跑。
- `normalQuantile(0.975) ≈ 1.96`、`normalQuantile(1−0.05/120·½)` 与 edge-audit 同值。

实现：`clusterStat(rows: {contrib, cluster}[]): {n, nc, point, seC, seNaive}`；`normalQuantile`（A&S 26.2.23，注明镜像自 scripts/edge-audit.ts——脚本不该被 lib 反向依赖，8 行重复换单向依赖）。

Commit: `feat: walk-forward CRVE —— edge-audit 聚类稳健口径原样移植并以其自检性质钉死`

### Task 6: 方向随机化

失败测试（describe "方向随机化"）：

- mulberry32 种子固定 → 序列确定（两次调用逐值相等）。
- 单市场 10 仓同边全胜（q=0.5）→ 100 次抽签下 p 明显大于逐仓独立口径（≈0.5 vs ≈0.001 量级）——钉「按市场抽签，不逐仓」。
- 同市场对边两仓：抽签结果恰一胜一负（反相关耦合）。
- 边际正确：q=0.3 的仓在 10k 次里 won 频率 ≈ 0.3（±3σ）。
- p 公式 `(1+k)/(1+N)`：全 null ≥ 实测 → p=1；全 < → p=1/(N+1)。

实现：`randomizationP(rows, draws, seed)`；rows 带 {conditionId, outcome, q, fee}。

Commit: `feat: walk-forward 方向随机化 —— 市场级抽签保边际/簇内全相关,种子可复现`

### Task 7: 全档评估管线

失败测试（describe "walk-forward 评估"）——合成一个 heavy 档数据集，钉：

- 基线可评折 < 2 → `thin: true` + 全样本聚类 CI 现状，无网格。
- 最小样本闸：validate 9 仓 / 市场 4 个的折被弃；train 侧同。
- train 未入选（某变体折上 train 均值 ≤ 基线）→ 不出现在 candidates、不贡献 G。
- G = 候选数 + 基线数（钉一个具体数字）；z* 随 G 变化。
- 三道闸红绿：构造「validate 强 edge + 随机化过」存活；「train 赢 validate 输」不存活。
- 退出格继承入场子集的随机化 p（钉同 key 不同 exitRule 的 randP 相等）。
- 观察名单：可评折 1 的变体进 watchlist。

实现：`evaluateStrategy(positions, params, folds, opts): TierReport` 与 `runWalkforward(tiers, folds, opts): WalkforwardReport`（两段式：先全档收集候选算 G，再统一判闸——G 必须全局定死后才能判任何一格）。报告 JSON 形状在此任务定型（manage 卡消费同一类型）。

Commit: `feat: walk-forward 评估管线 —— train 选/validate 评/三道闸/薄档与观察名单`

### Task 8: 反事实校验（设计 §9 点名）

失败测试（describe "反事实校验"）：

- **无 edge 均匀集**：种子造 200 个独立子集（每个 30 仓 15 市场，won ~ Bernoulli(q) 真无 edge），随机化 100 次 → p ≤ 0.05 的占比落在 [0.5%, 12%]（种子固定，断言确定）。
- **强 edge 构造集**：40 仓 20 市场 q=0.5 全胜 → 三道闸全过、survives=true。
- 均匀集喂进 `evaluateStrategy` 全流程 → 无存活变体（端到端假阳兜底）。

Commit: `test: walk-forward 反事实校验 —— 无 edge ~5% 假阳率、强 edge 必存活`

### Task 9: walkforward_reports 表

**Files:** Modify `lib/db.ts`(CREATE TABLE IF NOT EXISTS 一行), `lib/db.test.ts`(roundtrip)

`walkforward_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, window_from INTEGER NOT NULL, window_to INTEGER NOT NULL, grid_size INTEGER NOT NULL, config_json TEXT NOT NULL, report_json TEXT NOT NULL)`。报告是数据，进库不进 git。

Commit: `feat: walkforward_reports 表 —— 报告落库,月度节律留痕`

### Task 10: scripts/walkforward.ts

**Files:** Create `scripts/walkforward.ts`（edge-audit 姊妹风格；脚本薄壳，无单测，统计全在已测 lib）

- 自述头：三层校正声明 + 可观测锥声明（只收紧；放松=开挑战者档向前跑）+ 网格总数与 G 的区别 + `npx tsx scripts/walkforward.ts [dbPath]`。
- 取数：§0.2 宇宙 SQL + LEFT JOIN strategy_signals(position_id) + categoriesFor 批量 + tilt atOrBefore 点查（仅 lopsided/resolved 档）+ exit sims 批量 + `parseStrategyForTest` 解析各档参数（有 settled 仓的档全进，enabled 与否照报）。
- 组装 folds/tiers → `runWalkforward` → 终端渲染（代表性一节先行：宇宙裁剪计数、fee 无费周、信号系维度覆盖起点、体育占比）→ INSERT 报告行 → 打印 id。
- 常量区：GATE_START、RAND_DRAWS=10000、SEED、阶梯表——全部顶部集中（edge-audit 的 BONFERRONI_GROUPS 纪律；G 是算出来的，不写死）。

验证：`npx tsx scripts/walkforward.ts /tmp/wf-demo.sqlite`（Task 13 的合成库）跑通全链路。

Commit: `feat: scripts/walkforward.ts —— 只读库零上游,报告落库,自述头三层声明`

### Task 11: /manage 🧪 阈值重推卡

**Files:** Create `app/api/admin/walkforward/route.ts`, `app/manage/WalkforwardSection.tsx`, `app/manage/walkforwardView.ts`(+test); Modify `app/manage/page.tsx`

- route：GET，`checkWriteAccess` + `guardExpensive`（market-card 同姿态），返回最新报告行（无 → `{report:null}`）。
- `walkforwardView.ts` 纯函数（TDD）：`tierLine(t)` → 「薄档 n=X 只报现状 / 无变体存活 / 幸存 k：<label> +X.X±Y.Y 点 p=Z」；`reportMeta(r)` → 跑于/窗口/网格数/G。测试钉三种档形态 + 空报告。
- Section：sectionGate 三态；空态给出确切命令 `npx tsx scripts/walkforward.ts`；卡尾固定一行可观测锥声明。**只展示，无一键建档**（设计 §6.2）。
- 挂载：`page.tsx` 的 `lineSub === "signals"` 分支在 `<SignalsSection>` 之后渲染 `<WalkforwardSection token>`——重推是「② 策略信号」区的运营信息，不加新子 tab、不动 SECTION_TAB（StatusStrip 无需跳到它）。

Commit: `feat: /manage 🧪 阈值重推卡 —— 最新报告摘要,只展示不建档`

### Task 12: 文档同步

- CHANGELOG：新批次条目（英文叙事体，讲清可观测锥/三道闸/永不改参数/挑战者档路径）+ Scope 行刷新 commits/tests 数（最后跑完全套后填真值）。
- docs/README.md：索引表加 implementation 行（与 design 行相邻、同日）+ 四处计数散文 37→38、40→41、无后缀 8→9 并把本文件补进「自述为 Implementation Plan」名单——`docsPlansIndexParity` 守卫会验。

Commit: `docs: CHANGELOG 批次条目 + README 索引/计数同步`

### Task 13: 全绿 + 真机 + PR

1. `npm test` 全套 + `npm run typecheck` 0 错——基线 1785/139 只增不减。
2. 合成演示库：`npx tsx` 一段播种脚本（临时文件不入库）造 `/tmp/wf-demo.sqlite`——2 个厚档（heavy/consensus 各一，含跨 5 周 formation、fee、signals 关联、exit sims 九规则行）+1 个薄档，跑 `scripts/walkforward.ts` 全链路，核对终端报告与落库行。
3. 把 demo 库拷进 worktree 当 `data.sqlite` → `npm run dev:webpack -- -p 3457` → /manage（本地无 ADMIN_TOKEN 自动解锁）→ 🧪 卡截图。
4. 线上口径对表：`curl whalewatch.wired.fund/api/follow` 记录各档 settled 计数，写进 PR 正文（脚本的「原始 settled」列与之同口径——本地没有生产库副本，真跑生产报告留给运维在服务器上执行，PR 说明这点）。
5. push `claude/walkforward-impl` → PR（base main），正文含测试证据 + 截图 + /api/follow 对表；CI 只认 typecheck + unit tests，Workers Builds 红是僵尸集成照例忽略。

---

## 增补(同日,用户追加需求):/manage 独立 tab + 页面触发 + 报告下载

原 Task 11 的「卡挂在 ② 策略信号底部、跑报告靠 SSH」被三条追加需求取代:①页面直接触发对生产库跑;②下载完整报告数据;③模块独立成 tab 并带详细使用说明。

### Task 14: 运行管理器 lib/walkforwardRun.ts(+test)

页面触发 = 服务端 **spawn 子进程**跑 `npx --no-install tsx scripts/walkforward.ts <DASH_DB>`——与运维 SSH 手工跑逐字节同一条路径;绝不在请求内直算(runWalkforward 是同步 CPU 活,会把 4s 告警循环连同整个事件循环冻住)。镜像可行性已核对:Dockerfile runner 阶段整拷 `node_modules + scripts/ + lib/`(builder `npm ci` 含 devDeps → tsx 在场)。TDD 六用例:互斥锁拒绝并跑 / exit 0 成功态 / 非零失败态含 stderr / tail 只留末尾 8KB / spawn 同步抛错不留 running 僵尸 / error 事件后迟到 exit 不翻案。spawn 注入,lib 零 node 依赖;模块级锁(单容器单进程部署形态,apiGuard 同款惯例)。脚本补 `busy_timeout=5000`(生产库引擎在写,默认 0 会让末尾 INSERT 撞锁抛掉整轮)。

### Task 15: 路由扩展 + 独立 tab + 使用说明

- 路由:`GET /api/admin/walkforward` 增 `runState`;`GET ?download=1[&id=N]` 返回完整落库行(config 可复现清单 + report 全部格明细)带 `Content-Disposition` 附件(文件名 `walkforward-<id>-<日期>.json`);`POST` 触发一次(互斥 409;限流 6/min 挡手抖,锁才是真闸)。
- /manage:🧪 阈值重推升为**第 4 个顶级 tab**(既不是信号线也不是管线,是月度参数体检;挤在 ② 底部会被 19 档大表推到三屏外),从 signals 子 tab 移除。tab 内容 = 动作行(跑/下载/状态行,跑中 4s 轮询,失败展示 stderr 末尾)+ 报告详情(逐档存活变体明细表/格账本/观察名单)+ 📖 使用说明卡(这是什么/怎么跑/怎么读/怎么采纳/红线与近似,五点)。
- 下载走 fetch→blob(普通 `<a>` 带不了 x-admin-token 头);`runStateLine` 纯函数 TDD 四用例。

### 验收(增补部分,已完成)

真机 dev :3457:点「▶」→ ⏳ 跑中 → ✅ 成功(耗时 1s)→ 报告 meta 由 02:44 更新为 03:13、库中新增 id=3 行;`?download=1` 实测 `content-disposition: attachment; filename="walkforward-3-20260828.json"`,58KB 完整 JSON(config seed/3 tiers/9 declarations);整页截图含四 tab 导航、40 行存活明细表与使用说明。
