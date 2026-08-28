# 功能说明书 /guide —— 全站板块的「是什么 · 怎么用 · 怎么读」

> 日期：2026-08-28
> 性质：设计文档（形态裁决 + 内容契约 + 防漏机制）。
> 需求：用户要求「详细说明每个板块的功能介绍、怎么使用、怎么解读，入口先放 /manage」。

## 问题陈述

站点已有十一批功能、二十来个页面，但「这一页在干什么、数字该怎么读」散落在
四处：README（双语但活在 GitHub）、/glossary（名词级，不讲页面）、各页 header
的一句话 hint、CHANGELOG（按批次不按板块）。新访客与回访运营者都缺一张
**按板块组织的总说明书**：每个板块是什么、怎么操作、读数的口径与红线。

## 形态裁决

**独立公开页 `/guide`，glossary 数据模式，入口先只挂 /manage。**

- 页面本身公开可达（它没有秘密——通篇是公开页面的说明书；/status 同理
  「页面无需令牌可直达，只是不主动对外推」）。**不进 NAV、不进 sitemap**：
  用户说「入口先放 /manage」，低调期不占导航与搜索位；将来要转正，加两行
  （NAV + sitemap）即可。
- 入口完全复刻 /status 的双入口先例：/manage 解锁态页头一条（任何 tab 下
  都找得到）+ 锁定态一条（说明书不含运营情报，锁外可见无害）。
- 数据与渲染分离，照抄 glossary 模式：`app/guide.ts` 纯数据中文唯一源，
  页面渲染处过 `t()`，译文集中在 `lib/i18n/dict/guide.ts`——coverage 闸
  只扫渲染层字面量，数据层键靠 dict 测试与页面消费间接锁定。

### 被否决的方案

- **/manage 内嵌 section**：manage 整页在令牌门后且单语中文；说明书的最终
  受众是访客，锁在运营门后违背用途，将来公开还得整体搬家。
- **docs/\*.md + markdown 渲染**：README 已经是双语 markdown 说明书，再造
  一份必然漂移；且 markdown 无法上「NAV 页面 ⊆ 说明书」的防漏测试。
- **逐页内嵌帮助抽屉**：要改二十个页面，且失去「总览一张图」的价值；
  glossary 的悬停 tip 已承担页内即时解释。

## 内容契约（app/guide.ts）

```ts
interface GuideSection {
  id: string; // 锚点，kebab-case 唯一
  icon: string;
  title: string; // 板块名——与 NAV label 同字符串（复用既有译文键）
  href: string; // 板块入口路由，页内「打开 →」直达
  tagline: string; // 一句话定位
  what: string[]; // 功能介绍：这个板块有哪些能力，各一段
  how: string[]; // 怎么使用：操作流（筛选、点击、订阅、分享…）
  read: string[]; // 怎么解读：口径、样本声明、红线、常见误读
}
```

分区顺序沿 NAV 心智模型：24h 扫描 → 市场组（拆单累计/市场卡/市场脉搏/
市场校准）→ 聪明钱组（共识分歧/发现/自测）→ 信号与战绩组（实时告警/
策略中心/信号战绩）→ 参考与档案（钱包档案/名词说明）→ 运维与出口
（系统状态/订阅方 API/运营管理/嵌入卡与站外出口）。

**`read`（怎么解读）是本页的灵魂，继承全站诚实纪律**：每节至少写清
样本口径与一条「别这么读」（如：命中率的聚簇区间、「—」≠0、truncated
降级、选择偏差声明、纸面战绩非投资建议）。宁可少一条功能点，不可少
口径警示。

## 防漏机制（app/guide.test.ts）

1. **NAV ⊆ 说明书**：`app/ui.tsx` 导出 `NAV`（现为模块私有，加 export），
   测试断言 NAV 里每个 href（含分组 items）都有对应 GuideSection.href——
   将来新增页面进 NAV 时，漏写说明书直接红。
2. **sitemap ⊆ 说明书**：`app/sitemap.ts` 导出 `STATIC_PAGES` 同理断言——
   公开页都必须有说明。
3. id/href 唯一；每节 tagline 非空、what/how/read 每块至少一条。
4. i18n：渲染层字面量走 coverage 闸；guide.ts 数据键的译文完整性由
   dict/guide.ts 与页面消费共同保证（glossary 同款格局），dict 卫生四规则
   （空译文/假翻译/占位符/跨分片撞车）自动覆盖新分片。

## 页面渲染（app/guide/page.tsx）

client 组件 + useLang。结构：header（标题 + 定位 hint）→ 锚点目录
（分组网格，点击跳 `#id`）→ 逐节 section：`icon title` + 「打开 →」链接 +
tagline + 三小块（功能 / 怎么用 / 怎么读，read 块用 callout 视觉突出
口径警示）→ 页脚交叉引用（/glossary 名词表、GitHub README/docs）。
零新组件依赖，全部复用 ds-* 与既有布局习惯。

## 实施拆解（TDD，每任务一提交）

1. 本设计文档 + docs/README.md 索引与计数同步。
2. `app/guide.ts` 数据骨架 + `app/guide.test.ts`（先红：NAV/sitemap 覆盖、
   唯一性、非空）+ ui.tsx/sitemap.ts 两处 export；内容全量写入。
3. `/guide` 页面 + /manage 双入口 + i18n 分片 `dict/guide.ts`（coverage/
   dict 双闸；title 复用 NAV label 既有键，新键先 grep 防撞车）。
4. CHANGELOG 批次条目 + Scope 行刷新。README roadmap 不动（站内说明页
   不是 roadmap 项）；docs/api-access.md 不动（无对外端点）。

## 不动的东西

各板块页面零改动（说明书只引用不重构）；NAV/sitemap 不加 /guide（入口
先只在 /manage，转正另行裁决）；glossary 保持名词层职责不合并。
