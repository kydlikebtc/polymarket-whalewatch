# X 推文文案 v2：填满 280 折叠位（传播性 × 吸引度 × 信息有效性）

日期：2026-08-19
状态：已获批准（五类样例逐条确认 + 四个拍板点均选推荐项）
背景：授权账号已是蓝V。蓝V提升的是**可发布长度**（25k 字符），不改变**时间线折叠位**
（≈280 加权字符，超出折进 "Show more"）。实测现有模板只用了 148~~189 字符——280 的
额度里空着 91~~132 个加权字符，而 TG 推送已有的高价值字段（钱包回执、时间集中度、
两边资金对比）在 X 侧全部缺席。X 按条计费（$0.015/条无链接），**加长免费**。

## 1. 决策记录

| 决策点         | 结论                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| 折叠预算       | 硬守 ≤280 加权字符，绝不折叠；把空额填满                                |
| 共识帖预算投向 | 凭证（逐钱包回执）+ 时间集中度；追价成本线留第二期                      |
| 回执样式       | **胜率版** `🏆 $12.5K @ 64¢ · 74% win rate`（地址版否决：普通读者无感） |
| 加密标签       | ENTITY_TAGS 五个币种改 cashtag：`$BTC $ETH $SOL $XRP $DOGE`             |
| 承诺行         | `Result posted at settlement — win or lose.` 按诚实闸门加（见 §4）      |
| 战报帖         | 一并改版（quote-tweet 价值最高的一类）                                  |
| 语言           | 维持纯英文（沿用 2026-08-16 设计：X 全球受众，TG 服务中文）             |
| 否决项         | `Fade or follow?` 类提问结尾——与只读研究工具定位相抵，招社区注释        |

## 2. 机制底座（三处，所有模板共用）

1. **`weightedLength(s)`**：X 加权口径的唯一实现。拉丁区段
   （U+0000–U+10FF、U+2000–U+200D、U+2010–U+201F、U+2032–U+2037）计 1，
   其余（emoji、`└`、`…`、`⏱` 等）计 **2**。现有 `[...s].length` 数码点，每帖
   实际比代码以为的多 3~5 字符——填满额度后这个差值就是折叠事故。
2. **`X_POST_MAX_CHARS = 280` 语义改注**：从「API 上限」改为「时间线折叠位」。
   蓝V下超发不再吃 400，失败模式变成静默折叠——没有 API 兜底，必须自己算准。
   闸门保留：/manage 可切换授权账号，切到非蓝V时它又是真正的 API 硬限。
3. **降级阶梯 `fitPost`**：现状「超限只砍标题」反转为
   **先按优先级丢可选事实行 → 全丢仍超限 → 才截标题**。
   市场标题是读者判断「这事关不关我」的唯一依据，最后才动。

## 3. 五类模板定稿（字符数均为实测加权值）

### ① 大单·匿名（`type='large'`）

抬头从类目标签改**断言式**：`says {outcome}` 对任意 outcome 语法成立
（says YES / says Lakers），是一句有立场的人话——quote-tweet 的饵。
BUY→`says`，SELL→`sells`（卖出≠看反，不硬造方向）。outcome+价格并入首行，
通知预览一行读完整个信号。

```
🐳 WHALE: $200K says NO @ 80¢                                   [152/280]

Will Bitcoin dip to $45,000 by December 31, 2026?

📊 94% of 24h vol · 💧 $186K liq · ⏳ 136d to settle

#Polymarket $BTC
```

占比 ≥100%（沿用 IMPACT_HEADLINE_PCT）时升级抬头：
`🚨 WHALE: $300K says YES @ 58¢ — more than this market's entire 24h volume`，
佐证行去掉占比项（不重复）。[213/280 含承诺行]

### ② 大单·聪明钱（`type='smart'`，找回被丢掉的差异化）

现状 `xBroadcast.parseCandidate` 把 `smart`/`large` 合并成同一个 `kind:"whale"`——
「$200K 来自胜率 74% 的钱包」和「$200K 来自查无此人的钱包」被讲成同一句话。
改为：`type='smart'` 时经 `getSmartTags(db, [proxyWallet])` 本地查凭证
（与已有 `readEventCategories` 同款纯本地 SQLite，零上游请求；`'large'` 不查——
当初就没被判定为聪明钱，此刻再查会前后不一致）。

```
🏆 SMART MONEY: $85K says Lakers @ 61¢                          [223/280]

Lakers vs Celtics — NBA Finals Game 5 Winner

Track record: 74% win rate · +$1.2M PnL
📊 31% of 24h vol · ⏳ 9h to settle

Result posted at settlement — win or lose.

#Polymarket #NBA
```

Track record 行按已有零占位哲学：null 段省略，全 null 整行不出。
负 PnL 照实输出（"Just the record."）。

### ③ 共识（旗舰）

品牌抬头保持 `🔥 SMART-MONEY CONSENSUS`（识别度即品牌）；叙事下沉到 `└` 行
一句讲完（钱包数+方向+均价+总额+时间集中度）；正文主体是**逐钱包回执**——
截图传播的主体，别家给不出。数据全在 payload（`wallets[].netUsd/avgBuyPrice/
winRate`、`firstTs/lastTs`），零新增查询。

```
🔥 SMART-MONEY CONSENSUS                                        [256/280]

LoL: Nongshim Red Force vs DN SOOPers - Game 2 Winner
└ 2 top-PnL wallets → Nongshim Red Force @ 49¢ avg · $33.9K within 14 min

🏆 $12.5K @ 64¢ · 74% win rate
🏆 $9.6K @ 45¢ · 57% win rate

#Polymarket #Esports #LeagueOfLegends
```

- 回执取 netUsd 降序前 3；`winRate` null 的段省略。
- `within X min` 仅当窗口 ≤60 分钟才输出（超过就不稀奇，删句以保诚实）。
- 降级阶梯：丢金额最小的回执行 → 回执坍缩成聚合行
  `🏆 Win rates: 81% · 74% · 57%`（Fed 96 字符长标题实测 239/280）→ 截标题。
- 明确不放：钱包 PnL（装不下，且小 PnL 反削弱说服力）、`last fill Xm ago`
  （X 播报 ≤60s 一轮，发帖时刻≈最后一笔时刻，废字符）。

### ④ 赛前

修掉 `1 smart-money signals` 单复数 bug；`buyUsdByOutcome` 存了两边却只输出
`Leaning` 一边——两边的钱升为抬头故事，**三种局面三种讲法**：

| 局面     | 抬头                                                       | 实测    |
| -------- | ---------------------------------------------------------- | ------- |
| 比例 ≥2  | `⏰ SETTLES IN 3H — smart money is 7-to-1 on Lakers`       | 161/280 |
| 对面为 0 | `⏰ SETTLES IN 6H — every signal is on Nongshim Red Force` | 223/280 |
| 比例 <2  | `⏰ SETTLES IN 2H — smart money is SPLIT on this one`      | 171/280 |

事实行：`📡 7 signals in 24h · $310K on Lakers vs $42K on Celtics`
（一边倒时 `all $13.1K on one side`，不输出尴尬的 `vs $0`）。
分歧本身也是好故事——旧模板会把它硬讲成 "Leaning"。

### ⑤ 战报（self-reply）

回报率提进抬头（被 quote 的就是这行）；**输的帖子才带立场行**——赢时自夸+表态
是油，输时表态是全场最硬的信任证明（不对称是刻意的）：

```
✅ CALLED IT · 40¢ → $1.00 (+150%)                              [138/280]

Baltimore Orioles vs. Tampa Bay Rays
└ Consensus signal on Orioles — settled today

#Polymarket #MLB
```

```
❌ MISSED · 62¢ → $0                                            [138/280]

Chiefs vs Bills
└ Whale signal on Chiefs — settled today

We post every result, wins and losses.

#Polymarket #NFL
```

SELL 战报沿用现有「只给两个可核对价格、不编回报率」的口径。

## 4. 承诺行的诚实闸门

`Result posted at settlement — win or lose.` 是开放式悬念（最强关注驱动），
但只能在**兑现得了**的帖子上印。两个闸门同时满足才渲染：

1. `hoursToEnd ≤ 144h`（6 天）——`lib/xSettled.ts` 只补发 **7 天内**的原帖
   （`SETTLED_MAX_AGE_SEC`），136 天后结算的市场写了就是可被抓包的空头支票。
   闸门取 144h 是给结算延迟留 1 天缓冲。共识 payload 无 `hoursToEnd`，
   共识帖**不印**（回执已占满预算，不冲突）。
2. `kinds.settled` 开关为开——settled 功能被运营者关掉时承诺落空，不印。
   （运维备忘：上线时在 /manage 打开 settled 开关，否则该行永不出现。）

配额延迟不破坏承诺：settled 的 quota 拒绝不落 skipped、次日重试，
7 天窗口内最终兑现。

## 5. 测试

- `weightedLength`：emoji=2 / `└`=2 / `¢`=1 / `·`=1 / 混排钉死。
- 每模板：满配快照 / 字段缺失降级 / 长标题触发分级降级
  （断言**标题未被截**且回执先坍缩）/ ≤280 加权 + 除周报外无 URL 两条硬不变量。
- `xBroadcast`：`type='smart'` 走凭证分支且查 `getSmartTags`，
  `type='large'` 不查；承诺行双闸门（144h × kinds.settled）四象限。
- 赛前三种局面 + 单复数；战报赢/输不对称立场行。
- cashtag：`$BTC` 计入标签行且不破坏去重。

## 6. 非目标（第二期候选）

- 追价成本线（`now 64¢ · +15¢ past entry`）：需改 `lib/consensus.ts` 把
  `latestPrice` 落进 payload + 告警年龄闸门（>2min 不渲染，防宕机补发时
  拿 30 分钟前的价当「现价」）。信息价值最高的单行，值得做，但不在本批。
- 共识 payload 补 `hoursToEnd`（让共识帖也能印承诺行）。
- 周报帖不动（带链接、职责不同）。
