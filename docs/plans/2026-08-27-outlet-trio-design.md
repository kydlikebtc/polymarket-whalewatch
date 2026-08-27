# 新出口三件套：MCP Server + 可嵌入卡片 + 公开数据集 — 设计文档

> 日期：2026-08-27
> 来源：[第二轮脑暴](2026-08-27-iteration-brainstorm-round2.md) #11/#13/#19，用户裁决先行实施
> 主题：零新数据、零新语义——把现成资产换三个新出口，各开一条分发渠道

## 共同红线

- 三件全部**零上游调用**：出口只许消费已持久化状态或已有公开 API。
- 不新增任何「信号 edge」主张——全部内容是已存在页面/端点的换壳，30 天闸门无关。
- 公开出口延续 /api/record 的自保姿态：限流 + 缓存 + 零上游。

## 1. MCP Server（`mcp/`）

**它是什么**：把只读 API 包成 Model Context Protocol server，让 Claude Code /
Claude Desktop / 任何 MCP 客户端直接查鲸鱼数据——AI 原生获客渠道，预测市场领域
目前没有先例。

**形态裁决：stdio 进程（in-repo），不是站内远程 MCP 端点。**

| 选项                                          | 裁决                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A. 站内 `/api/mcp`（Streamable HTTP）         | 否：给监控主进程引入协议会话管理与新依赖面，一次协议库升级事故就可能陪葬采集链路；收益（零安装）不抵风险 |
| B. stdio server，走公开 HTTPS API（**选定**） | 与部署完全解耦；用户 `claude mcp add whalewatch -- npx tsx mcp/server.ts`；API 抖动只影响该用户会话      |

- `mcp/server.ts` + `mcp/lib.ts`（纯函数：URL 构造 / 鉴权头 / 响应整形），
  跑法与 worker 同款 `tsx`，官方 `@modelcontextprotocol/sdk`。
- 工具面 = 现有端点 1:1，不发明新语义：`get_health`、`get_continuity`、
  `get_record`（公开三件）+ `get_signals`、`list_signals`、`get_market_card`
  （需 key，`WHALEWATCH_API_KEY` env，`x-feed-token` 头）。
- `WHALEWATCH_BASE_URL` 可覆盖（默认线上），自托管用户指向自己的部署即可。
- 无 key 时有 key 的工具返回带指引的错误文本，而不是从工具列表里消失——
  「有这个能力但你没配钥匙」和「没有这个能力」是两条不同的信息。
- npm 发布（`npx whalewatch-mcp`）留作后续人工决策——发布是对外动作，不自动做。

## 2. 可嵌入卡片（`/embed/*`）

**它是什么**：战绩记分卡与状态徽章的 iframe 版，第三方博客/Notion/推文卡可直接
嵌入——每一次嵌入都是带署名回链的分发。

**形态裁决：Route Handler 直出自包含 HTML，不是 app 页面。**
根 layout 对所有 page 强制包裹 TopNav/Provider/JSON-LD，嵌入卡要的是极简自包含
（内联样式、零 JS、无导航）；route handler 返回 `text/html` 干净绕开，且天然
可加 `Cache-Control`。

- `GET /embed/record`：整体 30d 战绩卡（复用 `buildRecordFeed`——与 /record 页
  同源同口径，两处永不打架）。
- `GET /embed/status`：连续性徽章（streak 读数 + 今日状态点，复用
  `computeContinuity`）。
- 共同约定:`?theme=light|dark`；`Cache-Control: public, max-age=60`；
  `X-Robots-Tag: noindex`（嵌入片段不该抢主页面的搜索位）；底部固定署名回链
  「whalewatch.wired.fund」；限流与 /api/record 同池纪律。
- 发现入口：/record 与 /status 页各加「嵌入此卡」折叠块，present 复制即用的
  `<iframe>` 代码（i18n 双语）。

## 3. 公开数据集（`GET /api/dataset/record.csv`）

**它是什么**：已公开发布信号的全量结算台账 CSV——研究者/量化引用你 = 别人替你
建护城河（长期护城河 #1 的 OSS 式释放）。

- 范围 = **已发布**信号（与 /api/record 同一分母：`strategy_signals` 里
  push 过的），逐行：day / strategy `code` / conditionId / title / outcome /
  entryPrice / exitPrice / won / realizedPnl / formationTs / settledAt。
  未结算行也导出（won 空）——分母诚实是这个产品的命。
- CSV 而非 Parquet：零新依赖，pandas/Excel/DuckDB 通吃。
- 每次全量现生成（数据量 = 发布信号数，千行级，SQLite 毫秒级）；限流从紧
  （perIp 6/min），`Cache-Control: public, max-age=300`。
- 首行注释携带 license（CC BY 4.0 · attribution: whalewatch.wired.fund）与
  生成时刻；**可验证性不重造**：README/文档明确「逐日 hash 链验证走
  `/api/record` 的 digest，CSV 是便利导出不是存证载体」。
- 入口：/record 页「下载全量 CSV」+ api-access.md 三处 + llms.txt 提一行。

## 测试与验收

- `mcp/lib` 纯函数单测（URL/头/整形/无 key 错误文案）；MCP 真机冒烟
  （tools/list + 两个公开工具实调线上）。
- embed 两卡：HTML 结构/署名回链/theme/缓存头/noindex 单测（route 直调）；
  浏览器真机 iframe 渲染截图。
- dataset：CSV 头/行数/license 行/限流单测；DuckDB/纯文本抽查。
- 全套测试 + tsc + i18n 覆盖闸全绿；api-access.md 契约测试通过。
