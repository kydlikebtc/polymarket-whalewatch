"use client";

// 档案页的自测判决块 —— **点击加载**(时光机「fetched only when a user
// clicks」先例):档案每次浏览不为判决多花 cost 3 计费,点了才取;取的
// 时候 walletStats 大概率已被档案本身焐热(共享 in-flight 去重 + 24h
// SQLite 缓存),边际上游成本≈0。
import { useState } from "react";
import { useLang } from "../../i18n";
import { SelfTestVerdictCard } from "../../selfTestCard";
import type { SelfTestResponse } from "../../../lib/selfTest";

export default function SelfTestBlock({ address }: { address: string }) {
  const { t } = useLang();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [data, setData] = useState<SelfTestResponse | null>(null);
  const [error, setError] = useState<string>("");

  const load = async () => {
    setState("loading");
    try {
      const res = await fetch(`/api/selftest/${address}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as SelfTestResponse);
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };

  return (
    // 档案页最后一段 —— 设计稿末卡是一条「徽章 + 一句话 + 右侧动作」的横条。
    // id 供页内分区导航锚点跳转。
    <section id="wallet-selftest" style={{ marginTop: "var(--s-5)" }}>
      <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
        🏆 {t("聪明钱自测判决")}
      </div>
      {state === "done" && data ? (
        <>
          {/* 口径条在数据前面:限流/上游故障是需留神的口径,走琥珀。 */}
          {data.degraded ? (
            <div
              className="ds-callout ds-callout--warn"
              style={{ marginBottom: "var(--s-3)" }}
            >
              {data.degraded === "rate_limited"
                ? t(
                    "⏳ 实时体检被限流（公共接口预算已满）——先展示本地留存判决。",
                  )
                : t("⚠️ 上游接口暂时不可用——先展示本地留存判决。")}
            </div>
          ) : null}
          <SelfTestVerdictCard data={data} />
        </>
      ) : (
        <div
          className="ds-card"
          style={{
            padding: "14px var(--s-4)",
            display: "flex",
            gap: "var(--s-3)",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span className="ds-hint" style={{ flex: "1 1 320px" }}>
            {t(
              "按池准入口径给这份战绩一个判决：过没过闸、池内百分位、可分享判决卡。点击加载。",
            )}
          </span>
          {state === "error" ? (
            <span className="down" style={{ fontSize: "var(--t-base)" }}>
              {t("加载失败")}: {error}
            </span>
          ) : null}
          <button
            className="ds-btn ds-btn--sm"
            style={{ marginLeft: "auto" }}
            disabled={state === "loading"}
            onClick={() => void load()}
          >
            {state === "loading"
              ? t("体检中…")
              : state === "error"
                ? t("立即重试")
                : t("加载判决")}
          </button>
        </div>
      )}
    </section>
  );
}
