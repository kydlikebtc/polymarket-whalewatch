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

const GREEN = "#3fb950";
const RED = "#f85149";
const DIM = "#8b949e";

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
        backgroundColor: "#0b1220",
        color: "#e6edf3",
        padding: 48,
        fontSize: 28,
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
          🐳 WhaleWatch — Weekly Report
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
            color: "#e6edf3",
          },
          {
            label: "Win rate",
            value: r.winRatePct != null ? `${Math.round(r.winRatePct)}%` : "—",
            color: "#e6edf3",
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
              backgroundColor: "#161b26",
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
                fontWeight: 700,
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
              borderBottom: i < top.length - 1 ? `1px solid #21262d` : "none",
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
