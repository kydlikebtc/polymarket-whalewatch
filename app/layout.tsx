import type { ReactNode } from "react";
import "./globals.css";
import { TopNav } from "./ui";

export const metadata = {
  title: "Polymarket 大额成交监控",
  description: "只读监控面板：Polymarket 24h 大额成交扫描 + 实时告警",
};

// Mobile-first: render at device width so the responsive rules in globals.css
// (stacked-card tables, etc.) actually engage instead of a zoomed-out desktop.
export const viewport = {
  width: "device-width",
  initialScale: 1,
};

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
      </head>
      <body>
        <TopNav />
        {children}
      </body>
    </html>
  );
}
