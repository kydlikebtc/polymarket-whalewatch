# X 自动播报账号（获客渠道）设计

日期：2026-08-16
状态：已获批准
背景：获客脑暴选定的第一优先项。Whale Alert（@whale_alert）靠纯自动播报做到 100 万粉，
验证了「数据尾气 → 自动内容」是这个品类的获客天花板打法；Polymarket 垂直里尚无支配级
X 播报账号。本设计把 worker 已有的信号管线加一个 X publisher sink。

## 1. 目标与成功指标

把 worker 每天自动产生的独家信号（大单 / 共识分歧 / 赛前聚合 / 周报战绩）变成 X 上的
英文自动播报，作为主获客渠道。

- 成功指标（按月）：粉丝增量、bio 链接点击（UTM）、Telegram/网站转化。
- 预算硬约束：**$15/月**（X API 按量付费：无链接帖 $0.015/条、带链接帖 $0.20/条；
  ≈900 无链接帖 + 4-5 条带链接周报帖）。
- 语言：纯英文（用户已确认）。TG 频道继续服务中文用户，形成分工。

## 2. 前置条件（用户手工完成）

1. 创建 X 账号（handle 候选：`@PolyWhaleWatch` / `@WhaleWatchPoly`），
   bio 放网站链接 + "Research tool, not financial advice"。
2. developer.x.com 以 pay-per-use 注册应用、绑付款方式、**X 后台设 $15 spending cap**（平台侧兜底）。
3. 生成 OAuth 1.0a 凭据（consumer key/secret + access token/secret，Read & Write），
   四个值写入服务器 `.env`。

未配置凭据时功能整体静默关闭（与其他可选功能一致的 config 开关语义）。

## 3. 架构

沿用现有管线模式：一个 sink + 三个纯函数模块，X 侧失败绝不影响 TG 主链路。

| 模块                          | 职责                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/xComposer.ts`            | **纯函数**：信号对象 → 英文帖文（四类模板）。正文严禁 URL（避免 $0.20 链接计费），周报帖除外                                             |
| `lib/xQuota.ts`               | **纯函数 + DB**：月度成本台账、每日配额（$15/30 ≈ 28 帖/天）、优先级席位保留，超限 fail-closed                                           |
| `lib/xPublisher.ts`           | X API 客户端：POST /2/tweets + 周报图片上传。依赖 `twitter-api-v2`（唯一新依赖；备选手写 OAuth1 签名零依赖，但媒体上传分块易错，不采用） |
| `app/api/og/weekly/route.tsx` | Next 内置 `ImageResponse` 渲染周报成绩单 PNG，worker 自取自传，零新渲染依赖                                                              |
| DB 表 `x_posts`               | 幂等去重（复用告警 dedup 模式）+ 每帖成本记账 + 存 post id 备后续分析                                                                    |

接线点：

- `alertEngine` 在 Telegram 发送成功后**非阻塞**调用 X sink——X API 挂掉/预算耗尽只记
  日志告警，不影响 TG 主链路。
- 周报与赛前聚合是 worker 周期里两个带节流的新 tick（复用现有 cycle 模式）。

## 4. 内容与预算规则

- **大单播报**：单笔 ≥ `$50k`（env 可调），实时发。
- **共识/分歧**：全发（本身稀有），优先级最高。
- **赛前聚合**：距结算 6h→1h 窗口内、24h 交易量 top 的市场，自动汇总聪明钱站位，每日 ≤3 条。
- **周报成绩单**：每周一 1 条，图卡 + 网站链接（唯一带链接帖，$0.20/条）。
- 优先级 共识 > 赛前 > 大单；高优类每日保留席位，避免大单流把配额打光。
- 免责声明放 bio 不放帖内（对齐 Whale Alert 惯例）。

帖文样例：

```
🐳 $184K YES on "Chiefs win Super Bowl LX?" @ 67¢
12% of 24h vol · liquidity $229K · settles in 5h
```

```
🔥 CONSENSUS: 3 top-PnL wallets bought the SAME side of "Fed cut in Sept?"
within 40 min · combined $92K @ avg 61¢
```

## 5. 测试与度量

- TDD：composer/quota 纯函数单测全覆盖（模板快照 + 预算边界 + fail-closed 路径），
  publisher 以 mock fetch 集成测试；现有测试基线保持全绿。
- 度量：bio 链接带 `utm_source=x`；`x_posts` 留存 post id，互动数据拉取（读 $0.005/条）v2 再说。

## 6. v1 非目标

自动回复/互动、关注管理、双语、Discord bot、付费分层——全部留给后续批次。

## 7. 关键设计取舍备忘

- 配额器把「预算」当一等公民建模：本地台账 fail-closed + X 端 spending cap 双保险
  （按量付费 API 的「断更报警」同款思路——花钱的口子必须有本地熔断）。
- composer 纯函数化：四类模板全部行为可离线单测，与 detector 纯函数化的既有架构哲学同构。
- 不用 CDP 浏览器自动化发帖：违反 X ToS 有封号风险，且无法 7×24 服务器化；
  按量付费 $15/月 的官方 API 成本已足够低。
