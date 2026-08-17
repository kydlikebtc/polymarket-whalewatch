import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { TopNav } from "./ui";
import { siteBase } from "../lib/seo";

const BASE = siteBase();

// 英文主标题面向全球搜索/AI 受众(与 X 播报同一语言策略),description
// 尾部保留中文一句 —— 站内 UI 仍是中文,这里只换对外名片。
export const metadata: Metadata = {
  metadataBase: new URL(BASE),
  title: {
    default: "WhaleWatch — Polymarket Whale & Smart-Money Monitor",
    template: "%s | WhaleWatch",
  },
  description:
    "Real-time Polymarket whale trades, split-buy accumulation, fresh wallets and smart-money consensus — every alert validated with 1h/24h follow-through and settlement results. Polymarket 大额成交与聪明钱监控,信号全量验证。",
  alternates: { canonical: "/" },
  openGraph: {
    siteName: "WhaleWatch",
    type: "website",
    url: BASE,
  },
};

// Mobile-first: render at device width so the responsive rules in globals.css
// (stacked-card tables, etc.) actually engage instead of a zoomed-out desktop.
export const viewport = {
  width: "device-width",
  initialScale: 1,
};

// WebSite + Organization JSON-LD:全站结构化身份(GEO/富结果的最低配置,
// 更重的 schema 刻意不做 —— 预测市场无标准类型,错标不如少标)。
// 以 <script> 子节点渲染而非 dangerouslySetInnerHTML:内容是编译期常量,
// 且按构造不含 <>&(React 对子节点的转义不会破坏这份 JSON)。
const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${BASE}/#website`,
      url: BASE,
      name: "WhaleWatch",
      description:
        "Real-time Polymarket whale and smart-money monitoring with a public validation loop.",
      inLanguage: ["en", "zh-CN"],
    },
    {
      "@type": "Organization",
      "@id": `${BASE}/#org`,
      name: "WhaleWatch",
      url: BASE,
    },
  ],
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        {/* Fonts via <link> (not next/font) so the build never blocks on a
            network fetch and degrades gracefully to system fonts offline. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="icon" href="/favicon.ico" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script type="application/ld+json">{JSON_LD}</script>
      </head>
      <body>
        <TopNav />
        {children}
      </body>
    </html>
  );
}
