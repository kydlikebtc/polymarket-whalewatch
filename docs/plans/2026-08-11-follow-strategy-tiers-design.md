# 纸面跟单策略档位扩充设计（2026-08-11）

把纸面跟单从「2 条只在共识门槛上有区别的策略」扩到「4 个信号族 × 12 档」，
并抽出信号检测与开仓的解耦层，让后续新增信号源不必再动开仓代码。

---

## 1. 背景：现状只用了策略空间的 1.5 层

`lib/db.ts:320-341` 种子里的两条策略：

|                        | 保守       | 激进       |
| ---------------------- | ---------- | ---------- |
| minWallets             | 3          | 2          |
| minPerWalletUsd        | $10,000    | $5,000     |
| sizeUsd                | $500       | $500       |
| exitRule               | settlement | settlement |
| maxEntryDeviationCents | 10         | 10         |

后三行完全相同 —— 整个跟单页只在回答一个很窄的问题：「共识门槛调松一点会不会更好」。

一条完整的策略其实是五层决策：**进什么信号 / 什么条件才进 / 进多少 / 什么时候出 / 对照基准**。
现有参数全挤在第一层（信号门槛）和第三层（固定 $500），第二、四、五层空白。

本设计聚焦**第一层（信号源）**的扩充 —— 用户明确选择「信号源优先」路线：
先回答「哪类信号有 alpha」，退出规则（`exitRule` 目前是死字段）与对照组留后续批次。

---

## 2. 两个代码实证发现

这两条不是推测，是从模块判据里读出来的，它们直接决定档位怎么切。

### 2.1 「推了不跟」的精确清单

`lib/signalFeed.ts:29` 定义了推送侧的三种 `SignalKind`，跟单只接了第一种：

| Kind        | 判据（代码实证）                                                                 | 推送                 | 跟单                                |
| ----------- | -------------------------------------------------------------------------------- | -------------------- | ----------------------------------- |
| `consensus` | ≥2 白名单钱包净买同一 outcome                                                    | 有                   | **有**                              |
| `heavy`     | **单个**白名单钱包单笔 BUY ≥ `HEAVY_MIN_USD` = **$50,000**（`signalFeed.ts:32`） | 有                   | **完全没有**                        |
| `split`     | 同一市场 ≥2 个 outcome 都有共识                                                  | 有（折叠成无方向卡） | **整个市场剔除**（`follow.ts:270`） |

「异常大额」这一类的完整判据和生产阈值系统里**早就有了**（`foldHeavy`），只是从没喂给跟单。

### 2.2 跟单没有价格上限，但告警有

`alertConditions.ts:29` 的默认 `maxPrice = 0.95`，注释记录了生产实测理由：

> 28.6% 的告警落在 ≥0.90 —— 近确定结果上的结算清扫单，携带约等于零的信息量

而 `runFollowCycle` 全文只有 `entry <= 0` 一个价格检查，**没有任何价格上限**。

后果很隐蔽：跟单账本里混着一批「买 0.97 赚 3¢」的清扫仓，
它们把**胜率拉得很高很好看，但每次翻车亏掉 30 次的利润**。
Wilson 区间救不了 —— 区间衡量的是胜率的不确定性，而这批仓的问题是**赔率极度不对称**，
胜率高恰恰是它的伪装。

这是口径不对称的第二处（第一处即 2.1）。因此 `maxPrice` 定为**全局基础参数**而非某档的可选项。

### 2.3 其它可复用的生产实测数字

- `alertConditions.ts:36`：同一钱包在同一市场重复触发 = 全部推送的 **14.2%**（故有 30min 冷却）
- `signalFeed.ts:6`：notional < $25k 占全部告警的 **69%**（噪音基线）
- `earlyWinner.ts:30`：早期赢家判据 = 在 **≤40¢** 且距结算 **≥24h** 时押中赢家

---

## 3. 决策汇总

| #   | 决策                     | 选择                                                 |
| --- | ------------------------ | ---------------------------------------------------- |
| D1  | 路线                     | 信号源优先（先答「哪类信号有 alpha」）               |
| D2  | 范围                     | 全部 12 档一次做完 + `FollowCandidate` 架构层        |
| D3  | 吸筹（accumulate）族     | **不做**                                             |
| D4  | 价格上限                 | 全局基础参数 `maxPrice=0.95`，对齐 `alertConditions` |
| D5  | C1 的 `formationTs` 语义 | **倾斜形成时刻**（`tiltPct` 首次跨过 0.7 那一刻）    |
| D6  | B/D 族是否受分歧互斥约束 | **不受**                                             |
| D7  | 档位重叠的展示处理       | 只加一句口径声明（不算重叠度矩阵）                   |
| D8  | C2「分歧解除」判据       | **少数边开始净卖**                                   |

---

## 4. 架构：信号检测与开仓解耦

### 4.1 核心契约 `FollowCandidate`

所有信号源产出同一个结构，开仓逻辑只认它、不知道信号从哪来。

```ts
export type FollowSourceKind =
  | "consensus" // 族 A
  | "heavy" // 族 B
  | "lopsided" // C1
  | "resolved" // C2 分歧解除
  | "lone_wolf" // D1
  | "early_winner"; // D2

export interface FollowCandidate {
  // —— 身份(开什么仓)
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  asset: string;
  title: string;
  slug: string;
  eventSlug: string;
  // —— 时机:信号成立时刻。三个用途:新鲜度闸门 / 护栏基准取价 / markout 锚点
  formationTs: number;
  // —— 成本基准:聪明钱的成本。护栏基准 + positionSlippage 的减数
  referencePrice: number;
  // —— 归因(仅日志与展示,不参与任何开仓判定)
  sourceKind: FollowSourceKind;
  walletCount: number;
  totalNetUsd: number;
}
```

`referencePrice` 是整个设计能成立的关键抽象。三个源的来源各不相同 ——
consensus 用多钱包加权 `avgBuyPrice`、heavy 用那一笔的 `price`、lopsided 用主导边的加权均价 ——
但它们在跟单语义上是同一个东西：**聪明钱的成本基准**。
统一成一个字段后，`positionSlippage`（`follow.ts:46`）与进场偏离护栏（`follow.ts:401`）
**一行都不用改**，直接对 12 档生效。这是复用现有接口，不是为新信号源创造新接口。

### 4.2 Detector 注册表

```ts
type Detector = (trades, smart, params, ctx) => FollowCandidate[]
const DETECTORS: Record<FollowSourceKind, Detector> = { consensus, heavy, ... }
```

`runFollowCycle` 里 `follow.ts:263-296` 那段 `detectConsensus` 硬编码，改为按 `strategy.source` 查表分派。
**新增信号源 = 写一个纯函数 + 注册一行，开仓代码零改动。**

理由：`follow.ts:345-479` 的开仓循环里有护栏、查重、协议费入账、执行层建模等
一堆已经调试稳定的逻辑，每加一个信号源都去动它，等于每次都冒回归风险。

### 4.3 逐源的 `formationTs` 语义

`formationTs` 同时承担三件事（新鲜度闸门 / 护栏基准取价 / markout 锚点），任一源定错这三件事一起失效。

| 源                       | `formationTs` 取值                                    | 状态                                                          |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------- |
| consensus                | `g.formationTs`（第 N 个合格钱包跨线时刻）            | 现成                                                          |
| heavy                    | 那一笔成交的 `t.timestamp`                            | 单笔信号，天然精确                                            |
| lone_wolf / early_winner | 该钱包净买**跨过门槛**的时刻                          | 新写，借鉴 `ConsensusWallet.qualifiedTs`（`consensus.ts:27`） |
| lopsided / resolved      | **`tiltPct` 首次跨过 `lopsidedTiltPct` 的时刻**（D5） | 新写，需给 `DisagreementSide` 补字段                          |

**lopsided 这一格是必须小心的坑。** `DisagreementMarket` 目前只有市场级的 `firstTs`/`lastTs`
（`disagreement.ts:36`），而 `lastTs` 正是 `follow.ts:139` 长注释里明确警告过的东西：

> lastTs 被组内任何白名单成交（含 SELL、含不达标非成员）刷新，5 小时前形成的老共识
> 会被一笔 $2k 卖单"续命"成新鲜，按现价跟入 → 买入成本失控

C1 若直接拿 `lastTs` 当 `formationTs`，等于把一个已经付出代价修掉的 bug 从后门重新引进来。

选 D5（倾斜形成时刻）而非「本边成立时刻」的实际后果：
一个 10:00 就有 $50k 站住的多数边，14:00 少数边撤了才变成 lopsided。

- 「本边成立时刻」→ `formationTs` = 10:00，14:00 检测到时已过 4 小时，**新鲜度闸门（900s）全部拦掉，C1 是空档**
- 「倾斜形成时刻」→ `formationTs` = 14:00，信号新鲜，正常开仓

代价是要按时序重放两边的累计质量权重。C2 直接复用同一套重放。

---

## 5. `params_json` schema（向后兼容，零迁移）

```jsonc
{
  // ===== 通用基础:全部 12 档都有 =====
  "source": "consensus", // 新增。缺失 → "consensus" ⇒ 既有两条策略零改动
  "sizeUsd": 500,
  "exitRule": "settlement",
  "maxEntryDeviationCents": 10,
  "maxPrice": 0.95, // 新增(D4)。对齐 alertConditions 同口径
  "freshSec": 900, // 从 FollowCycleDeps 全局参数下放到每策略

  // ===== source=consensus 专属 =====
  "minWallets": 3,
  "minPerWalletUsd": 10000,
  // A3/A4 的门槛:不设该门槛时【整个 key 省略】,不要写 null。
  // 解析层的 numOr 对「字段缺失」与「显式 null」一视同仁,写 null 不表达任何
  // 额外语义,只会让种子数据带上一个类型上已不存在的形态(Task 3 已把
  // StrategyParams 的这两个字段统一成 `?: number`)。
  "minWalletScore": 80, // A3
  "minTotalNetUsd": 100000, // A4

  // ===== source=heavy 专属 =====
  "minSingleFillUsd": 50000,
  "minWalletScore": 80, // B3 复用同一字段名

  // ===== source=lopsided / resolved 专属 =====
  "minTiltPct": 0.7,
  "minPerSideUsd": 5000,

  // ===== source=lone_wolf / early_winner 专属 =====
  "minWalletScore": 90,
  "minNetUsd": 10000,
}
```

沿用 `parseStrategy`（`follow.ts:153`）的现有纪律：字段缺失/非有限数 →
**跳过该策略并留日志**，绝不静默开脏仓。未知 `source` 同样跳过。

`maxPrice` 拦的是 **`entry`（我们的实际入场价）**，不是 `referencePrice` ——
清扫仓的问题是「**我们**买在 0.97」，不是「聪明钱买在 0.97」。边界用严格 `>`，即 0.95 可开。

---

## 6. 12 档参数表

| #   | 名称         | source       | 关键参数                       | 这一档在回答                 |
| --- | ------------ | ------------ | ------------------------------ | ---------------------------- |
| A1  | 保守（现有） | consensus    | 3 钱包 × $10k                  | 基线                         |
| A2  | 激进（现有） | consensus    | 2 钱包 × $5k                   | 基线                         |
| A3  | 精英共识     | consensus    | 2 × $5k + `score≥80`           | 2 个顶级钱包 vs 3 个普通钱包 |
| A4  | 重仓共识     | consensus    | 2 × $5k + 总额 ≥$100k          | 人多重要还是钱多重要         |
| A5  | 首发共识     | consensus    | 3 × $10k + `freshSec:300`      | 抢 5 分钟值多少钱            |
| B1  | 巨鲸         | heavy        | 单笔 ≥$50k                     | **补上「推了不跟」**         |
| B2  | 超级巨鲸     | heavy        | 单笔 ≥$150k                    | 金额门槛的边际收益           |
| B3  | 巨鲸精英     | heavy        | ≥$50k + `score≥80`             | 金额 × 质量交叉              |
| C1  | 一边倒分歧   | lopsided     | `tilt≥0.7`                     | 被静默丢弃的信号池           |
| C2  | 分歧解除     | resolved     | 少数边转净卖（D8）             | 有人认输的那一刻             |
| D1  | 高分独狼     | lone_wolf    | `score≥90` + 净买 ≥$10k        | 一个人说了算吗               |
| D2  | 早期赢家跟投 | early_winner | `early_winner` 渠道钱包 + ≥$5k | 与 `score` 正交的筛选轴      |

A3/A4/A5 的数据**全都已经算出来了**，只差一个门槛判断：
`ConsensusWallet.score`（`consensus.ts:23`）、`ConsensusGroup.totalNetUsd` 都在结构里躺着，
`detectConsensus` 从没拿它们做过门槛。

D2 的钱包来源：`wallet_candidates` 表（`db.ts:18`）的 `channel = 'early_winner'`。

---

## 7. 分歧互斥的重新划分

现在 `excludeContestedFromConsensus`（`marketSignals.ts:26`）用 `conditionId` 做 Set，
一刀切掉**所有**争议市场。改造后按 source 分治：

| 市场状态                           | 谁跟                                             |
| ---------------------------------- | ------------------------------------------------ |
| 无争议                             | 只有 A 族                                        |
| 争议 + `tilt ≥ 0.7`（一边倒）      | 只有 C1                                          |
| 争议 + `tilt < 0.7`（真·势均力敌） | **谁都不跟** —— 这才是「只跟共识不跟分歧」的原义 |

A 族与 C1 正好把市场空间划成**互补且不重叠**的两块，副产品是**这两族的战绩可以直接相加**
（12 档里绝大多数两两之间做不到，见 §9）。

它也说明了一件事：现在被 `excludeContested` 扔掉的市场里，一边倒的那部分从来不是
「没有共识」，只是**共识里混进了零星反对票**。产品语义写的是「只跟共识不跟分歧」，
实现却是「沾了分歧就整个不跟」—— C1 补的正是这两者之间的缝。

**B/D 族不受分歧互斥约束（D6）。** `heavy` 的语义是「这一笔单本身就是信号」，
不依赖别的聪明钱怎么想；因为市场有争议就不跟，等于用 consensus 的世界观去审查 heavy，
还会让 B 族只在无争议市场取样（样本系统性偏置）。
此项与 `follow.ts:268` 注释的既有表述有张力，已确认按 D6 执行。

---

## 8. 请求量与轮内缓存

12 档 × 每个候选 3 次外部调用（`fetchPrice` / `fetchFormationPrice` / `fetchBook`），
且现在**跨策略零共享** —— 一个热门市场被 8 条策略命中就是 8 次参数完全相同的 `fetchPrice`。

解法：复用 `createPromiseCache`（`promiseCache.ts:6`）。它缓存的是 **Promise 而非值**，
即使 8 条策略在串行 await 循环里先后走到，第一个发起后其余 7 个直接拿到同一个 in-flight promise。

- key：`price:${asset}:${nowSec}` / `fprice:${asset}:${formationTs}` / `book:${asset}`
- **每轮 new 一个实例**，而非设时间 TTL —— 语义最干净：轮内共享、轮间必须重取。
  设 TTL 反而要论证「多久算新鲜」，是在给自己造一个不需要的问题。

---

## 9. 已知限制

### 9.1 档位持仓必然重叠，战绩不可跨档相加

同一个 `(conditionId, outcome)` 会被多个源同时命中（一个市场既有共识又有 $50k 巨鲸单是常态）。
现有 `UNIQUE(strategy_id, condition_id, outcome)` 只防同策略重复，**跨策略必然重叠**：
A2 的持仓是 A1 的超集、B3 是 B1 的子集、A3/A4 与 A1/A2 大面积重叠。

这是**期望行为** —— 跟单不该继承 `foldHeavy` 的抑制规则（`signalFeed.ts:255`）。
那条抑制是**展示逻辑**（一个市场不占两张卡），跟单要的是**归因逻辑**：
只有让 B1 和 A1 在同一市场各开各的仓，才能对比「共识 vs 单笔巨鲸谁更准」；
抑制掉就等于让 heavy 只在 consensus 失败的市场里取样。

按 D7，展示层只加一句口径声明：**每一档的战绩是独立假设下的，不可跨档相加**。
不算重叠度矩阵。`computeAccountPlan` 的「建议跟单额度」（`follow.ts:964`）同理 ——
单档数字是对的，12 档的总资金需求不是 12 个峰值之和。

### 9.2 伪独立性

12 档看起来是 12 份独立证据，实际上高度相关（同上）。
挑「战绩最好的那一档」等于在相关样本上做选择，是标准的过拟合流程。
现有的 Wilson 区间小样本标注（`follow.ts:680`）继续沿用，但它只覆盖单档内的胜率不确定性，
**不覆盖跨档挑选带来的偏差**。

### 9.3 本批不做的

- **退出规则**：`exitRule` 仍是死字段，12 档全部 `settlement`。
  已采集的 `markout_30m`/`markout_2h` 继续只做归因。
- **对照组**：随机选边 / 反向跟单 / 随机时点，本批不做。
  在此之前，任何一档的绝对收益都无法区分「策略 alpha」与「市场本身」。
- **吸筹族**（D3）。
- **价格带专项档位**：`maxPrice=0.95` 是全局下限保护，
  但「长尾 ≤35¢」与「高确定 ≥65¢」的专项归因档本批不开。

---

## 10. 测试计划

沿用现有 TDD 文化（当前 625 测试）。

1. **每个 detector 一套纯函数测试** — 正例 / 差一点的反例 / `formationTs` 语义 /
   `referencePrice` 口径 / MM 钱包剔除（对齐 `consensus`、`disagreement` 的既有纪律）
2. **`FollowCandidate` 契约测试** — 六个 detector 产出的结构字段完整、类型一致
3. **向后兼容测试（最重要）** — 无 `source` 字段的旧 `params_json` 必须与改造前
   **逐字节同行为**，保证现有两条策略战绩不断档
4. **价格上限边界** — `entry=0.96` 跳过 / `entry=0.95` 开仓
5. **分歧分治矩阵** — 无争议→A 跟 C1 不跟；争议+tilt≥0.7→C1 跟 A 不跟；
   争议+tilt<0.7→都不跟；B/D 三种情况全照跟
6. **集成测试** — 12 档同时启用跑一轮，开仓数符合预期
7. **轮内缓存测试** — 同一 asset 被多策略命中时，`fetchPrice` 只被调用一次

---

## 11. 实施顺序

工程量与依赖决定的批次（同批内可并行）：

1. **架构层** — `FollowCandidate` 契约 + Detector 注册表 + `parseStrategy` 扩展
   - 轮内缓存 + 全局 `maxPrice`。含向后兼容测试。
2. **零新判据的档位** — A3 / A4 / A5（数据已在结构里，只差门槛）
3. **heavy 族** — 新写 `detectHeavyCandidates`，B1 / B2 / B3
4. **分歧族** — 给 `DisagreementSide` 补 `formationTs`（时序重放）→ C1 → C2（新落
   `market_tilt_history` 表 + 少数边净卖判据）
5. **钱包画像族** — D1（`qualifiedTs` 借鉴）/ D2（join `wallet_candidates`）
6. **展示层** — 12 档分族呈现 + 口径声明
