import type { DB } from "./db";

// 事件分类的批量查询。原本是 signalFeed 的私有函数,2026-08-19 提出来共用:
// bus[] 补分类字段时需要**逐字相同**的口径 —— 两份实现意味着同一个事件在
// active[] 和 bus[] 里可能给出不同的分类,那种不一致最难被发现。

export interface EventCategory {
  category: string | null;
  subcategory: string | null;
}

/**
 * 按 eventSlug 批量取分类。一次 IN 查询,不是逐条点查。
 *
 * category 保留历史行为(原样透传,'' 哨兵极少见且已发布);subcategory 是
 * 新字段,'' known-none 直接归一成 null —— 对外永远只有「有值/无」两态。
 */
export function categoriesFor(
  db: DB,
  slugs: (string | null | undefined)[],
): Record<string, EventCategory> {
  const out: Record<string, EventCategory> = {};
  const uniq = [...new Set(slugs.filter((s): s is string => !!s))];
  if (uniq.length === 0) return out;
  const placeholders = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT event_slug, category, subcategory FROM event_category WHERE event_slug IN (${placeholders})`,
    )
    .all(...uniq) as {
    event_slug: string;
    category: string | null;
    subcategory: string | null;
  }[];
  for (const r of rows) {
    out[r.event_slug] = {
      category: r.category,
      subcategory: r.subcategory || null,
    };
  }
  return out;
}
