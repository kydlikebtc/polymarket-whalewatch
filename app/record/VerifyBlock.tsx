"use client";

import { useState } from "react";
import {
  parseRecordCsv,
  verifyDigestDays,
  webcryptoSha256Hex,
  type VerifyDigest,
  type VerifySummary,
} from "../../lib/digestVerify";

// 「自己验一遍」按钮 —— 存证链从「理论上可验证」变成一次点击。
//
// 全部计算在**读者的浏览器里**跑:拉公开 CSV(已发布信号逐行,含 signal_id)
// 与本页已有的 digests[],用 WebCrypto 逐日复算 sha256 链,和公布值比。
// 服务端零参与 —— 这一点本身就是论证的一部分:一个由被验证方跑的验证器
// 什么也证明不了。同理,判定逻辑与生成侧共用 lib/digestPreimage,不另写一份。
//
// 不默认执行:全量 CSV 对一个只是路过看战绩的读者是白花的流量。

const ICON: Record<string, string> = {
  ok: "✅",
  tampered: "❌",
  "missing-rows": "❌",
  "extra-rows": "⚠️",
};

const NOTE: Record<string, string> = {
  ok: "相符",
  tampered: "内容与公布值不符",
  "missing-rows": "导出里的行少于摘要记录 —— 有行被删掉了",
  "extra-rows": "导出里的行多于摘要记录 —— 多为摘要算完后才投递成功",
};

export default function VerifyBlock({ digests }: { digests: VerifyDigest[] }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState(0);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/dataset/record.csv");
      if (!res.ok) throw new Error(`拉取 CSV 失败:HTTP ${res.status}`);
      const rows = parseRecordCsv(await res.text());
      setRowCount(rows.length);
      setResult(await verifyDigestDays(rows, digests, webcryptoSha256Hex));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (digests.length === 0) return null;

  return (
    <details
      className="ds-card"
      style={{ marginTop: "var(--s-4)", padding: "var(--s-3) var(--s-4)" }}
    >
      <summary style={{ cursor: "pointer", fontSize: "var(--t-md)" }}>
        自己验一遍存证链
      </summary>
      <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
        {
          "在你的浏览器里跑:拉公开 CSV,按 id 升序逐日复算 sha256 链,和本页公布的摘要比对。服务端不参与计算 —— 由被验证方跑的验证器证明不了任何事。"
        }
      </div>
      <div style={{ marginTop: "var(--s-3)" }}>
        <button className="ds-btn ds-btn--sm" onClick={run} disabled={busy}>
          {busy ? "复算中…" : `复算最近 ${digests.length} 天`}
        </button>
        <span className="ds-hint" style={{ marginLeft: "var(--s-3)" }}>
          {"或在命令行:"}
          <code>npx tsx scripts/verify-digest.ts</code>
        </span>
      </div>

      {error && (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginTop: "var(--s-3)", overflowWrap: "anywhere" }}
        >
          {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: "var(--s-3)" }}>
          {/* 设计系统只有 中性/琥珀/红 三档,没有绿档 —— 「验过了」是一个
              事实不是一场胜利,✅ 已经说完了。红只留给真正要报的那三种:
              内容不符 / 导出缺行 / 断链。 */}
          <div
            className={
              result.tampered + result.missingRows + result.brokenLinks > 0
                ? "ds-callout ds-callout--error"
                : result.extraRows > 0
                  ? "ds-callout ds-callout--warn"
                  : "ds-callout"
            }
          >
            {result.allOk
              ? `✅ ${result.days.length} 天全部相符(导出 ${rowCount} 条已发布信号)`
              : `相符 ${result.ok} · 内容不符 ${result.tampered} · 导出缺行 ${result.missingRows} · 导出多行 ${result.extraRows} · 断链 ${result.brokenLinks}`}
          </div>
          <div style={{ marginTop: "var(--s-3)", overflowX: "auto" }}>
            <table className="ds-table">
              <thead>
                <tr>
                  <th>UTC 日</th>
                  <th className="is-right" title="该日进入摘要的已发布信号条数">
                    条数
                  </th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {result.days.map((d) => (
                  <tr key={d.day}>
                    <td style={{ whiteSpace: "nowrap" }}>{d.day}</td>
                    <td className="is-right" data-label="条数">
                      {d.exportCount === d.digestCount
                        ? d.digestCount
                        : `${d.digestCount} / ${d.exportCount}`}
                    </td>
                    <td data-label="结果">
                      {ICON[d.status]} {NOTE[d.status]}
                      {d.linked === false && " · ⛓️‍💥 前链接不上"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="note-strip" style={{ marginTop: "var(--s-3)" }}>
        {
          "「导出多行」通常是良性的:摘要算完之后那条信号才投递成功。摘要自 2026-09-07 起改在 06:00 UTC 结算(过了投递补发窗口,成员集已冻结),此后不该再出现这一类。"
        }
      </div>
    </details>
  );
}
