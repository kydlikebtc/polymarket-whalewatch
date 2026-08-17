// 双语化核心(同构零依赖):中文原文即字典键。
//
// 机制(设计文档 2026-08-17-i18n-design.md):t("已结算胜率") 在 zh 下原样
// 返回,在 en 下查字典,**缺译回退中文** —— 永不空串,覆盖率可增量补齐。
// 带变量模板走占位符:t("共 {n} 笔", { n }),中英模板都做插值。
export type Lang = "zh" | "en";

export const LANG_COOKIE = "ww_lang";

export type TParams = Record<string, string | number>;

export function interpolate(tpl: string, params?: TParams): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in params ? String(params[k]) : m,
  );
}

export function translate(
  dict: Record<string, string>,
  lang: Lang,
  zh: string,
  params?: TParams,
): string {
  const tpl = lang === "en" ? (dict[zh] ?? zh) : zh;
  return interpolate(tpl, params);
}

/**
 * 语言判定:cookie 显式值优先;首访无 cookie 按 Accept-Language ——
 * en 排在 zh 前面(或没有 zh)才选 en,其余一律 zh(现有受众默认)。
 */
export function pickLang(
  cookieVal: string | undefined,
  acceptLanguage: string | null | undefined,
): Lang {
  if (cookieVal === "en" || cookieVal === "zh") return cookieVal;
  const al = (acceptLanguage ?? "").toLowerCase();
  const iEn = al.indexOf("en");
  const iZh = al.indexOf("zh");
  if (iEn >= 0 && (iZh < 0 || iEn < iZh)) return "en";
  return "zh";
}
