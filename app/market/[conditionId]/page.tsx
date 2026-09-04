import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { openDb } from "../../../lib/db";
import {
  buildMarketSeoSummary,
  isValidConditionId,
  siteBase,
  type MarketSeoSummary,
} from "../../../lib/seo";
import { usdCompact } from "../../../lib/xComposer";
import MarketCardClient from "./MarketCardClient";

// 服务端 SEO 层 —— 与 /wallet/[address]/page.tsx 同构(红线同:只读本地
// SQLite,实时市场卡由客户端组件照旧走 /api/market)。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ conditionId: string }>;
}

function shortCid(c: string): string {
  return `${c.slice(0, 10)}…`;
}

function summarize(conditionId: string): MarketSeoSummary {
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  return buildMarketSeoSummary(db, conditionId, Math.floor(Date.now() / 1000));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { conditionId } = await params;
  if (!isValidConditionId(conditionId)) {
    return { robots: { index: false, follow: false } };
  }
  const s = summarize(conditionId);
  const name = s.title ?? `Market ${shortCid(s.conditionId)}`;
  const bits: string[] = [];
  if (s.alerts30d > 0) {
    bits.push(
      `${s.alerts30d} whale/consensus alerts totaling ${usdCompact(s.alertUsd30d)} in 30d`,
    );
  }
  if (s.outcomes.length > 0 && s.outcomePrices.length > 0) {
    bits.push(
      `current odds ${s.outcomes[0]} ${Math.round(s.outcomePrices[0] * 100)}¢`,
    );
  }
  if (s.consensus.length > 0) {
    bits.push(
      `smart-money consensus on ${s.consensus[0].outcome} (${s.consensus[0].walletCount} wallets)`,
    );
  }
  return {
    title: `${name.length > 70 ? `${name.slice(0, 69)}…` : name} — smart-money flow`,
    description:
      bits.length > 0
        ? `Smart-money view of "${name}" on Polymarket: ${bits.join(" · ")}.`
        : `Smart-money view of "${name}" on Polymarket: whale fills, consensus state and flow leaderboard.`,
    alternates: { canonical: `/market/${s.conditionId}` },
    ...(s.hasData ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function Page({ params }: Props) {
  const { conditionId } = await params;
  if (!isValidConditionId(conditionId)) notFound();
  const s = summarize(conditionId);
  const base = siteBase();
  const name = s.title ?? `Market ${shortCid(s.conditionId)}`;
  const breadcrumb = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "WhaleWatch", item: base },
      {
        "@type": "ListItem",
        position: 2,
        name,
        item: `${base}/market/${s.conditionId}`,
      },
    ],
  });
  const zhBits: string[] = [];
  if (s.category) zhBits.push(s.category);
  if (s.closed != null) zhBits.push(s.closed ? "已结算" : "进行中");
  if (s.alerts30d > 0) {
    zhBits.push(
      `近30天 ${s.alerts30d} 条告警 · 合计 ${usdCompact(s.alertUsd30d)}`,
    );
  }
  if (s.volume24hUsd != null)
    zhBits.push(`24h 量 ${usdCompact(s.volume24hUsd)}`);
  if (s.liquidityUsd != null)
    zhBits.push(`流动性 ${usdCompact(s.liquidityUsd)}`);
  for (const c of s.consensus.slice(0, 2)) {
    zhBits.push(
      `🔥 ${c.walletCount} 个聪明钱共识买 ${c.outcome}(${usdCompact(c.totalUsd)})`,
    );
  }
  return (
    <>
      <script type="application/ld+json">{breadcrumb}</script>
      <MarketCardClient />
      {s.hasData ? (
        // 服务端快照 —— 给爬虫的本地只读摘要,渲染在客户端卡片**之后**
        // (与 /wallet/[address] 同一处理):页壳的第一件事是页头,页头之上
        // 不能先冒出一张卡。视觉上刻意收成一条灰色说明条:它与上面的页头讲
        // 同一个市场,做成白卡就会有两个同等分量的标题在打架(层级来自分格
        // 线,不来自字号)。
        <section className="ds-main" style={{ paddingTop: 0 }}>
          <div className="ds-callout" style={{ display: "grid", gap: 4 }}>
            <div className="ds-label">市场快照 · market snapshot (local)</div>
            <div style={{ color: "var(--ww-text)", overflowWrap: "anywhere" }}>
              {name}
            </div>
            {zhBits.length > 0 ? <div>{zhBits.join(" · ")}</div> : null}
          </div>
        </section>
      ) : null}
    </>
  );
}
