import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { openDb } from "../../../lib/db";
import {
  buildWalletSeoSummary,
  isValidWalletAddress,
  siteBase,
  type WalletSeoSummary,
} from "../../../lib/seo";
import { usdCompact } from "../../../lib/xComposer";
import WalletDossierClient from "./WalletDossierClient";

// 服务端 SEO 层(设计文档 2026-08-17-seo-geo-design.md):generateMetadata +
// 「已结算快照」摘要条,数据只读本地 SQLite —— 红线:此文件严禁触发上游
// 请求(实时档案由下方客户端组件照旧走 /api/wallet)。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ address: string }>;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function signedUsd(n: number): string {
  return `${n >= 0 ? "+" : ""}${usdCompact(n)}`;
}

function summarize(address: string): WalletSeoSummary {
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  return buildWalletSeoSummary(db, address, Math.floor(Date.now() / 1000));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  if (!isValidWalletAddress(address)) {
    return { robots: { index: false, follow: false } };
  }
  const s = summarize(address);
  const bits: string[] = [];
  if (s.winRatePct != null)
    bits.push(`${Math.round(s.winRatePct)}% settled win rate`);
  if (s.realizedPnlUsd != null)
    bits.push(`${signedUsd(s.realizedPnlUsd)} realized PnL`);
  if (s.settledCount != null) bits.push(`${s.settledCount} settled positions`);
  if (s.alerts30d > 0) bits.push(`${s.alerts30d} whale alerts in 30d`);
  return {
    title: `Wallet ${shortAddr(s.address)} — Polymarket track record`,
    description:
      bits.length > 0
        ? `Polymarket wallet ${s.address}: ${bits.join(" · ")}. Live dossier with odds bands, category focus and split-buy tendency.`
        : `Polymarket wallet ${s.address}: live dossier with current holdings, odds bands, category focus and split-buy tendency.`,
    // 小写 canonical 收敛大小写重复收录;薄页(本地无数据)noindex。
    alternates: { canonical: `/wallet/${s.address}` },
    ...(s.hasData ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function Page({ params }: Props) {
  const { address } = await params;
  if (!isValidWalletAddress(address)) notFound();
  const s = summarize(address);
  const base = siteBase();
  const breadcrumb = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "WhaleWatch", item: base },
      {
        "@type": "ListItem",
        position: 2,
        name: `Wallet ${shortAddr(s.address)}`,
        item: `${base}/wallet/${s.address}`,
      },
    ],
  });
  const zhBits: string[] = [];
  if (s.winRatePct != null)
    zhBits.push(`已结算胜率 ${Math.round(s.winRatePct)}%`);
  if (s.realizedPnlUsd != null)
    zhBits.push(`净盈亏 ${signedUsd(s.realizedPnlUsd)}`);
  if (s.settledCount != null) zhBits.push(`${s.settledCount} 仓已结算`);
  if (s.roiPct != null)
    zhBits.push(`ROI ${s.roiPct >= 0 ? "+" : ""}${Math.round(s.roiPct)}%`);
  if (s.isWhitelist)
    zhBits.push(
      s.score != null ? `🏆 白名单 · ${Math.round(s.score)} 分` : "🏆 白名单",
    );
  if (s.alerts30d > 0) zhBits.push(`近30天 ${s.alerts30d} 条告警`);
  if (s.firstSeenTs != null) {
    zhBits.push(
      `首活跃 ${new Date(s.firstSeenTs * 1000).toISOString().slice(0, 7)}`,
    );
  }
  return (
    <>
      <script type="application/ld+json">{breadcrumb}</script>
      {s.hasData ? (
        // 已结算快照(服务端本地数据)—— 卡内：标题条 → 内容 → 灰色说明条，
        // 与档案页其余卡片同一语法。
        <section className="ds-main" style={{ paddingBottom: 0 }}>
          <div className="ds-card" style={{ overflow: "hidden" }}>
            <div className="card-bar">
              📌 已结算快照 · settled snapshot (local)
            </div>
            {/* 每一条快照事实是一枚灰底名称标签(Etherscan name tag)——
                emoji 只在标签内承担语义,不散在正文句子中间。 */}
            {zhBits.length > 0 ? (
              <div
                style={{
                  padding: "var(--s-4)",
                  display: "flex",
                  gap: "var(--s-2)",
                  flexWrap: "wrap",
                }}
              >
                {zhBits.map((b) => (
                  <span className="ds-tag" key={b}>
                    {b}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="note-strip">
              Polymarket wallet {s.address}
              {s.winRatePct != null && s.settledCount != null
                ? ` — ${Math.round(s.winRatePct)}% win rate over ${s.settledCount} settled positions`
                : ""}
              {s.realizedPnlUsd != null
                ? `, ${signedUsd(s.realizedPnlUsd)} realized PnL`
                : ""}
              . Live dossier below.
            </div>
          </div>
        </section>
      ) : null}
      <WalletDossierClient />
    </>
  );
}
