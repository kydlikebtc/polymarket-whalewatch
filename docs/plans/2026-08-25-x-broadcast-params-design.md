# X 播报参数后台化 —— 设计（2026-08-25，同日追加三批扩展）

> 首批：数字参数后台化。实施中运营者追加：② 日/周/月花费上限三档；③ 巨鲸 🚨
> 警报级分档线；④ 五类内容的文案模板可配置；⑤ 播报历史的天 × UTC 小时 × 类型
> 时间分布。全部并入本设计（见文末「追加扩展」）。

## 动机

/manage 的「播报内容类型」区能开关五类内容，但每类内容的**数字参数**全是硬编码：
巨鲸日上限 20、赛前日上限 3、战报日上限 5 写死在 `lib/xQuota.DAILY_CAP`；赛前窗口
1-6h 写死在 `lib/xPregame`；周报发帖时刻 13:00 UTC 写死在 `lib/xWeekly`；月预算与
巨鲸金额阈值虽可配但只认 `.env`（改一次要重启容器）。运营者想「体育大日把巨鲸上限
临时提到 30」或「预算月中调低」，都得改代码或改 env 重启 —— 与「切换账号 ≤60s 生效
无需重启」的既有承诺不一致。

## 方案

复用 `x_broadcast_kinds` 的整套纪律，新增 config key **`x_broadcast_params`**：
JSON 一行、逐键校验、坏值回落默认、真实变更才写 config_history、引擎每轮重读
（≤60s 生效，无需重启）。

### 可配置项（与 /manage 卡片文案一一对应）

| 参数                          | 出厂默认                         | 语义                       |
| ----------------------------- | -------------------------------- | -------------------------- |
| `budgetUsd`                   | env `X_MONTHLY_BUDGET_USD`（15） | 月预算熔断，全类型共享     |
| `whaleMinTradeUsd`            | env `X_MIN_TRADE_USD`（50 000）  | 巨鲸单笔金额阈值           |
| `whaleDailyCap`               | 20（`DAILY_CAP.whale`）          | 巨鲸日上限                 |
| `consensusDailyCap`           | `null` = 不限                    | 共识日上限（可选设数）     |
| `pregameDailyCap`             | 3（`DAILY_CAP.pregame`）         | 赛前日上限                 |
| `pregameMinH` / `pregameMaxH` | 1 / 6                            | 赛前结算窗口（小时）       |
| `settledDailyCap`             | 5（`DAILY_CAP.settled`）         | 战报日上限                 |
| `weeklyUtcHour`               | 13                               | 周报周一发帖时刻（UTC 时） |

`budgetUsd` / `whaleMinTradeUsd` 的默认值**继续来自 env**（未在后台保存过的部署
行为不变）；后台保存过之后以库里的值为准 —— UI 明示这一优先级。

### 不做（刻意）

- **单价 $0.015 / $0.20**：X 平台计费事实。改它不会改变真实账单，只会腐蚀台账
  口径，平台侧 spending cap 也对不上号。
- **新鲜度窗口 / 单轮上限 / 承诺行闸门**（`X_POST_MAX_AGE_SEC`、`*_PER_CYCLE`、
  `SETTLE_PROMISE_MAX_H`）：内部机制，页面从未展示，运营者没有调它的场景。
- **日上限 = 0**：等价于类型开关，两个入口一个语义是配置陷阱；cap 最小 1，
  「不发」永远用开关表达。

### 校验（读写两侧同规）

写侧（route zod）与读侧（`getXBroadcastParams` 逐键防御）同一套规则：金额有限
正数；cap 为 ≥1 整数（consensus 允许 null）；`weeklyUtcHour` ∈ [0,23]；
`pregameMinH` ∈ [0,168] 且严格小于 `pregameMaxH`（倒挂时读侧双双回落默认，
写侧 400 拒绝）—— 坏配置绝不能毒化预算熔断（与 `parseUsdEnv` 同一姿态）。

### 线程化

各循环的 deps 增加**可选**数字参数（省略 = 出厂默认，既有测试与调用零破坏）：
`quotaDecision` 的 `QuotaInput` 增 `dailyCap?: number | null`（undefined=出厂、
null=不限、数字=上限）；`xBroadcast` 增 `whaleDailyCap`/`consensusDailyCap`；
`xPregame` 增 `dailyCap`/`minH`/`maxH`；`xSettled` 增 `dailyCap`；`xWeekly` 增
`postUtcHour`。引擎 xLoop 每轮 `getXBroadcastParams` 后显式传入。

### API 与 UI

`/api/admin/x-accounts`：GET 增 `params`（生效值）与 `defaults`（出厂值，含
env 派生），`budgetUsd` 字段改为生效值（播报历史头的 `$15` 从此如实）；POST 增
`action:"params"`（逐键可选合并，与 kinds 同款语义）。

/manage：每张类型卡片下加对应数字输入（巨鲸=日上限+金额阈值；共识=日上限空=
不限；赛前=日上限+窗口双端；周报=UTC 时刻；战报=日上限），区头加月预算输入与
「保存参数」按钮；卡片 hint 文案由生效参数动态生成 —— 页面不再说旧话。

## 测试

`lib/xParams.test.ts`（默认/回落/倒挂/坏 JSON/history 只记真实变更/旧行缺键），
`xQuota`/`xBroadcast`/`xPregame`/`xSettled`/`xWeekly` 各补 override 用例，
`app/api/admin/x-accounts/route.test.ts`（合并语义/400 路径/GET 生效值）。

## 追加扩展（同日，实施中运营者提出）

### ② 花费上限三档（日 / 周 / 月）

`quotaDecision` 在月度熔断之下增设两道细分闸：`dailySpendCapUsd` /
`weeklySpendCapUsd`（null = 不限，出厂即不限；月上限 `budgetUsd` 保持必填的
硬熔断）。三个窗口共用同一台账口径（claimed+posted）与同一条 SQL；周界 =
UTC 周一（复用 `followAnalysis.utcWeekStart`，与周报 dedup 同一口径）。

### ③ 巨鲸 🚨 分档线

`whaleSirenUsd`（出厂 `WHALE_SIREN_USD` = 250k）进参数：只影响文案抬头图标
（🐳→🚨），不影响任何闸门。

### ④ 文案模板（五类全量）

新 config key **`x_broadcast_templates`**（`lib/xTemplates`），每类一个模板，
空 = 内置英文文案。`{占位符}` 词表由 `xComposer.TEMPLATE_VOCAB` 单点定义，
值为预格式化片段，数据缺失渲染为空并自动收行。

两条硬不变量（280 加权字符 / 非 weekly 不得带链接）**不因模板放开**：

- 写侧（`validateXTemplate`）：未知占位符、`{title}` 不恰好一个（fitPost
  截断保护的锚点）、夹带 URL、底座样本渲染超 278 —— 全部 400 拒绝；
- 运行侧（`renderCustom`）：结构坏 / 渲染出 URL / 仍超 280 → 回退内置文案
  并照常发帖，模板永远只能影响「怎么说」，不能让帖子折叠、超支或哑火。

漂移守卫：composer 测试对每 kind 逐 token 断言「富输入下渲染非空」——
`renderTemplate` 对未知键静默置空，普通断言抓不到词表与 vars 的漂移。

### ⑤ 播报时间分布

`getXPostHistogram`（`lib/xSettings`）：近 14 天 × 24 UTC 小时 × kind 的
**posted** 计数（skipped/failed 是闸门与故障的事，混进分布只会糊图）。
/manage 播报历史区渲染为热力网格，悬停看类型明细，全零时整块隐藏。

### 实施后记

- route 的 params 合并从逐键手抄改成通用循环：加花费上限键时手抄白名单
  果然漏了（route 测试抓住），与 bus[] 投影漏字段是同一类病，根治之。
- 全量 127 文件 1678 测试通过；/manage 全链路（保存→落库→hint 联动→
  400 拒绝→分布网格）已在 dev 环境浏览器实测。
