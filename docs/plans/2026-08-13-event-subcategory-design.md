# 事件二级分类(subcategory)— 设计

日期:2026-08-13。需求:深度分析面板上线后,一级分类太粗 —— 尤其体育,
NBA/NFL/足球/网球的胜率分布差异巨大,混在一个「体育」桶里没有解释力;
所有展示市场的地方标签同步升级。

## 1. 数据源实测(2026-08-13,gamma /events 24h 量前 40)

tags 数组**本来就带二级信息**,现有 `fetchEventCategories` 只取一级把它
扔掉了。两个决定实现方式的实测事实:

1. **标签顺序不可靠**:`mlb-*` 是 `['Sports','Games','MLB','baseball']`
   (主类在前),网球是 `['Tennis','Sports','Games']`(专名在前),
   UCL 是 `['UCL','Soccer','Sports','Champions League']`(联赛在前)。
   「取第一个非主类标签」会把 MLB 事件派生成 "Games"。
2. **噪音标签很多**:'Games'/'Weekly'/'Monthly'/'Recurring'/
   'Hide From New'/'Earn 4%'/'Multi Strikes' 等运营标签混在里面,
   黑名单挡不完(开放集合)。

→ 结论:**白名单 × 标签序扫描** —— 按 tags 顺序扫,命中精选
SUBCATEGORY 白名单的第一个标签即二级;无命中 = 无二级(诚实置空,
绝不落噪音)。联赛级标签(UCL/FA Cup/Leagues Cup)刻意不进白名单,
让它落到 'Soccer' —— 三级粒度在当前样本量下没有胜率解释力。

白名单(EN 原文,展示层译中):体育 NBA/WNBA/NFL/MLB/NHL/Soccer/
Tennis/Golf/Boxing/MMA/UFC/F1/Formula 1/Cricket/Rugby/College Football/
College Basketball;电竞 Esports/CS2/League of Legends/Dota 2/Valorant
(CS2 类事件 primary 是 Sports,专名标签通常在 Esports 前,单遍扫描
即取到最细的那个);加密 Bitcoin/Ethereum/Solana/XRP/Dogecoin;
政治 Geopolitics。其余垂类暂不设二级(YAGNI,税法随数据增长)。

## 2. 口径红线

- **一级分类的派生逻辑与取值一字不动**:admission 闸门/钱包画像类别
  集中度/首页筛选 chips/metrics.byCategory 全依赖它,动了就是重写
  历史口径。二级是**并行新增字段**,零回归。
- 二级派生跳过与一级同名的标签(如 labels=['Esports'] 一级已是
  Esports,二级不再重复)。
- 展示合成标签 `catLabelFine`:「体育·NBA」「加密·比特币」;无二级或
  二级译名与一级相同 → 只显示一级。

## 3. 缓存与迁移(懒回填,无一次性脚本)

`event_category` 加列 `subcategory TEXT`(既有 try/catch ALTER 惯例)。
三态语义:**NULL = 老缓存行尚未按新税法回填**,'' = 已抓取但无二级,
其余 = 二级标签 EN 原文。`getEventCategories` 读缓存时
`subcategory IS NULL` 视为 miss 重抓该 slug —— 老缓存随访问自动升级,
fetched_at 同步刷新;'' 行不重抓(known-none 与一级同一纪律)。

## 4. 接口形状(不留双轨)

`fetchEventCategories` / `getEventCategories` 返回值升级为
`Record<slug, { category, subcategory }>`(fetcher 注入形状同步升级,
'' 哨兵语义不变)。**4 个调用方一起改**:/api/scan、/api/consensus、
/api/follow、/api/wallet;signalFeed 直读表,SELECT 加列。
不新造 getEventTaxonomy 双轨接口(以复用现有为荣)。

## 5. 更新面清单(「所有有市场的地方」逐一核对)

| 面                     | 改动                                                | 一级保持处                     |
| ---------------------- | --------------------------------------------------- | ------------------------------ |
| 首页扫描表             | 行内 chip → catLabelFine                            | 筛选 chips 仍按一级(≤8 个不爆) |
| 共识页分组             | chip → catLabelFine                                 | —                              |
| 分歧区块               | chip → catLabelFine                                 | —                              |
| 钱包档案页             | 市场行 → catLabelFine                               | 类别集中度聚合仍按一级         |
| 策略中心               | 行级 attach {category,subcategory}                  | metrics.byCategory 键不变      |
| 深度分析·赛道细分      | **两级渲染**:一级汇总行 + 缩进子行                  | 桶级 n<5 弱化沿用              |
| /api/signals 公开 feed | 加 subcategory 字段(additive) + signals-api.md 文档 | category 字段不变              |
| Telegram 推送          | 不涉及(实测推送文案不含分类)                        | —                              |

## 6. 代码组织

- `lib/categoryLabel.ts`(新,client-safe):catLabel 自 ui.tsx 移入 +
  SUBCATEGORY_ZH + subLabel + catLabelFine,可测;ui.tsx re-export
  保持 5 个调用方 import 面不变。
- `lib/gamma.ts`:白名单 + 派生 + 缓存懒回填。
- `lib/followAnalysis.ts`:categories 升级为
  `CategoryGroup{一级汇总, subs: 子行[]}`(面板未发布,无兼容包袱)。

## 7. 测试

gamma:MLB 噪音序/专名先序/UCL→Soccer/与一级同名跳过/无命中 ''/
懒回填(NULL 行重抓、'' 行不重抓、抓完两列都写);categoryLabel:
译名/透传/去重/空值;followAnalysis:两级分组与排序;follow:行级
attach;signalFeed:字段透传。
