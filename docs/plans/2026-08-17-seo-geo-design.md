# 程序化 SEO + GEO（llms.txt）设计

日期：2026-08-17
状态：获客路线第二、三项（用户已委托开发）
前情：X 播报 bot（2026-08-16 批）已建成；本批把「钱包档案页 / 市场页」从
客户端渲染的不可索引状态变成搜索引擎与 AI 爬虫的落地页资产。

## 1. 现状与核心约束

- `app/wallet/[address]` 与 `app/market/[conditionId]` 都是 `"use client"` 整页：
  爬虫拿到的 HTML 只有 h1 + 「加载中…」——**有 URL 无内容**，不可索引。
- **红线约束：SEO 层严禁触发上游请求。** `/api/wallet` 每次 1-2+ 个上游调用
  （activity 2000 行 / holdings / PUSD），`/api/market` 带 data-api 窗口抓取。
  爬虫一天爬几千页 = 上游被打爆。服务端 SEO 层只准读本地 SQLite。
- 全站无 robots.txt / sitemap.xml / llms.txt；layout 元数据是两行中文。

## 2. 方案

### A. 服务端 SEO 层（只读本地库）

两页同构改造：`page.tsx` 变**服务端组件**（`generateMetadata` + 顶部
「已结算快照」server 摘要条），原客户端整页原样搬到同目录
`*Client.tsx`（同目录 ⇒ 相对 import 全部不动，行为零变化）。

- 摘要条数据源（全部本地表）：钱包 = wallet_stats + smart_wallets +
  wallet_age + getWalletTags + alerts 30 天该钱包告警数；市场 =
  market_meta + token_map（标题，补 condition_id 索引）+ alerts 该市场
  30 天统计 + consensus_state。
- 摘要条是真实 UX 增益不是爬虫专用（秒出快照，客户端实时档案随后加载；
  口径标注「已结算/本地快照」与实时区分）——不隐藏，无 cloaking。
- 元数据：英文 title/description（对齐 X 播报的英文受众策略）、canonical
  （地址小写归一防大小写重复收录）、OG tags。

### B. 发现面

- `app/robots.ts`：全体 allow `/`，disallow `/api/`、`/manage`（前瞻，本分支
  尚无该页）；**显式列 AI 爬虫组**（GPTBot/ClaudeBot/Claude-Web/
  PerplexityBot/Google-Extended/meta-externalagent，同样的 disallow）——
  GEO 的第一信号；sitemap 指针。
- `app/sitemap.ts`：静态页（/ /follow /consensus /accumulation /discovery
  /alerts /glossary）+ 钱包页 + 市场页。**质量门**：钱包 = smart_wallets 全体
  ∪ wallet_stats settled_count≥5（薄页不进站点地图）；市场 = 近 180 天有
  告警的 conditionId（活跃证明），各设上限（钱包 10000/市场 5000）。

### C. GEO

- `app/llms.txt/route.ts`：llms.txt 规范（H1 + 引言 + 分节链接），英文，
  描述产品/方法论（验证闭环）/关键页面/免责声明，带少量活数（在池钱包数、
  累计告警数）示新鲜度。
- JSON-LD：layout 注入 WebSite + Organization；钱包/市场摘要条注入
  BreadcrumbList。不做更重的 schema（预测市场无标准类型，错标不如少标）。
- layout 元数据升级：`metadataBase`（PUBLIC_URL）、英文主标题
  「WhaleWatch — Polymarket Whale & Smart-Money Monitor」+ `%s | WhaleWatch`
  模板、英文 description（中文补注）。注意：浏览器标签页标题会从中文变英文。

### D. 程序化 SEO 卫生

- 路径参数严格校验：地址 `^0x[0-9a-fA-F]{40}$`、conditionId `^0x[0-9a-fA-F]{64}$`，
  不合法 `notFound()`——无限 URL 空间不可给爬虫。
- **薄页 noindex**：本地库查无任何数据的钱包/市场页 → metadata robots
  noindex（页面照常渲染，客户端实时抓取不受影响）。与 sitemap 质量门同一
  哲学：只把有实质内容的页交给索引。

## 3. 任务

1. `lib/seo.ts` + 测试：参数校验、buildWalletSeoSummary、buildMarketSeoSummary、
   sitemapWalletEntries/sitemapMarketEntries、llmsTxt 内容函数、siteBase()；
   db.ts 补 `idx_token_map_condition`。
2. robots.ts / sitemap.ts / llms.txt route。
3. layout 元数据 + WebSite/Organization JSON-LD。
4. 钱包页拆分（server page + 摘要条 + Client 文件平移）。
5. 市场页拆分（同构）。
6. 全量测试 + tsc + 预览真机验证（robots/sitemap/llms.txt/两页 view-source
   含服务端内容与 meta）。

## 4. 验证口径

- 单测：:memory: 库种数据断言摘要/站点地图/noindex 门。
- 真机：curl 三个发现面文件；给 dev 库种一行 wallet_stats/market_meta 后
  view-source 验证服务端 HTML 含快照文本与正确 meta/canonical/JSON-LD。
