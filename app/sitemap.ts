import type { MetadataRoute } from "next";
import { openDb } from "../lib/db";
import {
  siteBase,
  sitemapMarketEntries,
  sitemapWalletEntries,
} from "../lib/seo";

// 站点地图从活库生成(质量门见 lib/seo):构建期没有生产库,必须请求时算。
export const dynamic = "force-dynamic";

// 静态页的先验优先级:首页/策略中心是主落地页。
const STATIC_PAGES: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  { path: "/follow", priority: 0.9 },
  { path: "/consensus", priority: 0.8 },
  { path: "/accumulation", priority: 0.7 },
  { path: "/discovery", priority: 0.7 },
  { path: "/alerts", priority: 0.6 },
  { path: "/glossary", priority: 0.6 },
  { path: "/status", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteBase();
  const nowSec = Math.floor(Date.now() / 1000);
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  const wallets = sitemapWalletEntries(db, base, nowSec);
  const markets = sitemapMarketEntries(db, base, nowSec);
  return [
    ...STATIC_PAGES.map((p) => ({
      url: `${base}${p.path === "/" ? "" : p.path}` || base,
      priority: p.priority,
      changeFrequency: "hourly" as const,
    })),
    ...markets.map((e) => ({
      ...e,
      changeFrequency: "hourly" as const,
      priority: 0.5,
    })),
    ...wallets.map((e) => ({
      ...e,
      changeFrequency: "daily" as const,
      priority: 0.4,
    })),
  ];
}
