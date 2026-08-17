import type { MetadataRoute } from "next";
import { siteBase } from "../lib/seo";

// 环境可变(PUBLIC_URL),不许构建期冻结。
export const dynamic = "force-dynamic";

// GEO 第一信号:显式欢迎主流 AI 爬虫(它们各自匹配到自己的组后就只看
// 该组,所以 disallow 必须在每组重复)。/manage 本分支尚无,前瞻封禁。
const DISALLOW = ["/api/", "/manage"];
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "PerplexityBot",
  "Google-Extended",
  "meta-externalagent",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: DISALLOW },
      ...AI_CRAWLERS.map((userAgent) => ({
        userAgent,
        allow: "/",
        disallow: DISALLOW,
      })),
    ],
    sitemap: `${siteBase()}/sitemap.xml`,
  };
}
