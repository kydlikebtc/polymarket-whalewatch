import { ImageResponse } from "next/og";
import { openDb } from "../../../../lib/db";
import { buildWeeklyReport } from "../../../../lib/xWeekly";
import { usdCompact } from "../../../../lib/xComposer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 周报成绩单图卡(1200×675,X 时间线 16:9)。数据全部来自 buildWeeklyReport
// (lib/xWeekly,已单测)—— 本路由零业务逻辑,只做排版。satori 排版约束:
// 只有 flexbox(无 grid),多子元素的 div 必须显式 display:flex。
// worker 的 maybeWeeklyPost 周一自取本路由的 PNG 再传 X。

// 配色跟站点本体走 Etherscan 风(app/globals.css 的 --ww-* 点值)。这张图
// 是白底 —— 全站唯一的深色面是代码面板,一张深底成绩单卡会在 X 时间线上
// 与站内、与 embed 卡三处都对不上。设计稿没出这张图(readme §9),但「配色
// 与站点同源」不需要出稿也能定。
const INK = "#081d35";
const GREEN = "#00a186";
const RED = "#dc3545";
const DIM = "#6c757d";
const LINE = "#e9ecef";
const WASH = "#f8f9fa";

function pnlColor(n: number): string {
  return n >= 0 ? GREEN : RED;
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${usdCompact(n)}`;
}

export async function GET() {
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  const r = buildWeeklyReport(db, Math.floor(Date.now() / 1000));
  const top = r.rows.slice(0, 5);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#fff",
        color: INK,
        padding: 48,
        fontSize: 28,
        fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", fontSize: 40, fontWeight: 700 }}>
          🐋 WhaleWatch — Weekly Report
        </div>
        <div style={{ display: "flex", color: DIM, fontSize: 30 }}>
          {r.weekLabel}
        </div>
      </div>

      <div style={{ display: "flex", gap: 48, marginTop: 40 }}>
        {[
          {
            label: "Settled positions",
            value: String(r.settled),
            color: INK,
          },
          {
            label: "Win rate",
            value: r.winRatePct != null ? `${Math.round(r.winRatePct)}%` : "—",
            color: INK,
          },
          {
            label: "Paper PnL",
            value: signed(r.pnlUsd),
            color: pnlColor(r.pnlUsd),
          },
        ].map((s) => (
          <div
            key={s.label}
            style={{
              display: "flex",
              flexDirection: "column",
              backgroundColor: WASH,
              border: `1px solid ${LINE}`,
              borderRadius: 16,
              padding: "24px 36px",
              flexGrow: 1,
            }}
          >
            <div style={{ display: "flex", color: DIM, fontSize: 24 }}>
              {s.label}
            </div>
            <div
              style={{
                display: "flex",
                fontSize: 56,
                fontWeight: 600,
                color: s.color,
                marginTop: 8,
              }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: 36,
          flexGrow: 1,
        }}
      >
        {top.map((row, i) => (
          <div
            key={row.name}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "12px 8px",
              borderBottom: i < top.length - 1 ? `1px solid ${LINE}` : "none",
              fontSize: 30,
            }}
          >
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <div style={{ display: "flex", color: DIM, width: 44 }}>
                {i + 1}.
              </div>
              <div style={{ display: "flex" }}>{row.nameEn}</div>
              <div style={{ display: "flex", color: DIM, fontSize: 24 }}>
                {row.settled} settled
              </div>
            </div>
            <div style={{ display: "flex", gap: 28 }}>
              <div style={{ display: "flex", color: pnlColor(row.pnlUsd) }}>
                {signed(row.pnlUsd)}
              </div>
              <div
                style={{
                  display: "flex",
                  color: row.roiPct != null ? pnlColor(row.roiPct) : DIM,
                  width: 150,
                  justifyContent: "flex-end",
                }}
              >
                {row.roiPct != null
                  ? `${row.roiPct >= 0 ? "+" : ""}${Math.round(row.roiPct * 10) / 10}% ROI`
                  : "—"}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          color: DIM,
          fontSize: 24,
        }}
      >
        <div style={{ display: "flex" }}>
          whalewatch.wired.fund — real data · simulated strategies
        </div>
        <div style={{ display: "flex" }}>Not financial advice</div>
      </div>
    </div>,
    { width: 1200, height: 675 },
  );
}
