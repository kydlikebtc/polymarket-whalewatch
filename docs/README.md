# docs/ 目录索引

本目录放三类东西，边界很清楚：

| 位置                              | 内容                                    | 读者                       | 会不会过时                       |
| --------------------------------- | --------------------------------------- | -------------------------- | -------------------------------- |
| `api-access.md`、`signals-api.md` | 对外接口文档（2 份）                    | 订阅方 / 接口维护者        | 不允许过时，与实现同步校准       |
| `README.md`（本文件）             | docs 目录索引                           | 找文档的人                 | 新增文档时需同步                 |
| `docs/plans/`                     | 设计文档与实现计划（34 份，按日期命名） | 想理解「为什么这么做」的人 | **刻意不更新**，是提案当时的快照 |
| `docs/*.png`、`docs/design/`      | 界面截图与高保真原型                    | README 配图 / 设计参考     | 会过时，各条目下已注明拍摄日期   |

`docs/plans/` 是**历史档案**，不是使用手册。每份文档记录的是「那一天决定这么做、以及为什么」，包括被否决的方案与踩过的坑。实现落地后代码会继续演进，文档不回填——想知道现在代码长什么样，读代码；想知道当初为什么选这条路，读这里。

命名规则：`YYYY-MM-DD-<主题>-design.md` 是设计文档（问题陈述、方案对比、口径裁决），`YYYY-MM-DD-<主题>-implementation.md` 或 `YYYY-MM-DD-<主题>.md` 是实现计划（逐任务 TDD 拆解、红线约束、测试基线）。多数主题只有设计文档一份。

---

## 对外文档

两份 API 文档分工明确，都在 `docs/` 根目录：

### `docs/api-access.md` — 面向订阅方的接入文档

站内 `/api-docs` 页面**运行时读取的就是这一份**（`app/api-docs/page.tsx` 用 `lib/markdownDoc.ts` 排版渲染，不复制一份到 JSX，避免文档与页面漂移）。因此它也是 Dockerfile 必须把 `docs/` 拷进运行镜像的原因。

内容是使用者视角的完整说明：端点表（`/api/signals`、`/api/record`、`/api/health`、webhook）、鉴权方式、逐字段量纲与类型定义、webhook 接收端的实现要求。文档自己声明了两条契约：

- **零上游调用** —— 全部字段来自本服务已持久化的状态，订阅方的请求不会挤占监控引擎的 Polymarket API 预算。
- **字段只增不改** —— 既有字段名与语义不变，新能力以新字段追加，消费方须按「忽略未知字段」解析。

运营者在 `/manage → 🔑 接入` 签发 key 后，把这份文档的 URL 一起发给订阅方。

### `docs/signals-api.md` — `GET /api/signals` 内部契约

读者是**维护这个接口的人**：记设计取舍、口径修订史、为什么这样折叠信号。同时钉死一条拓扑约束——「不要让 App 客户端直连本服务」，本服务是单机 Next + SQLite 的研究服务、限流是进程内 Map，消费方（mm-mobile 后端）每分钟拉一次并自行缓存 + 鉴权后转给 App。

**两份冲突时的规则（写在 signals-api.md 里）：字段语义以 `api-access.md` 为准，要改先改那份。**

| 文件                  | 定位     | 读者       | 首次提交   | 最近改动   |
| --------------------- | -------- | ---------- | ---------- | ---------- |
| `docs/api-access.md`  | 对外使用 | 订阅方     | 2026-08-17 | 2026-08-19 |
| `docs/signals-api.md` | 内部契约 | 接口维护者 | 2026-07-29 | 2026-08-19 |

---

## 设计文档索引

`docs/plans/` 共 **34 份**，按日期倒序。同一主题的 design + implementation 相邻。

| 日期       | 主题                                                                                     | 类型           | 一句话                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-27 | [新出口三件套](plans/2026-08-27-outlet-trio-design.md)                                   | design         | 零新数据换三个新出口：MCP server（stdio 走公开 API，与部署解耦）、可嵌入战绩卡/状态徽章（Route Handler 直出自包含 HTML）、公开 CSV 数据集（CC BY 4.0，分母与 /api/record 同口径）。    |
| 2026-08-27 | [产品迭代脑暴 · 第二轮](plans/2026-08-27-iteration-brainstorm-round2.md)                 | 脑暴快照       | 不受历史清单约束的 20 个方向（五个棱镜：新数据面/同库新问法/新形态分发/钱的新路径/引擎跃迁），含体量标记与「闸门无关」标注；用户裁决先做最高杠杆组与内容引擎组。                       |
| 2026-08-27 | [数据连续性 · 30 天起算时钟](plans/2026-08-27-continuity-clock-design.md)                | design         | 起算日由数据自己说话：用 cycle_metrics 逐轮实测时间戳重建 60 天覆盖/断档条带，20 分钟容忍与 /api/health 同一把尺、跨午夜断档双杀；新增公开端点 `/api/continuity` 与 /status 连续性区。 |
| 2026-08-27 | [信号名录 API](plans/2026-08-27-signal-catalog-api-design.md)                            | design         | 新增 `/api/signals/list`：按 ①原始/②策略两大类列出「这把 key 实际收得到什么」，全 ASCII 认档（`type`+`threshold` / `code`+`source`），内部异常返 `503` 而非空名录。                    |
| 2026-08-25 | [X 播报参数后台化](plans/2026-08-25-x-broadcast-params-design.md)                        | design         | 播报的日上限/金额阈值/赛前窗口/周报时刻/日周月花费上限/🚨 分档线全部改为 /manage 可配（≤60s 生效），并加五类文案模板（占位符+校验+回退内置）与播报时间分布热力图。                     |
| 2026-08-17 | [𝕏 多账号授权](plans/2026-08-17-x-multi-account-design.md)                               | design         | X 播报从 `.env` 单账号升级为 3-legged OAuth 1.0a：一个 App 服务多个授权账号，主账号发、其余备用，在 `/manage` 管理。                                                                   |
| 2026-08-17 | [统一信号总线](plans/2026-08-17-signal-bus-design.md)                                    | design         | 「可推送信号」原本只覆盖 19 档策略信号，本设计把全站至少 6 类信号统一纳入总线（投影而非重算），分两批实施。                                                                            |
| 2026-08-17 | [程序化 SEO + GEO](plans/2026-08-17-seo-geo-design.md)                                   | design         | 把整页客户端渲染、爬虫只拿得到「加载中…」的钱包页/市场页变成可索引落地页；红线是 SEO 层只准读本地 SQLite、严禁触发上游请求。                                                           |
| 2026-08-17 | [全站双语化](plans/2026-08-17-i18n-design.md)                                            | design         | 选「客户端语言上下文 + cookie 持久化」而非分语言路由：零路由重构、不动刚建好的 SEO 层；首访按 Accept-Language 自动选。                                                                 |
| 2026-08-16 | [X 自动播报账号](plans/2026-08-16-x-broadcast-bot-design.md)                             | design         | 把 worker 每天产出的独家信号变成 X 上的英文自动播报作为主获客渠道，四类内容 + $15/月按量预算熔断。                                                                                     |
| 2026-08-16 | [X 自动播报账号](plans/2026-08-16-x-broadcast-bot.md)                                    | implementation | 11 任务 TDD：`alerts` 表直接当发帖队列，X 侧是纯消费者（独立 60s loop、claim-then-post），主链路零改动、与 TG 物理隔离。                                                               |
| 2026-08-16 | [反事实退出分析](plans/2026-08-16-exit-counterfactual-design.md)                         | design         | 用已结算仓不可变的价格路径离线模拟止盈/止损/限时退出，零常驻负载覆盖全部 19 档完整历史；开篇即记录「活体退出档」实现后被评审否决并回滚的三条理由。                                     |
| 2026-08-13 | [策略深度分析面板](plans/2026-08-13-strategy-deep-analysis-design.md)                    | design         | 面向「判断哪档策略有真实优势」的读者，补上原有五个 tab 答不了的分析性问题：钱从哪赢来的、赢是运气还是本事、优势是否在衰减。                                                            |
| 2026-08-13 | [赛道 × 策略优势矩阵 + 缺陷诊断](plans/2026-08-13-edge-matrix-diagnosis-design.md)       | design         | 共用一套「分段统计」底座：矩阵是（策略 × 细赛道）的二维铺开当新档位选题池，诊断是单策略在赛道/时长/赔率带三维度上找亏损段。                                                            |
| 2026-08-13 | [反向对照策略](plans/2026-08-13-reverse-control-design.md)                               | design         | 依据线上快照（净值/ROI/胜率）给 6 个负 EV 档各配一个「同信号、买对面」的镜像档，一起持续观察。                                                                                         |
| 2026-08-13 | [反向对照策略](plans/2026-08-13-reverse-control.md)                                      | implementation | 7 任务 TDD：`MarketMeta` 加 `clobTokenIds`（META_V 2→3）+ 纯函数 `reverseCandidate` 翻边 + 种子 v4 只 INSERT 6 条，护栏/执行层/结算/markout 零改动。                                   |
| 2026-08-13 | [对外信号系统](plans/2026-08-13-external-signal-system-design.md)                        | design         | 盘点站内三套信号系统的出口现状（「只有两套半有出口」），比较投递方案并选定「信号台账 + 投递总线」，附完整工程量分析。                                                                  |
| 2026-08-13 | [对外信号系统](plans/2026-08-13-external-signal-system-implementation.md)                | implementation | 批次 0-3：`strategy_signals` 只记不可变事实，`runDeliveryCycle` 作为第七个 worker 循环幂等消费，通道即适配器，多租户 = 轻量 `api_keys` 表（sha256 + tier），不建用户体系。             |
| 2026-08-13 | [事件二级分类](plans/2026-08-13-event-subcategory-design.md)                             | design         | 体育按联盟细拆：gamma 的 tags 本来就带二级信息但标签顺序不可靠（实测），改用白名单 × 标签序派生 + 缓存懒回填，全站展示面升级细标签。                                                   |
| 2026-08-12 | [跟单页策略卡改版](plans/2026-08-12-follow-page-card-redesign-design.md)                 | design         | 12 档时代「12 张平铺大卡 × 14 个指标」成了反效果，改为克制卡片 + 下沉详情 + 可交互大图。                                                                                               |
| 2026-08-12 | [跟单页策略卡改版](plans/2026-08-12-follow-page-card-redesign.md)                        | implementation | 卡态判定与 sparkline 定域下沉到 `lib/followCardView.ts` 配单测（`app/` 无组件测试基建），其余组件靠 typecheck + 真机目视验收；全量测试基线 871。                                       |
| 2026-08-11 | [策略档位扩充](plans/2026-08-11-follow-strategy-tiers-design.md)                         | design         | 把纸面跟单从「2 条只在共识门槛上有区别的策略」扩到「4 个信号族 × 12 档」，并抽出信号检测与开仓的解耦层。                                                                               |
| 2026-08-11 | [策略档位扩充](plans/2026-08-11-follow-strategy-tiers.md)                                | implementation | 抽 `FollowCandidate` 统一契约 + detector 注册表，六个 detector 全是纯函数（DB 依赖在外层预取传入）；新增信号源 = 一个函数 + 一行注册，开仓代码零改动。                                 |
| 2026-08-04 | [战绩口径纠错四件套](plans/2026-08-04-record-correctness-design.md)                      | design         | 对外战绩查出四处系统性偏差且**全部偏乐观**（SELL 侧 implied 反号、共识升级行重复计、协议费未入账、UMA 争议价被钉死），逐条纠正；文中标注了已实施的对应提交。                           |
| 2026-07-08 | [信号台账与管道分解](plans/2026-07-08-signal-ledger-design.md)                           | design         | 指出采集/检测/执行/展示四件事挤在一个 Node 进程里的系统层耦合缺陷（起因是「跟单触发寄生在 Web 应用进程的自调度轮询里」），提出 S1/S2/S3 分期方案。                                     |
| 2026-07-07 | [共识跟单纸面模拟](plans/2026-07-07-consensus-follow-design.md)                          | design         | 把只读的共识检测升级出一层纸面跟单：共识形成即按市价开虚拟仓、持有到结算，聚合成多策略并行的净值曲线与指标做 A/B。                                                                     |
| 2026-07-07 | [共识跟单纸面模拟](plans/2026-07-07-consensus-follow-implementation.md)                  | implementation | 纯函数（P&L/指标）+ 注入式 `runFollowCycle` 挂在 5min 共识循环旁，2 张新表，`/follow` 页 + `/api/follow` 路由，零真实下单。                                                            |
| 2026-06-23 | [项目奠基：大额成交 & 聪明钱监控](plans/2026-06-23-polymarket-monitor-design.md)         | design         | 两个核心目标（大额**成交**实时推送 + 聪明钱监控）；文中所有上游接口均经实测打通（HTTP 200 + 真实数据）后才写入。                                                                       |
| 2026-06-23 | [项目奠基：大额成交 & 聪明钱监控](plans/2026-06-23-polymarket-monitor-implementation.md) | implementation | 分阶段 TDD：单个 Next.js 工程，`lib/` 共享代码 + `worker/` 常驻轮询 + `app/` 只读看板，worker 与看板通过本地 SQLite 解耦；无需任何 Polymarket 鉴权。                                   |

> 计数说明：`docs/plans/` 下 34 份 markdown = 23 份 `-design.md` + 3 份 `-implementation.md` + 8 份无后缀（其中 `2026-07-10-polymarket-monitor-strategic-roadmap` 是战略总纲、`2026-08-27-iteration-brainstorm-round2` 是脑暴快照；`follow-strategy-tiers` / `follow-page-card-redesign` / `reverse-control` / `x-broadcast-bot` / `x-post-copy-density` / `market-card-api` 正文自述为 Implementation Plan，上表按实际类型标注）。连同 `docs/api-access.md`、`docs/signals-api.md` 两份对外文档与本索引，`docs/` 全目录共 37 份 markdown。

---

## 截图

五张 PNG 都是 README 的配图，全部为**旧版界面**（顶栏还是平铺链接 + 右上「只读监控」徽标，当前 `app/ui.tsx` 已改为分组下拉且删除了该徽标）。日期为 git 中最后一次更新该文件的提交日期。

| 文件                 | 拍的是哪个页面                                                                                                              | 最后更新   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `dashboard.png`      | 首页 `/` —— 24h 大额成交扫描器：筛选区（金额 / 方向 / 时间窗 / 价格 / 类型 / 地址年龄）+ 四张汇总卡 + 成交流水表            | 2026-07-08 |
| `discovery.png`      | `/discovery` —— 聪明钱发现，**候选漏斗**视图：四段漏斗（30 天证据 → 候选钱包 → 准入闸门 → 白名单池）+ 标签筛选 + 证据明细行 | 2026-07-08 |
| `discovery-pool.png` | `/discovery` —— 同页的**白名单池**视图：在池钱包的评分 / 胜率 / 净盈亏 / 最近确认时间                                       | 2026-07-08 |
| `accumulation.png`   | `/accumulation` —— 拆单 / 累计买入榜：时间窗 + 精度 floor + 净买入门槛，按 (钱包·市场·结果) 聚合                            | 2026-06-30 |
| `alerts.png`         | `/alerts` —— 实时告警流。注意此图仍带**页内「告警条件」编辑面板**，该面板早已迁到 `/manage`，图已过期                       | 2026-06-30 |

另有 `docs/design/` 两份高保真 HTML 原型（均为 2026-07-29，对应 mm-mobile 的信号 tab 视觉稿，不是本站页面）：

- `signal-tab-app.html` —— 「MMMOBILE · 信号 tab 原型」
- `signal-tab-v2c.html` —— 「MM Mobile · 信号 Tab · V2-C 炭黑」

---

## 怎么读

想理解某个能力时，按这个顺序，一层比一层具体：

**① 先看架构** —— 仓库根目录的 `ARCHITECTURE.md`（子系统划分、worker 循环节奏、数据流与存储边界）和 `README.md`（产品是什么、怎么跑起来）。先建立整体地图，知道这个能力属于哪个子系统、由哪条循环驱动。

**② 再看对应的设计文档** —— 在上面的索引里按主题找。设计文档回答的是代码回答不了的问题：为什么选了 A 而不是 B、哪些方案被否决过（如 `2026-08-16-exit-counterfactual-design.md` 的「活体退出档」否决记录）、口径是怎么裁决的（如 `2026-08-04-record-correctness-design.md` 的四处偏差）、哪些"事实"是实测出来的而不是猜的（如 `2026-08-13-event-subcategory-design.md` 里「gamma 标签顺序不可靠」的实测样本）。配套的 implementation 文档还会写明当时的红线约束与测试基线。

**③ 最后读代码** —— 带着上面两层的上下文进去。`lib/` 是共享逻辑（纯函数居多，与之同名的 `*.test.ts` 就是可执行的规格说明），`worker/embeddedEngine.ts` 是全部循环的调度中心，`app/` 是页面与 API 路由。**代码是唯一的当前事实**：设计文档描述的是提案时的状态，落地后可能已经演进（文档里不少地方自己标注了「实现细化为 X」）。两者冲突时以代码为准。

如果只是要接入 API，跳过 ①②③，直接读 `docs/api-access.md`（或线上 `/api-docs`）。
