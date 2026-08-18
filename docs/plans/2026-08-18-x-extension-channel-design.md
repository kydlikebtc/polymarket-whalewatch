# 𝕏 浏览器插件发帖通道设计

日期：2026-08-18
状态：用户已确认，转实施
背景：X 按量付费的 $15/月 预算把发帖量卡死在 ≈28 帖/天（whale 还被 `DAILY_CAP`
压到 20），获客速度受制于成本而非内容供给。本设计新增一条**浏览器插件通道**：
用运营者本机 Chrome 里已登录的 X 会话发帖，边际成本为零，与既有 API 通道
**并存且可一键切换**。

参考实现：`aisee-live/aisee-browser-extension`（私有仓库）。它的
`src/pages/background/x.poster.ts` 已经在生产环境趟平了 x.com 的三个坑，
本设计直接移植（见 §6）。

---

## 1. 目标与非目标

**目标**

- 新增 extension 通道，`/manage` 上一键切换当前发帖通道，切换后 ≤60s 生效。
- 两条通道**共享同一张 `x_posts` 表**：幂等键、历史、周报统计、成本台账全部
  只有一份真相，切换不重发、不断档。
- 插件保持"哑但有记忆"：不含任何业务逻辑（不判金额、不选模板、不算配额），
  只负责把服务端给的字符串发到 X 上，并记得自己发过什么。

**非目标（本批不做）**

- 自动回复 / 引用转推 / 关注管理（插件通道让这些成本归零，但那是独立选题）。
- 「插件通道才带链接」的模板分叉——见 §7 取舍备忘。
- 服务器侧无头/有头浏览器托管（用户已裁决用本机 Chrome）。
- 上架 Chrome 应用商店（本批只做 Load unpacked）。

## 2. 关键前提（用户已裁决）

| 项           | 裁决                             | 影响                                             |
| ------------ | -------------------------------- | ------------------------------------------------ |
| 转插件动机   | 成本/配额顶不住                  | 不是弃用 API，而是把量挪走；API 通道原样保留     |
| 通道关系     | 两种都支持，可切换当前使用的方式 | 必须共享 `x_posts`，见 §3                        |
| 插件宿主     | 运营者本机 Chrome，**一直挂机**  | TTL 从"关机补发闸门"变为"异常兜底"，取 2h        |
| 发送确认     | 全自动，后台标签页静默发         | 必须处理"点了但没抓到回执"的不确定态             |
| 日上限       | 可配置，默认 100                 | `DAILY_CAP` 从常量变为「常量兜底 + config 覆盖」 |
| 加权长度 bug | 合进本批一起修                   | 见 §8                                            |

## 3. 架构

服务端仍是唯一大脑。`xBroadcast` 在 extension 通道下，把「同步发帖」换成
「落一行 `queued`」，插件来取、去发、回报。

```
worker (服务器)                     插件 (本机 Chrome)                x.com
──────────────                     ──────────────────                ─────
runXBroadcastCycle
  → quotaDecision → claim
  → INSERT status='queued'
                             ◀── GET /api/x-queue      (alarms 60s)
                                  [{id, kind, text, imageUrl?}]
                                  后台标签页 → 注入填字 → 点 X 的 Post
                                  MAIN world 拦 CreateTweet          ──▶
                             ──▶ POST /api/x-queue/ack
                                  {id, result, xPostId?, error?}
  → settle
```

**为什么切换点在 settle 环节而不在 `XClient` 接口层**：`XClient`
（`postText`/`postWithPng`）是同步"推"语义，而插件是"拉"语义——Docker 无头
服务端无法调用浏览器里的插件。所以插件通道无法实现 `XClient`，切换必须上提
一层到 `xBroadcast` 的投递策略。

这个改动之所以小，是因为 `x_posts.claimed` 态**本来就是为跨进程抢占锁设计的**
（见 `lib/xBroadcast.ts` 文件头）。现在只是把"另一个进程"从另一个 worker
换成了网络另一头的浏览器，状态机语义不变，只是锁必须带 TTL。

零改动模块：`xComposer`（模板）、`xQuota`（台账口径）、dedup、`xAccounts`。

## 4. 数据模型

```sql
-- 两列都是 additive，走 db.ts 既有的 ALTER TABLE ADD COLUMN 迁移风格
ALTER TABLE x_posts ADD COLUMN channel   TEXT    NOT NULL DEFAULT 'api';
ALTER TABLE x_posts ADD COLUMN leased_at INTEGER;

-- API key 新增能力位（最小权限，可撤销）
ALTER TABLE api_keys ADD COLUMN can_x_queue INTEGER NOT NULL DEFAULT 0;
```

`channel` 一列换来通道级可归因：切换后仍能回答「上周那波涨粉是哪条通道发的」
「插件通道失败率是不是更高」。没有它，`/manage` 的历史就是一锅粥。

**状态机**（上半为现状，一行未动；下半为新增分支）：

```
                     quotaDecision
                          │
       ┌──────────────────┴──────────────────┐
       │ channel=api                          │ channel=extension
       ▼                                      ▼
    claimed ──发帖──► posted              queued ──插件取走──► leased
       │                                      │                  │
       │ 4xx≠429                              │ TTL 到期          ├─ posted
       ▼                                      ▼                  ├─ posted_unconfirmed
    failed                                 expired               ├─ failed
                                                                 └─ 租约超时/channel_error
                                                                     → 退回 queued
```

**`leased` 不是多余状态**：`queued` 直接跳 `posted` 的话，插件取走后浏览器崩溃
就会让这条帖要么永久卡死（丢内容）、要么每轮重发（重复发帖）。`leased_at`

- 超时退回是唯一同时避免两者的做法。

**`expired` 而不是删行**：删行会腾空 `INSERT OR IGNORE` 的幂等键，下一轮同一条
alert 重新入队——「开机就喷隔夜旧闻」这个 bug 就是这么来的。墓碑是幂等的必要条件。

**两个 TTL**（env 可调）：

| 参数              | 默认      | 作用                                                                                                                                          |
| ----------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `X_QUEUE_TTL_SEC` | 7200 (2h) | `queued` 无人认领超时 → `expired`。浏览器常驻，故 TTL 只在异常（崩溃/断网/掉登录）时起作用；2h 覆盖绝大多数临时故障，又不至于恢复后喷半天旧闻 |
| `X_LEASE_TTL_SEC` | 300 (5m)  | `leased` 无 ack 超时 → 退回 `queued`。覆盖浏览器崩溃、标签页被手动关掉                                                                        |

## 5. 配置项（均存 `config` 表，复刻 `xSettings.ts` 模式：JSON 单行、

坏值降级默认、真实变更才写 `config_history`）

| key                  | 默认                     | 说明                                                                                                         |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `x_delivery_channel` | `"api"`                  | `"api"` \| `"extension"`。默认 api 是为了**升级不改行为**，与 `DEFAULT_X_KINDS` 全开同一条纪律               |
| `x_daily_caps`       | `{whale:100, pregame:6}` | 仅作用于 extension 通道。api 通道继续用 `DAILY_CAP` 常量 `{whale:20, pregame:3}`——那是预算约束，不是风控约束 |

extension 通道下 `est_cost_usd = 0`，预算熔断天然不触发（这就是省钱点）。
`DAILY_CAP` 保留但语义变了：从「省钱」变成「防封号 + 防刷屏」。

**切换通道时 `queued` 的归属**：切回 api 时，队列里的 `queued` **就地作废**
（`expired`），不由 API 补发。切换往往正因为插件那条路出了问题，用付费 API
补发积压旧闻是双输。`/manage` 切换时提示「将作废 N 条待发」。

## 6. 从 aisee 移植的实现细节

`x.poster.ts` 的三个坑，每个都是别人流过血的：

1. **不能用 content script**：x.com 的 CSP 会挡掉 crxjs 的动态 import loader，
   content script 根本不会执行。必须用 `chrome.scripting.executeScript` 注入
   isolated world（不受页面 `script-src` 约束）。
2. **不能用 `execCommand('insertText')` 填多行**：X 的编辑器是 Draft.js，
   它会从光标所在 block 重建 ContentState，**静默丢掉前面所有段落**，最后只
   发出去最后一行。必须伪造 `ClipboardEvent('paste')` 走 Draft 的粘贴处理器。
   我们的模板全是多行结构化布局，正中此坑。
3. **发帖确认靠 MAIN world 拦截 `CreateTweet`**：点击前 patch `fetch` + `XHR`，
   抓 `rest_id` 回填 permalink。**抓到才敢关标签页**，抓不到就是不确定态。

架构立场同样照搬：**只让 X 自己的 JS 去构造和签名请求**，绝不从 background
重放 X 的内部 API。`x-client-transaction-id` 之类的反爬签名由 X 自己算，比逆向
可靠一个数量级，也少一层风控信号。

**另外移植 auth-bridge 模式**（aisee `src/pages/content/auth-bridge.ts` +
`src/shared/extension/brand.ts`）做零手工配置：

```
/manage「𝕏 播报」区块 [推送配置到插件]
   ↓ window.postMessage({source: WW_EXTENSION_MESSAGE.source, ...})
content script（matches 只写自己的域名）
   ↓ chrome.runtime.sendMessage
background → chrome.storage → popup 显示已连接
```

协议常量放 `lib/extensionProtocol.ts` 单一来源，`extension/src/shared/protocol.ts`
从它复制，握手不会漂移。**content script 的 `matches` 必须只写自己的域名**——
写 `<all_urls>` 意味着任何网站都能给插件推配置，是扩展里最经典的一类漏洞。

反向也要通：撤销 API key → 插件下次拉取拿 401 → 自动清空本地配置并弹通知，
而不是带着一把废 key 静默失败。

## 7. 队列协议

**认证**：新签一类 API key（`can_x_queue` 能力位），**不用 `ADMIN_TOKEN`**——
后者是全站可写的最高权限，塞进浏览器扩展不划算。用 API key 的好处是最小权限、
可撤销、且 `last_used_at` 天然就是插件心跳。

```http
GET /api/x-queue?limit=3
    x-feed-token: <api key>
 → { posts: [{ id, kind, text, imageUrl? }], serverTime }
```

服务端在一个事务里 `SELECT ... WHERE status='queued' ORDER BY 优先级 LIMIT n`
再 `UPDATE ... SET status='leased', leased_at=?`（不用 `UPDATE ... LIMIT`：
better-sqlite3 默认未编译 `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`）。

```http
POST /api/x-queue/ack
     x-feed-token: <api key>
     { id, result: "posted"|"unconfirmed"|"failed"|"channel_error",
       xPostId?, error? }
 → { ok: true }
```

**周报图片**：`weekly` 帖的 `imageUrl` 指向既有 `/api/og/weekly`，插件下载转
base64 塞进 X 编辑器的 file input（aisee 的 `fetchImageForPage` +
`attachXImagesInPage` 原样可用）。

## 8. 错误分类：两类，处理方式完全不同

| 插件观察到的现象               | 分类       | ack result      | 服务端动作                                     |
| ------------------------------ | ---------- | --------------- | ---------------------------------------------- |
| 抓到 `CreateTweet` 回执        | 成功       | `posted`        | `posted` + 存 `x_post_id`                      |
| 点了 Post 但 6s 没抓到回执     | **不确定** | `unconfirmed`   | `posted_unconfirmed`，`/manage` 高亮待人工核对 |
| 编辑器填好但 Post 按钮始终不亮 | 单帖       | `failed`        | `failed`，队列继续                             |
| 找不到编辑器 / 跳到登录页      | **通道级** | `channel_error` | 退回 `queued` + 熔断 + TG 告警                 |
| 服务器返回 401                 | **通道级** | —               | 插件清本地配置 + 弹通知                        |

`posted_unconfirmed` 必须是独立状态：当成功会让 `x_post_id` 为空污染周报统计，
当失败会重复发帖。

**通道级与单帖必须分开**，否则一次 X 掉登录会把队列里每一条依次标成
`failed`——**一次故障烧光整个队列且永不重发**。熔断规则：连续 3 次
`channel_error` → 插件停止消费，popup 显红，每 10 分钟探活一次；服务端收到
`channel_error` 立刻发 TG 告警（复用既有断更报警通道）。

**ack 丢失导致重复发帖**（at-least-once 的经典裂缝）：插件发帖成功 → 网络抖 →
ack 未达 → 服务端 lease 超时退回 `queued` → 插件再取到 → 又发一遍。
解法必须在**插件侧**：`chrome.storage` 持久化「queue id → x_post_id」表，
取到已在表里的条目**只补 ack、不重发**，ack 成功后才删。

> 服务端的 `INSERT OR IGNORE` 幂等键保护的是"同一条 alert 不重复入队"，
> 保护不了"同一条 queued 不重复发送"。跨网络边界后，幂等责任双端各担一半：
> 服务端无法区分"插件死了"和"插件发完了但 ack 丢了"，这个信息只有插件有。

**健康探测**：`x_delivery_channel='extension'` 且 `queued` 积压 > N 条持续 >
M 分钟 → 告警。覆盖「插件死了但没报错」（如 Chrome 杀掉 service worker 未重启）
这种最难发现的情况。

## 9. 顺带修复：`xComposer` 的 280 限长算错了

`fitByTruncatingTitle` 用 `[...full].length` 数**码点**，但 X 用的是
twitter-text 加权长度：只有 `[0,4351]`、`[8192,8205]`、`[8208,8223]`、
`[8242,8247]`、`[8259,8259]` 这几段权重 100（算 1 个字符），**其余一律权重
200（算 2 个）**——emoji 和制表符号全在后者。

拿真实模板实测（长标题触发截断）：

```
码点数(现有实现口径): 280   上限 280
X 加权字符数(真实口径): 286
超出: 6
```

超出的 6 正好是模板里的 6 个双宽字符：`🐳 📊 💧 ⏳ └ …`。

**这是线上现存 bug，不是插件引入的**：截断一旦触发，帖子必然超限 → X 返回
403 → `isPermanentXError` → 标 `failed` 丢弃。危险带还更宽：非截断帖只要码点数
≥ 276（含 5 个双宽字符）就已超限。

而**插件通道会把它从"有日志的失败"变成"静默的失败"**——DOM 上只表现为 Post
按钮永远不亮，走 `filled` 分支，看起来像"等人工确认"。故合进本批修复。

修法：`fitByTruncatingTitle` 内改用加权计数（约 20 行纯函数）；现有测试的
`≤280` 断言改为加权口径，并新增「截断后仍守住加权 280」用例钉死上述场景。

## 10. 插件形态

位置：**whalewatch 仓库的 `extension/` 子目录**，自带 `package.json` 与
`node_modules`（根 `.gitignore` 加一行）。理由：协议契约与服务端端点在同一个
commit 里改，物理上无法漂移。它是 whalewatch 的部件，不是独立产品线
（与 `cover` 拆库的情况不同）。

技术栈对齐 aisee 但砍瘦：**Vite + `@crxjs/vite-plugin` + TypeScript，
不引 React / Tailwind**——我们的 popup 只有一屏（服务器地址、API key、通道
开关、队列数、最近 10 条、手动拉取、dry-run 开关），原生 DOM 即可，省掉整条
React 依赖链。aisee 的 popup 复杂一个量级（登录表单 + compose + 队列 + 历史

- scan），它引 React 是合理的，我们不是。

```
extension/
├── manifest.json
├── vite.config.ts
├── package.json
└── src/
    ├── background/
    │   ├── index.ts         # alarms 60s 调度 + 消费循环 + 熔断计数
    │   ├── x.poster.ts      # 移植 aisee：paste 填字 + MAIN world 拦 CreateTweet
    │   └── queue.client.ts  # 服务端 HTTP + 本地 pending-ack 表
    ├── content/bridge.ts    # 只在自己域名上跑的配置桥
    ├── popup/{index.html,index.ts}
    └── shared/protocol.ts   # 与 lib/extensionProtocol.ts 同源
```

**权限对照 aisee 砍到最小**：

| 保留               | 用途                         | 砍掉        | 理由                                         |
| ------------------ | ---------------------------- | ----------- | -------------------------------------------- |
| `storage`          | 配置 + pending-ack           | `cookies`   | 我们不读会话                                 |
| `alarms`           | 60s 轮询                     | `debugger`  | 不需要原生击键；且它是权限清单里最扎眼的一个 |
| `tabs`             | 开/关后台标签页              | `activeTab` | 不看当前页                                   |
| `scripting`        | 注入填字 + 拦截              |             |                                              |
| `notifications`    | 通道故障提醒                 |             |                                              |
| `host_permissions` | `https://x.com/*` + 自有域名 |             |                                              |

## 11. 测试

**服务端**（保持现有 1017 测试全绿基线）

- `lib/xQueue.ts` 纯 DB 单测：lease 原子性、TTL 双回收（`queued`→`expired`、
  `leased`→`queued`）、ack 四种 result 落库、重复 ack 幂等。
- `xBroadcast` 两条通道分支（api 直发 / extension 落 `queued`）。
- `xComposer` 加权长度：改断言 + 新增截断边界用例（§9）。
- 端点鉴权：无 `can_x_queue` → 403、无效 key → 401。
- `xSettings` 新增两个 config key 的坏值降级。

**插件**（vitest，分法同 aisee）

- `queue.client.ts` pending-ack 去重：mock fetch，验证「已发过的 id 再取到 →
  只补 ack 不重发」。
- 熔断计数器（连续 3 次 → 停）。
- `x.poster.ts` 页面内函数用 `// @vitest-environment jsdom` 测：
  **多行文本走 paste 路径后完整保留**（Draft.js 坑的回归测试，必须有）。

**测不了的部分**：真实 x.com DOM。两个手段兜底

1. **演练模式（dry-run）**：popup 一个开关，走完整流程但 `autoSubmit=false`，
   只填不发。DOM 适配坏没坏一眼可见且零发帖风险。X 每次改版后先跑这个。
2. **手工冒烟清单**：写进 `extension/README.md`，四类帖各发一条。

## 12. 关键设计取舍备忘

- **推翻了首版设计文档 §7 的「不用浏览器自动化」裁决**。当时的两条理由：
  (a) 违反 ToS 有封号风险、(b) 无法 7×24 服务器化。(b) 由「本机常挂机」化解；
  (a) 仍然成立，但用「让 X 自己的 JS 签名请求 + 本机真实环境 + 日上限风控」
  把风险压到可接受，且 API 通道随时可切回作为逃生舱——这正是"两通道并存"
  而非"替换"的根本理由。
- **插件必须"哑但有记忆"**：不含业务逻辑（DOM 适配坏掉时坏的只是"手"，
  "大脑"完好），但必须记得自己发过什么（跨网络边界的幂等责任无法单边承担）。
- **不做「插件通道才带链接」**：插件通道下带链接帖不再是 $0.20/条，`xComposer`
  第二条硬不变量（除 weekly 外不得含 URL）的经济基础消失了，每条帖都可以带
  站点链接——而这正是获客转化的主要抓手。但两条通道共用一个 composer，
  要做通道相关的模板就得给纯函数传通道参数，那是模板层的分叉；且带链接是否
  会压低 X 的分发权重需要单独验证。留给下一批。
