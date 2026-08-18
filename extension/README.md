# WhaleWatch 𝕏 Publisher（浏览器插件发帖通道）

把 whalewatch 服务端排好队的信号帖，通过**你本机 Chrome 里已登录的 X 会话**
发出去，不经 X API、零边际成本。

设计与取舍见 [`docs/plans/2026-08-18-x-extension-channel-design.md`](../docs/plans/2026-08-18-x-extension-channel-design.md)。

---

## 它在系统里的位置

```
worker (服务器)                     插件 (本机 Chrome)                x.com
──────────────                     ──────────────────                ─────
runXBroadcastCycle
  → 配额判定 → 落 status='queued'
                             ◀── GET /api/x-queue      (alarms 60s)
                                  后台标签页 → 注入填字 → 点 X 的 Post
                                  MAIN world 拦 CreateTweet          ──▶
                             ──▶ POST /api/x-queue/ack
  → settle('posted' / …)
```

插件是**哑但有记忆**的手：不判断金额、不选模板、不算配额（那些都在服务端），
但必须记得自己发过什么 —— 那是跨网络幂等里服务端无法承担的另一半。

---

## 安装

```bash
cd extension && npm install
WW_BASE_URL=https://whalewatch.wired.fund npm run build
```

1. 打开 `chrome://extensions`，右上角开「开发者模式」
2. 「加载已解压的扩展程序」→ 选 `extension/dist/`
3. 固定图标到工具栏（后面看状态方便）

> `WW_BASE_URL` 在**构建期**注入：它同时决定 `host_permissions` 和配置桥
> content script 的 `matches`。**换服务器地址必须重新打包**——这是刻意的，
> 写成 `<all_urls>` 会让任何网站都能给插件推配置。

## 连接

1. 服务端 `/manage` → 「🔑 接入」→ 签发一把 key，**勾上「𝕏 发帖队列」**
2. 「𝕏 播报账号」→ 发帖通道切到「🧩 浏览器插件」
3. 把 key 粘进「连接插件」→ 点「推送配置到插件」
4. 插件图标 → 应显示「已连接」

服务器地址不用手抄，配置桥会带上。

## 日常

- **正常状态**：什么都不用做。后台标签页静默开关，你看不见。
- **看状态**：点插件图标 —— 连接状态、开关、最近 20 条结果。
- **暂停**：popup 里关掉「自动发帖」。
- **换 key**：`/manage` 重新推送即可覆盖。

---

## 首次冒烟清单

装好后按这个顺序验，**先演练再真发**：

- [ ] **1. 演练模式验 DOM**：popup 打开「演练模式（只填不发）」→ 点「立即拉取」
      → 应弹出一个 x.com 编辑器标签页，帖文已填好、**未发送**。
      多行结构（🐳 抬头 / 标题 / └ 标的 / 📊 佐证 / #标签）必须**每一行都在**。
- [ ] **2. 大单帖**：关掉演练 → 等一条 whale 信号（或 `/manage` 上手动造）→
      后台标签页应自动开关，popup 显示「已发布」，`/manage` 历史里出现
      `channel=extension` 的 `posted` 行且带 `x_post_id`。
- [ ] **3. 共识帖**：同上，确认优先级（共识排在大单前面）。
- [ ] **4. 赛前聚合**：确认日上限按 `/manage` 里配的值生效。
- [ ] **5. 周报图卡**：周一 13:00 UTC 后。确认**图片被带上了**（这条走
      `imageUrl`，插件自己下载再塞进 X 的文件输入框）。
- [ ] **6. 掉登录**：手动在 x.com 登出 → 下一轮应弹通知「𝕏 通道故障」，
      popup 显红，且队列里的帖**退回 queued 而不是被标失败**。重新登录后
      10 分钟内自动恢复。

## X 改版了怎么办

症状：popup 一直「通道故障」，或帖子一直「失败」。

排查顺序：

1. **先开演练模式跑一次** —— 零风险地看 DOM 还认不认得：
   - 编辑器找不到 → 选择器变了，改 `x.poster.ts` 的 `findComposer`
   - 填进去了但只剩最后一行 → **Draft.js 那个坑复发**，检查 paste 路径
   - 填好但 Post 按钮不亮 → 检查 `findSendButton`，或本来就是内容问题
     （超长、与近期帖重复）
2. 改完 `npm test` —— `x.poster.spec.ts` 里有多行填字的回归测试
3. 实在修不了：`/manage` 上把通道切回「☁️ API 直发」，几秒钟恢复播报，
   再慢慢修插件。**双通道并存的意义就在这里。**

---

## 权限说明

| 权限               | 用途                                                        |
| ------------------ | ----------------------------------------------------------- |
| `storage`          | 存服务器地址/key、防重发记忆、最近结果                      |
| `alarms`           | 60s 轮询（service worker 会被回收，`setInterval` 活不下来） |
| `tabs`             | 开/关发帖用的后台标签页                                     |
| `scripting`        | 往 x.com 注入填字脚本与 CreateTweet 拦截器                  |
| `notifications`    | 通道故障、连接失效时提醒                                    |
| `host_permissions` | 仅 `x.com` / `twitter.com` + 你自己的服务器域名             |

**刻意不要的**（aisee 有，我们用不上）：`cookies`（不读会话）、
`debugger`（不需要原生击键，且它是权限清单里最扎眼的一个）、`activeTab`。

## 开发

```bash
npm run dev        # watch 重建（改完在 chrome://extensions 点刷新）
npm test           # vitest（DOM 相关的用例在文件头声明 jsdom 环境）
npm run typecheck
```

代码地图：

| 文件                             | 职责                                                     |
| -------------------------------- | -------------------------------------------------------- |
| `src/background/index.ts`        | alarms 调度 + 消费循环 + 熔断接线                        |
| `src/background/x.poster.ts`     | **移植自 aisee**：paste 填字 + MAIN world 拦 CreateTweet |
| `src/background/queue.client.ts` | 服务端 HTTP + 本地防重发记忆                             |
| `src/background/breaker.ts`      | 通道级熔断（连续 3 次故障停摆，10 分钟探活）             |
| `src/background/storage.ts`      | chrome.storage.local 封装                                |
| `src/content/bridge.ts`          | 配置桥（三重来源校验）                                   |
| `src/shared/protocol.ts`         | 与服务端 `lib/extensionProtocol.ts` 同源，测试钉死       |
