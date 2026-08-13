// 分类展示标签(client-safe 纯映射,无任何依赖)。catLabel 原在 app/ui.tsx,
// 二级分类上线(2026-08-13)把它连同新的 subLabel/catLabelFine 一起提到
// lib/ —— 与 followCardView 同一理由:app/ 下没有组件测试基建,合成规则
// (去重/空值)是可测纯逻辑;ui.tsx re-export 保持既有调用方 import 面不变。
// 派生侧(哪个标签算二级)在 lib/gamma.ts SUBCATEGORIES;这里只管译中与合成。

// Chinese display names for the gamma tag taxonomy; unknown labels pass
// through as-is (the taxonomy grows over time).
const CATEGORY_ZH: Record<string, string> = {
  Politics: "政治",
  Elections: "选举",
  Sports: "体育",
  Esports: "电竞",
  Crypto: "加密",
  Economy: "经济",
  Finance: "金融",
  Business: "商业",
  Tech: "科技",
  Science: "科学",
  "Pop Culture": "文娱",
  Culture: "文娱",
  World: "国际",
  Weather: "天气",
  Games: "游戏",
};

// 二级分类译中。拉丁缩写(NBA/NFL/MLB/…)本身就是中文语境下的通用名,
// 不译;未知条目透传(与 CATEGORY_ZH 同一纪律)。键集合与 lib/gamma.ts
// SUBCATEGORIES 白名单同源维护 —— 白名单加条目时这里补译名。
const SUBCATEGORY_ZH: Record<string, string> = {
  Soccer: "足球",
  Tennis: "网球",
  Golf: "高尔夫",
  Boxing: "拳击",
  MMA: "综合格斗",
  "Formula 1": "F1",
  Cricket: "板球",
  Rugby: "橄榄球",
  "College Football": "大学橄榄球",
  "College Basketball": "大学篮球",
  Esports: "电竞",
  "League of Legends": "英雄联盟",
  Valorant: "无畏契约",
  Bitcoin: "比特币",
  Ethereum: "以太坊",
  Dogecoin: "狗狗币",
  Geopolitics: "地缘政治",
};

// null/"" → 其他 (unknown category bucket).
export function catLabel(category: string | null | undefined): string {
  if (!category) return "其他";
  return CATEGORY_ZH[category] ?? category;
}

/** 二级标签译中;未知透传。空值调用方自行处理(catLabelFine 已含)。 */
export function subLabel(subcategory: string): string {
  return SUBCATEGORY_ZH[subcategory] ?? subcategory;
}

/**
 * 合成细粒度标签:「体育·NBA」「加密·比特币」。无二级 → 只一级;二级译名
 * 与一级相同(两个 EN 标签译到同一中文的撞车情形)→ 只显示一次。
 */
export function catLabelFine(
  category: string | null | undefined,
  subcategory: string | null | undefined,
): string {
  const primary = catLabel(category);
  if (!subcategory) return primary;
  const sub = subLabel(subcategory);
  return sub === primary ? primary : `${primary}·${sub}`;
}
