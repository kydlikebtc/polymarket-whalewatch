# 第一梯队五件套设计 —— 容量标尺 · 确信指数 · 衰变哨兵 · 重推日历化 · 同批出生

> 日期：2026-08-28
> 来源：[第三轮脑暴](2026-08-28-iteration-brainstorm-round3.md) 用户裁决的第一梯队
> （#3/#15/#16/#17/#6）。选择标准即本批红线：**零新增上游调用、KB 级存储增量**，
> 全部是现有数据换问法。
> 测试基线：1872 tests / 144 files 全绿，typecheck 干净（动工前实测）。

## 统一约束（先于任何单件的设计）

1. **零新增上游**。五件全部只消费：开仓时已抓的订单簿快照、`market_daily` 已落的
   每日聚合、`follow_positions`/`strategy_signals` 已落的逐仓事实、
   `walkforward_reports` 已落的报告、consensus 循环已抓的 6h/$2k 深窗口、
   `wallet_age` 已缓存的年龄。任何一处出现新的 fetch 即违约。
2. **存储只落结论，不落流水**。新增列 6 个（follow_positions）+ 新告警行
   （cohort，事件级）；确信指数、衰变哨兵、重推 diff 全部读取侧现算零落库
   （与 `lib/marketPulse.ts:3-6`「评分刻意不落库」同裁决）。
3. **归因红线不破**。容量列与 `formation_*`/`exec_*` 同级：只展示，
   绝不参与开仓判定与 `realized_pnl`（`lib/orderBook.ts` 文件头红线的延伸）。
4. **i18n**：新增用户可见文案全部走中文键 + 英文译文（`coverage.test.ts` 与
   `dict.test.ts` 两道闸）；`/manage` 沿既有不翻译惯例的部分不强行翻。
5. **统计诚实**：哨兵与指数只给「观察/预警」态，不给交易建议；样本不足显式
   `insufficient`；同批出生告警携带年龄覆盖率声明（43% 覆盖且非随机的
   edge 审计教训）。

---

## 一、容量标尺（#3）—— 「这个信号能吃多少钱」

**问题**。策略中心展示每档的收益率与滑点成本，但从不回答跟随者最关心的问题：
这个信号在吃穿簿子前能容纳多少美元？「信号是真的，但只有 $3k 深」是必须
主动披露的事实。

**方案**。开仓瞬间已抓 ask 簿（`lib/follow.ts:768-790`），顺手多算两个数：

- `bookCapacityUsd(asks, bandCents)` —— 新纯函数（`lib/orderBook.ts`）：
  自最优档起，累计所有 `price ≤ bestAsk + bandCents/100` 档位的 `price×size`
  美元名义。带宽取 **+1¢ 与 +3¢** 两档（本仓的执行/markout 口径全用 cents，
  不用相对百分比——0-1 概率价上相对带宽在低价端会塌缩）。
- `follow_positions` 加两列 `book_cap_1c REAL`、`book_cap_3c REAL`
  （`lib/db.ts:126-146` 的循环 ALTER 样板；`lib/follow.db.test.ts` 的
  `FORMATION_COLS` 守卫清单同步加，否则 ALTER 漏写在 `:memory:` 下测不出）。
- 聚合：`computeStrategyMetrics` 增加 `bookCap1cMedian / bookCap3cMedian /
bookCapSamples`（中位数抗离群，均值会被一次厚簿拉爆）。
- 展示：`/follow` 卡片元信息行 + 详情弹窗，格式「容量 +1¢ $x · +3¢ $y (n=k)」。

**被否决的形态**：按滑点上限反解均价容量（avgPrice ≤ bestAsk×(1+p)）——
数值更大更好看，但「带内深度」才是标准盘口深度语义，且单调、可跨市场比。

**触点**：`lib/orderBook.ts`(+测试) · `lib/follow.ts`（:771-773 变量区、
:645-652 INSERT、:806-825 run、:1023-1056 metrics 接口、:1071-1190 实现）·
`lib/db.ts` · `lib/follow.db.test.ts` · `app/api/follow/route.ts`（:36-49
PositionRow、:63-72 SELECT）· `app/follow/page.tsx` · `lib/i18n/dict/follow.ts`。

## 二、确信指数（#15）—— 品类级「激辩度」日线

**问题**。`market_daily` 底座已能说单个市场的异常，但「这个品类今天整体在
激辩还是共识」没有任何呈现。VIX 类指数是每天一张图的内容素材。

**方案**。新纯模块 `lib/convictionIndex.ts`，读取侧现算（骑 `/api/pulse`
的 promise cache，零落库、零新表）：

- 粒度：(category, day)。对当日该品类全部 `market_daily` 行做量能加权聚合。
- 四分量（0..1，全部现成列，簿厚列不存在故无簿厚分量——见脑暴 §评估）：
  - `contest` = 量加权 `1 − one_sided`（阵营对峙度）
  - `divergence` = 满足分歧条件（`small_top_outcome ≠ whale_top_outcome` 且
    双桶净额过 `lib/marketPulse.ts:66-67` 同款门槛）的市场的量能占比
  - `priceMove` = 量加权 `min(1, |price_last − price_first| / 0.2)`
  - `volSurge` = 品类当日总量 vs 前 14 日基线（`marketPulse` volSurge 同法：
    `clamp01(log10(volRatio))`，基线不足 3 天退化为横截面分位）
- 指数 = `round(100 × (0.30·contest + 0.30·divergence + 0.20·priceMove +
0.20·volSurge))`。**高 = 激辩/恐慌，低 = 确信**（VIX 语义）。
- 输出含近 N 日（≤30）逐日序列供趋势小图；`truncated`/覆盖诚实字段透传。
- 展示：`/pulse` 第三个 section（该页无 tab，平铺 section 惯例）：每品类一行
  （指数、四分量微条、迷你趋势）。品类标签用 `catLabel` 既有翻译。
- 对外：`/api/pulse` payload 追加 `conviction` 键（additive；
  `docs/api-access.md` §13 `/api/pulse` 小节补字段说明 + §16 变更记录一行）。

**顺手补闸**：`lib/i18n/dict.test.ts:28-42` 的 `SHARDS` 名单漏了
`pulse`/`calibration` 两片（跨分片撞车检查裸奔），本批补上。

**触点**：`lib/convictionIndex.ts`(+测试) · `app/api/pulse/route.ts` ·
`app/pulse/page.tsx` · `lib/i18n/dict/pulse.ts` · `lib/i18n/dict.test.ts` ·
`docs/api-access.md`。

## 三、衰变哨兵（#16）—— 每档策略的序贯衰变监控

**问题**。深度分析面板有前半/后半对比（`HalfSplit`），但那是二分快照不是
序贯监控：档位衰变要等人看图才发现。walk-forward 给了同口径的期望，
「实盘偏离期望」应该自动亮牌。

**方案**。新纯模块 `lib/decaySentinel.ts`，`/api/follow` 服务端现算
（`withExitCounterfactual` 同样板：bulk 读 → `views.map` 挂键 → 失败整块
降级 null）：

- 原料：每档 `status='settled'` 仓按 `exit_ts` 升序的逐仓概率点贡献
  `(realized_pnl − fee_usd) / shares`（与 `lib/walkforward.ts:314-320`
  `contribOf` 完全同口径）。
- **市场级聚簇先行**：同 `condition_id` 的贡献先取均值折成一个观察点
  （N 份同一结算的复制品不能当 N 个独立观察——聚簇 CI 的同一教训）。
- 基线：前 `max(10, 40%)` 个市场点的均值 μ₀ 与标准差 σ（自含基线，
  不依赖 walkforward 报告——19 档全覆盖，且报告可能缺档）。
- 单侧 CUSUM 检测下行漂移：`S_t = max(0, S_{t-1} + (μ₀ − x_t − k·σ))`，
  松弛 `k=0.5`，报警门限 `h=4σ`、观察门限 `2.5σ`。
- 输出四态：`insufficient`（市场点 < 基线量+5）/ `ok` / `watch` / `degraded`，
  附证据 `{marketPoints, baselinePoint, recentPoint, cusumPeak, crossedAtTs}`。
- 展示：`/follow` 卡片 Tag 区（:1518-1539）新增
  `degraded → ⚠️ 疑似衰变`（warn）、`watch → 衰变观察`（默认色）；
  详情弹窗补一行证据。列表视图同步。

**为什么不用 walkforward 期望当基线**：报告只覆盖进网格的档，且其
`currentStat` 本身随重推刷新——哨兵要的是「相对自己历史」的稳定参照。
两口径通过同一 `contribOf` 保持可对话。

**触点**：`lib/decaySentinel.ts`(+测试) · `app/api/follow/route.ts` ·
`app/follow/page.tsx` · `lib/i18n/dict/follow.ts`。

## 四、重推日历化（#17）—— 季度例行 + 翻案 diff

**问题**。walk-forward 是「一次性大事」：跑完一次没有下次提醒，两次报告
之间哪些结论翻案要人肉对表。

**方案**（全部长在既有 `/manage` 🧪 tab 与 admin 路由上，不新增页面）：

- `lib/walkforwardDiff.ts` 纯函数：`diffWalkforwardReports(prev, curr)` 按
  `strategyId` 对齐档、按变体 `key`（`entryKey|category|exitRule`，
  `lib/walkforward.ts:89-90` 的稳定标识）对齐变体，产出四类翻案：
  `survivorAdded / survivorRemoved / watchlistChanged / insufficientFlipped`，
  外加 `currentStat.point` 漂移。
- `GET /api/admin/walkforward` 增加 `?list=1`（近 20 份报告元信息：id、
  created_at、窗口、grid）与 `?diff=1`（最近两份的 diff；`&id=&prevId=`
  可指定）。同鉴权同限流。
- 到期口径：距最近一次报告 `created_at` 满 **90 天**为 due。
  `WalkforwardSection` 顶部加状态行：「上次重推 X 天前 · 距季度例行还有 Y 天 /
  已到期」，due 时 amber。**不自动跑**——生产参数永不自动改的既有裁决延伸：
  子进程仍只由运营者点击触发。
- diff 渲染：Section 内新增「与上次对比」卡（有 ≥2 份报告才出现）。

**被否决的形态**：worker 定时自动跑重推——CPU 重活 + 「推荐永不自动生效」
的红线让自动跑只省一次点击、多一类事故。

**触点**：`lib/walkforwardDiff.ts`(+测试) · `app/api/admin/walkforward/route.ts` ·
`app/manage/WalkforwardSection.tsx` · `app/manage/walkforwardView.ts`(+测试)。

## 五、同批出生检测（#6）—— 新钱包协同指纹

**问题**。单个新钱包大额买入已有 insider-hunt 组合筛，但「N 个几乎同时出生
的新钱包进同一市场同一边」这个更强的协同指纹没有任何检测器在看。

**方案**。新模块 `lib/cohortBirth.ts`（纯检测 + 格式化 + cycle 壳，
`lib/consensus.ts` 同构但更小），挂在 consensus 5 分钟循环里做深窗口
（6h/$2k，`worker/embeddedEngine.ts:338-341`）的**第五个消费者**，
自带 try/catch 隔离（follow 先例 :392-394）：

- 结构预筛（纯函数 `detectCohorts(trades, ages, opts)`）：按
  (conditionId, outcome) 聚组，逐钱包净买（BUY−SELL 名义）≥ $2,000，
  组内钱包 ≥ 3，合计 ≥ $10,000。
- 年龄判定：**严格缓存裸读** `SELECT wallet, first_ts FROM wallet_age WHERE
wallet IN (...)`（`lib/discovery.ts:533` 先例，零上游）。只认
  `first_ts` 为数值的行（NULL=「已验证无活动」语义含混，v1 不认）；
  `ageDays ≤ 7` 记为新钱包；组内新钱包按 `first_ts` 排序取 48h 滑窗内
  最大子集为「同批」。同批 ≥ 3 才成立。
- 告警：`recordAlert(db, "cohort", dedupKey, payload)`，
  `dedup_key = cohort:${conditionId}:${outcome}:${walletCount}` ——
  `(type, dedup_key)` 唯一索引天然给出「只报形成与升级、不报重复」，
  不需要状态表（比 consensus 更简：无 TTL 提醒语义）。
- payload 形态对齐 `ConsensusGroup`（`wallets[]`、`totalUsd`、`avgBuyPrice`、
  `lastTs`、`asset`、`outcomeIndex`、`params` 快照）+ 同批特有字段
  （`birthSpanHours`、`youngestAgeDays`、`ageKnown/groupSize` 覆盖声明）——
  这样验证回填的 trackable 分支可镜像 consensus（`lib/alertOutcomes.ts:41-59`）。
- 参数：代码常量（consensus 先例 B——`DEFAULT_COHORT = { maxAgeDays: 7,
birthSpanHours: 48, minWallets: 3, minPerWalletUsd: 2000,
minTotalUsd: 10000 }`），v1 无配置面。
- 投递面（consensus 完整先例逐处走）：
  - TG：`TgKind` 加 `"cohort"`，**默认关**（新能力默认关的 xSettings 纪律；
    `/manage` 投递目标复选框随 `TG_KINDS` 自动出现）；formatter
    `formatCohortAlert` 带年龄覆盖行「组内 N 钱包 · 年龄已知 M · 同批 K」。
  - `/alerts` 页：`app/api/alerts/route.ts:88` 加 cohort payload 解析分支；
    `TYPE_ICON`/`TYPE_LABEL` 登记（🐣 / 同批新钱包）。
  - 验证回填：`parseTrackable` 加 cohort 分支 → 1h/24h/结算自动覆盖。
  - 信号总线：`BUS_TYPES` 登记 `available: false`（`accumulation` 待接入
    先例）——三处投影白名单接线独立成批，不在本期（历史上这里反复漏字段）。
  - 𝕏 播报：不接（kind 面不动）。
- **诚实声明**：缓存年龄覆盖率天然不足（历史实测 43% 且非随机），检测灵敏度
  随缓存自然增长（discovery/看板/钱包页都会永久回填年龄）。告警文案强制携带
  覆盖率；有界主动补年龄（每轮 ≤N 个）作为已知升级路径**显式缓议**——
  它会破坏本批「零新增上游」承诺。

**触点**：`lib/cohortBirth.ts`(+测试) · `worker/embeddedEngine.ts` ·
`lib/tgTargets.ts` · `lib/alertOutcomes.ts` · `lib/signalBus.ts`（登记行）·
`app/api/alerts/route.ts` · `app/alerts/page.tsx` · `lib/i18n/dict/alerts.ts`。

---

## 任务拆解（每任务一提交，TDD：先测后码）

| 任务 | 内容                                                           | 主要新测试                                                        |
| ---- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| A    | 容量标尺全链（纯函数→列→聚合→展示）                            | orderBook 容量边界（空簿/部分带/全带）、db 列守卫、metrics 中位数 |
| B    | 确信指数（模块→API→/pulse UI）+ SHARDS 补闸 + api-access       | 分量计算、量能加权、基线退化、空日                                |
| C    | 衰变哨兵（模块→API 挂键→卡片 Tag）                             | 聚簇折点、CUSUM 触发/不触发、insufficient、降级                   |
| D    | 重推日历化（diff 纯函数→路由 list/diff→Section 状态行）        | diff 四类翻案、due 计算、少于两份报告                             |
| E    | 同批出生（检测→worker→TG/alerts/验证）                         | 结构预筛、滑窗同批、覆盖声明、dedup 升级语义、trackable           |
| F    | CHANGELOG 批次条目 + README（roadmap/At a glance）+ 本文档索引 | 文档守卫全绿                                                      |

每任务完成必须：`npm test` 全绿（基线 1872+新增）+ `npm run typecheck` 干净。
