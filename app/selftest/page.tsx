"use client";

// /selftest 聪明钱自测落地页(设计文档 2026-08-28-smart-money-selftest-
// design.md):粘贴地址 → 按池准入口径领判决书。口径声明是本页可信度底线
// (与 /calibration 的选择偏差声明同风格),砍谁不能砍它。
// ?address= 直达自动跑 —— 分享出去的链接可复现同一份判决。
import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../i18n";
import { SelfTestVerdictCard } from "../selfTestCard";
import type { SelfTestResponse } from "../../lib/selfTest";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export default function SelfTestPage() {
  const { t } = useLang();
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SelfTestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryLeft, setRetryLeft] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const run = useCallback(async (raw: string) => {
    const addr = raw.trim().toLowerCase();
    if (!ADDRESS_RE.test(addr)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setError(null);
    setLoading(true);
    setRetryLeft(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    // 分享可复现:判决出来前就把地址写进 URL(replaceState 不污染历史)。
    window.history.replaceState(null, "", `/selftest?address=${addr}`);
    try {
      const res = await fetch(`/api/selftest/${addr}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SelfTestResponse;
      if (!mountedRef.current) return;
      setData(json);
      // 降级判决(限流/上游故障)按 retryAfterSec 倒计时自动重试实时层。
      if (json.degraded && json.retryAfterSec) {
        setRetryLeft(json.retryAfterSec);
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // ?address= 直达自动跑。只在挂载时读一次(client-only effect,SSR 首帧
  // 与服务端一致 → 无水合错位;app/urlQuery.ts 同一契约)。
  useEffect(() => {
    const addr = new URLSearchParams(window.location.search).get("address");
    if (addr && ADDRESS_RE.test(addr.trim().toLowerCase())) {
      setInput(addr.trim());
      void run(addr);
    }
  }, [run]);

  // 降级倒计时 → 到点自动重试(限流窗口定长 1 分钟,重试最终会过)。
  useEffect(() => {
    if (retryLeft == null) return;
    if (retryLeft <= 0) {
      if (data) void run(data.address);
      return;
    }
    timerRef.current = setTimeout(() => {
      if (mountedRef.current) setRetryLeft((v) => (v == null ? null : v - 1));
    }, 1000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [retryLeft, data, run]);

  return (
    <main className="ds-main" style={{ maxWidth: 760 }}>
      <header style={{ marginBottom: "var(--s-5)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", margin: 0 }}>
          {t("聪明钱自测")}
        </h1>
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          {t(
            "把你的钱包放进本站同一把尺子：粘贴地址，按聪明钱池的准入口径领一份战绩体检——过没过闸、在池成员里排第几、一张可分享的判决卡。",
          )}
        </div>
      </header>

      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-4)" }}
      >
        {t(
          "口径声明：这是按本站池准入口径的战绩体检，不是资质认证，也不是投资建议。样本 = Polymarket 公开接口可见的已结算持仓（最多约 1000 仓，超出即截断、判决降级「样本不可判」）；分位样本 = 本站当前池成员（按本站口径挑选，非全体交易者）。",
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(input);
        }}
        style={{
          display: "flex",
          gap: "var(--s-2)",
          flexWrap: "wrap",
          marginBottom: "var(--s-4)",
        }}
      >
        <input
          className="ds-input mono"
          style={{ flex: "1 1 340px" }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("0x 开头的 Polymarket 钱包地址")}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="submit"
          className="ds-btn ds-btn--primary"
          disabled={loading}
        >
          {loading ? t("体检中…") : t("领取判决书")}
        </button>
      </form>

      {invalid ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("地址格式不对——应为 0x 开头的 42 位十六进制。")}
        </div>
      ) : null}

      {loading ? (
        <div className="ds-hint" style={{ marginBottom: "var(--s-4)" }}>
          {t(
            "新地址首次体检要拉取全部已结算持仓，约需几秒；重测走 24 小时判决缓存，即时返回。",
          )}
        </div>
      ) : null}

      {error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-4)" }}
        >
          {t("加载失败")}: {error}
          <button
            className="ds-btn ds-btn--sm"
            style={{ marginLeft: 8 }}
            onClick={() => void run(input)}
          >
            {t("立即重试")}
          </button>
        </div>
      ) : null}

      {data?.degraded && !error ? (
        <div className="ds-callout" style={{ marginBottom: "var(--s-4)" }}>
          {data.degraded === "rate_limited"
            ? t("⏳ 实时体检被限流（公共接口预算已满）——先展示本地留存判决。")
            : t("⚠️ 上游接口暂时不可用——先展示本地留存判决。")}
          {retryLeft != null && retryLeft > 0 ? (
            <> {t("{n}s 后自动重试", { n: retryLeft })}</>
          ) : null}
        </div>
      ) : null}

      {data && !error ? <SelfTestVerdictCard data={data} /> : null}
    </main>
  );
}
