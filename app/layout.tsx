import type { ReactNode } from "react";
import Link from "next/link";

export const metadata = {
  title: "Polymarket 大额成交监控",
  description: "只读监控面板：Polymarket 24h 大额成交扫描 + 实时告警",
};

const navWrap: React.CSSProperties = {
  borderBottom: "1px solid #1c2230",
  background: "#0b0e14",
};
const navInner: React.CSSProperties = {
  maxWidth: 1100,
  margin: "0 auto",
  padding: "12px 20px",
  display: "flex",
  gap: 20,
  alignItems: "center",
};
const navLink: React.CSSProperties = {
  color: "#8aa0c0",
  textDecoration: "none",
  fontSize: 14,
  fontWeight: 600,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          background: "#0b0e14",
          color: "#e6e6e6",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        <nav style={navWrap}>
          <div style={navInner}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#e6e6e6" }}>
              🐋 Polymarket 监控
            </span>
            <Link href="/" style={navLink}>
              24h 扫描
            </Link>
            <Link href="/alerts" style={navLink}>
              实时告警
            </Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
