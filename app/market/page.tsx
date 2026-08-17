"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLang } from "../i18n";

// Landing for the single-market signal card: paste anything that identifies a
// market (Polymarket URL / market slug / conditionId) and jump. An event URL
// with several markets comes back as candidates to pick from.
export default function MarketLanding() {
  const router = useRouter();
  const { t } = useLang();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<
    { conditionId: string; question: string }[] | null
  >(null);

  const go = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError(null);
    setCandidates(null);
    try {
      const res = await fetch(
        `/api/market/resolve?input=${encodeURIComponent(input.trim())}`,
      );
      const j = (await res.json()) as {
        conditionId?: string;
        candidates?: { conditionId: string; question: string }[];
        error?: string;
      };
      if (j.conditionId) router.push(`/market/${j.conditionId}`);
      else if (j.candidates) setCandidates(j.candidates);
      else setError(j.error ?? "解析失败");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="ds-main" style={{ maxWidth: 720 }}>
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          {t("🎯 市场信号卡")}
        </h1>
        <div className="ds-hint">
          {t(
            "粘贴 Polymarket 市场链接 / market slug / conditionId——10 秒看清这个市场里聪明钱在做什么：共识/分歧状态、留存敞口、拆单累计、新钱包异常流、本工具告警战绩。",
          )}
        </div>
      </header>
      <div style={{ display: "flex", gap: "var(--s-2)" }}>
        <input
          className="ds-input"
          style={{ flex: 1 }}
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go();
          }}
          placeholder={t(
            "https://polymarket.com/event/… 或 market slug 或 0x…",
          )}
          aria-label={t("市场链接或 slug")}
        />
        <button className="ds-btn" onClick={() => void go()} disabled={busy}>
          {busy ? t("解析中…") : t("查看")}
        </button>
      </div>
      {error && (
        <div className="ds-callout" style={{ marginTop: "var(--s-3)" }}>
          {t(error)}
        </div>
      )}
      {candidates && (
        <section style={{ marginTop: "var(--s-4)" }}>
          <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
            {t("该事件包含 {n} 个市场，选择一个：", { n: candidates.length })}
          </div>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <tbody>
                {candidates.map((c) => (
                  <tr
                    key={c.conditionId}
                    style={{ cursor: "pointer" }}
                    onClick={() => router.push(`/market/${c.conditionId}`)}
                  >
                    <td>{c.question || c.conditionId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
