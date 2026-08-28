# 第二梯队八件套设计 —— 价格影响 · 时光机 · 离场 · 指纹 · 名人堂 · 反指 · 无鲸 · 洗量

> 日期：2026-08-28
> 来源：[第三轮脑暴](2026-08-28-iteration-brainstorm-round3.md) 第二梯队全部八条
> （#1/#11/#4/#5/#7/#8/#2/#14），用户裁决「做完」。五件套（同日已合并上线）
> 的成本红线延续：**六件零新增上游**；仅两处有界例外——#1 每告警多一次
> 不可变历史价（回填循环既有 500 条/轮预算内滴灌），#11 每市场按需一次
> 曲线拉取（点击触发 + promise 缓存，绝不随卡片自动加载）。
> 存储增量：`market_daily` 两列 + `alert_outcomes` 一列，其余全部读取侧现算。

## 统一约束

1. 统计纪律沿用现役机器：逐行贡献 `(won?1:0) − q − feePerShare`、聚簇
   CRVE（`clusterStat`）、多重比较用「披露检验数」页脚（记分卡先例），
   不新发明第二套口径。
2. 组类 payload 字段学与 ConsensusGroup 对齐（cohort 先例）；additive 键 +
   catch 兜底同形（/api/discovery 与 /api/consensus 的既有纪律）。
3. `/api/pulse` 是对外文档化端点，新增键须同步 `api-access.md` §13/§16；
   `/api/consensus`、`/api/wallet`、市场复盘路由是站内路由，不进对外文档。
4. i18n 双闸照常；`lib/` 中文常量在页面侧逐键 `t()` 写死（scorecardLabel 先例）。

## 一、无鲸异动 · 日频版（#2）+ 洗量检测 · 窗口版（#14）—— 共享 market_daily 底座

**加列**（`market_daily`，循环 ALTER 样板 + CREATE 同步 + `MarketDayRow`/
`marketPulse.DailyRow` 类型）：

- `wash_usd REAL` —— 同钱包同市场当日「往返配对量」：逐钱包
  `min(buyUsd, sellUsd)` 之和（一腿口径；两腿都计入 volume_usd，故
  `wash_ratio = 2·wash_usd / volume_usd` 才是「洗量占比」——展示层换算，
  列里存一腿原始值）。聚合器把 `wallets: Set` 旁挂一个
  `Map<lower(wallet), {buyUsd, sellUsd}>`；`wallet_count` 语义不动。
- `max_fill_usd REAL` —— 当日单笔最大名义额。无鲸判定的精确材料
  （`whale_usd=0` 只说明没有 ≥$50k 桶，挡不住 $30k 单）。

**无鲸异动**：`buildPulse` 追加 additive 键 `ghosts: GhostRow[]` ——
当日 `volume ≥ $10k`、`|price_last−price_first| ≥ 10¢`、
`max_fill_usd < $10k`（且非 null，老行不进榜）的市场，按价移降序。
语义：价格大动却没有任何大单付账 = 薄簿或蚂蚁搬家。

**洗量**：`buildPulse` 每行 `PulseMarket` 追加 `washRatio: number|null`
（老行 null），另加 additive 键 `washTop: WashRow[]`（`wash_ratio ≥ 20%`
且 `volume ≥ $10k`，比率降序）。定位是市场风险事实（cover 承保输入的
前身），文案不做指控措辞——「往返配对量」是结构描述。

**展示**：/pulse 第四、五 section + 日榜行洗量 chip；口径脚注扩两句。
**对外**：api-access §13 `/api/pulse` 补 `ghosts`/`washTop`/`washRatio`
字段说明 + §16 变更行。老日份三个新字段全 null——additive 纪律 + 文档声明。

## 二、价格影响持久性（#1）—— 「被市场相信程度」

**采集**：`alert_outcomes` 加 `price_10m REAL`（CREATE + ALTER）。
`computeAlertOutcomes` marks 加 `[600,"10m"]`（每告警上游预算 2→3 次，
`outcomeBackfill.ts` 注释与 `/api/alert-outcomes` 注释同步）；
`CANDIDATE_WHERE` 加 `OR ao.price_10m IS NULL`——历史已终态行借既有
500 条/轮预算滴灌回填（价格不可变，一次到位）。

**统计**：`summarizeOutcomes` 增 `dir10m`（/alerts 验证条三档变四档）。

**钱包级**：新模块 `lib/priceImpact.ts`。
`walletPriceImpact(db, address, {nowSec})`：90 天窗内该钱包的已评级告警
（smart/large 按 `proxyWallet`；consensus 成员展开，p0 用成员自己的
`avgBuyPrice`——记分卡同款），逐行方向化位移
`m_h = sign·(p_h − p0)`；「初动可测」= `|m_10m| ≥ 2¢`；
「留存」= `m_24h ≥ 0.5·m_10m`。产出留存率 ± 聚簇区间（按市场）、
中位初动/24h 位移（¢）、四态 verdict：`followed`（区间下界 > 0.5 显著
被跟随）/`faded`（上界 < 0.5）/`mixed`/`insufficient`（市场数 < 8）。
**展示**：钱包档案新块「📡 价格影响」（`/api/wallet` payload additive
`impact` 键，纯本地零上游，降级路径同样可算）。

**红线**：这是「市场对他的反应」的描述统计，不是策略信号；verdict 文案
不出现任何跟单措辞。

## 三、聪明钱离场 · 卖侧窗口版（#4）

新模块 `lib/smartExit.ts`：`detectSmartExits(trades, smartTags, opts)` ——
镜像 consensus 会计但取卖侧：逐钱包
`soldExposure = max(0, sellShares−buyShares) × avgSellPrice`，
≥ `minPerWalletUsd` 计一票；同 (market, outcome) ≥ `minWallets` 个
池内非 MM 钱包 → ExitGroup（字段学对齐 ConsensusGroup，`totalSoldUsd`）。
**窗口局限如实声明**：窗内只见卖不见此前建仓——「减持老仓」正是要抓的
事实，但无法区分获利了结与止损，页面口径写明。

**接线**：`/api/consensus` payload 追加 `exits` 键（catch 兜底同形补
`exits: []`），复用路由现有 `minWallets/minPerWalletUsd` 参数与共享窗口
（双侧抓取已含 SELL）；`/consensus` 页 `View` 联合加 `"exits"`、
Segmented 第三项「📤 离场」、新 section 表格。零 worker 改动、零告警类型。

## 四、行为指纹 · 限池内（#5）

新模块 `lib/walletFingerprint.ts`，**可解释规则型标签，拒绝黑盒聚类**：

- `buildPoolStyles(db, {nowSec})`：一趟扫 90 天 `alerts`（large/smart 按
  `proxyWallet` 归户；consensus 成员计次不计风格轴——组 payload 无
  side/marketCtx），只保留池内地址；每钱包特征：中位入场价、中位单笔
  名义额、SELL 占比、中位距结算小时（`marketCtx.hoursToEnd`，缺失剔除）、
  告警数。样本 ≥5 才给风格。
- 标签轴（阈值写死并注释）：赔率带 🎯冷门猎手(≤35¢)/⚖️中盘(35-65¢)/
  🛡️热门守卫(≥65¢)；时钟 ⏱️临场(≤6h)/📅隔日(≤48h)/🗓️长线(>48h)；
  规模 🔨重锤(中位 ≥$50k)；方向 ↔️双向(SELL ≥30%)。
- `similarWallets(styles, address, k=3)`：z 分数特征向量（价/log 额/
  时钟/胜率）欧氏距离，池内最近邻。

**展示**：/discovery 成员行标签链追加风格标签；钱包档案新块
「🧬 交易风格」（`/api/wallet` additive `style` 键：标签 + 相似钱包
`WalletLink` 列表；池外钱包为 null 整块省略）。promise 缓存 10 分钟。

## 五、鲸鱼名人堂 + 反指名单（#7+#8）—— /discovery 第四 tab

**底座扩展**：`loadScorecardRows` 的 SQL 加 `a.id, a.created_at`，
`ScorecardRow` 追加 `alertId/createdAt/title`（additive，既有分组零影响）；
`groupOf` 加 `export`（记分卡测试不动）。

**新模块 `lib/walletLeague.ts`**：`buildWalletLeague(rows, styles?)` ——
按 `wallet` 分桶逐桶 `groupOf`（同一套 CRVE + 扣费 + `nc≥10` lowN 纪律），
每钱包附：最佳/最惨单行（`contrib` 极值行的 title/时间/贡献）、
`channel`（含 departed 离池桶）、MM 标记、风格标签、确定性代号
`codenameOf(address)`（形容词×动物哈希，零存储，纯趣味展示，地址仍是
第一标识）。输出两榜：

- **名人堂** `hall`：verdict=pos，净 edge 降序；
- **反指名单** `fade`：verdict=neg，净 edge 升序——逆势少数边(+38.9%)
  从孤例变一类的正式版。
  **多重比较披露**（记分卡先例）：页脚写明「共检验 {W} 个钱包（≥10 市场），
  区间未做 Bonferroni 校正——名单是研究线索，不是交易结论」。

**接线**：`DiscoveryView` + `league` 键；catch 兜底同形；页面 `View` 加
`"league"`、Segmented 第四项「👑 名人堂」、两段表格 + 披露脚注；
`rows` useMemo 分支链同步。

## 六、时光机 · 市场复盘（#11）

**路由** `app/api/market/[conditionId]/replay/route.ts`（站内，
`guardExpensive("market-replay", {perIp:30, global:120, cost:2})`）：

- 曲线：`fetchPriceSeries`（fidelity=10）拉 outcomeIndex 0 的 token
  （`MarketMeta.clobTokenIds`），promise 缓存 10 分钟按 cid；区间 =
  `[min(首告警−4h, now−48h), min(now, 结算后+2h)]`。
- 标记：本市场 90 天告警（marketCard 同款 LIKE+created_at 界查询,
  LIMIT 200）→ `{ts, type, side, price, usd}`；outcomeIndex 1 的价格按
  `1−p` 映到同一坐标（**二元市场精确等价**；多结果市场只画 index 0 并
  在页脚声明局限）。
- 结算：closed 时附 `resolutionPrice`（index 0 口径）。

**UI**：`MarketCardClient` 告警历史 section 之后新增「🕰 复盘」——
**点击「加载复盘」才 fetch**（曲线是本批唯一的按需上游，绝不随卡自动拉），
SVG 折线 + 分类型着色标记点 + 结算横线,复用 `computeTimeTicks`。

## 任务拆解（每任务一提交，TDD）

| 任务 | 内容                                                                      |
| ---- | ------------------------------------------------------------------------- |
| A    | market_daily 两列 + 聚合器逐钱包 Map（#14/#2 原料层）                     |
| B    | pulse 三 additive 键 + 两 section + chip + api-access 同步（#2/#14 完成） |
| C    | price_10m 全链（列/回填/统计/验证条）（#1 采集层）                        |
| D    | lib/priceImpact + /api/wallet impact 键 + 档案块（#1 完成）               |
| E    | lib/smartExit + /api/consensus exits 键 + 离场 tab（#4）                  |
| F    | lib/walletFingerprint + discovery 风格标签 + 档案风格块（#5）             |
| G    | 记分卡行扩展 + lib/walletLeague + 名人堂 tab（#7/#8）                     |
| H    | 复盘路由 + 市场页复盘 section（#11）                                      |
| I    | CHANGELOG + 双语 README roadmap + 索引/文档守卫收尾                       |

基线：1922 tests / 148 files（86da532）。每任务 `npm test` 全绿 +
`npm run typecheck` 干净。

## 实现期修正（同日）

- **价格影响的可测口径收紧**：设计稿「|m_10m| ≥ 2¢」改为「m_10m ≥ +2¢」——
  负初动（落地即被打回）的「留存」问题不适定，计入会把分母灌水。
- **离场组字段**：`totalSoldUsd`/`avgSellPrice` 命名落地（设计稿写意为
  ExitGroup），页面表格含钱包内联前三。
- 全批落地：1922 → 1958 测试 / 153 文件，typecheck 零错，设计 + A–H + 收尾
  共十个提交；`/pulse` 的三个 additive 键同步进 api-access §13/§16（Task B 内完成）。
