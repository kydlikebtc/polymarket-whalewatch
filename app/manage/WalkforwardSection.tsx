"use client";

import { useEffect, useState } from "react";
import type { WalkforwardReport } from "../../lib/walkforward";
import { SectionHead } from "./bits";
import { sectionView } from "./sectionGate";
import { authHeaders } from "./shared";
import { reportMeta, tierLine } from "./walkforwardView";

// 区块:🧪 阈值重推(walk-forward 报告摘要,2026-08-28,设计见 docs/plans/
// 2026-08-28-walkforward-rederivation-design.md §6.2)。
//
// 只展示,不做一键建档:报告的产出是运营者手动跑 scripts/walkforward.ts,
// 「按报告开挑战者档」仍走本 tab 既有的档位管理手工路径(复制建议参数)——
// 一键化留给报告价值被验证之后。报告数据在 walkforward_reports 表,本区块
// 挂载时拉最新一行;没有报告是一等状态(给出确切命令)。

interface LatestReport {
  id?: number;
  createdAt?: number;
  report: WalkforwardReport | null;
}

export default function WalkforwardSection({ token }: { token: string }) {
  const [data, setData] = useState<LatestReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/admin/walkforward", {
          headers: authHeaders(token),
        });
        const body = (await res.json()) as LatestReport & { error?: string };
        if (!alive) return;
        if (!res.ok) {
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        setData(body);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  const view = sectionView(data, error);
  return (
    <section
      className="ds-card"
      style={{ padding: "var(--s-5)", marginBottom: "var(--s-5)" }}
    >
      <SectionHead
        title="🧪 阈值重推(walk-forward)"
        hint="30 天闸门后的月度节律:对厚档做收紧/平移方向的网格×子集选择,三道显著性闸(聚类 CI + Bonferroni + 方向随机化)。报告只给建议 —— 绝不自动改任何存量档参数;采纳=在上方档位管理手工建挑战者档(名称加 ·t26 类标记,push 保持关,静默跑满一个月再评)。"
      />
      {view.kind === "loading" && <div className="ds-hint">加载中…</div>}
      {view.kind === "error" && (
        <div className="ds-hint" style={{ color: "var(--warn, #b45309)" }}>
          加载失败:{view.message}
        </div>
      )}
      {view.kind === "ready" &&
        (view.data.report == null ? (
          <div className="ds-hint">
            还没有任何报告。在服务器上对生产库(或每日快照)执行:
            <code className="mono" style={{ margin: "0 var(--s-2)" }}>
              npx tsx scripts/walkforward.ts [dbPath]
            </code>
            报告落库后此处自动显示最新一次。
          </div>
        ) : (
          <>
            <div className="ds-hint mono" style={{ marginBottom: "var(--s-3)" }}>
              {reportMeta({
                createdAt: view.data.createdAt ?? 0,
                report: view.data.report,
              })}
            </div>
            <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
              {view.data.report.tiers.map((t) => (
                <li
                  key={t.strategyId}
                  className="ds-hint"
                  style={{ marginBottom: "var(--s-2)" }}
                >
                  {tierLine(t)}
                </li>
              ))}
            </ul>
            <div className="ds-hint muted" style={{ marginTop: "var(--s-3)" }}>
              可观测锥:本报告只能回放收紧方向(原始流未归档);放松方向的唯一
              诚实做法是开更松的挑战者档向前跑。完整报告(逐折明细/落选格账本/
              固定诚实段落)在 walkforward_reports 表的 report_json。
            </div>
          </>
        ))}
    </section>
  );
}
