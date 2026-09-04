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
    <main className="ds-main">
      {/* 页头区 —— 12px 小标(emoji 前缀)+ 24/600 标题 + 14px 描述 + 右侧动作 */}
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">
            {t("📐 按池准入口径的战绩体检")}
          </div>
          <h1 className="page-head__title">{t("聪明钱自测")}</h1>
          <p className="page-head__desc">
            {t(
              "把你的钱包放进本站同一把尺子：过没过闸、在池成员里排第几、一张可分享的判决卡。",
            )}
          </p>
        </div>
        <div className="page-head__actions">
          <a className="ds-btn" href="#selftest-basis">
            {t("口径声明")}
          </a>
        </div>
      </header>

      {/* 口径条 —— 统计声明放在数据前面,不放脚注。本页可信度底线,砍谁不能砍它。 */}
      <div
        id="selftest-basis"
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-5)" }}
      >
        {t(
          "口径声明：这是按本站池准入口径的战绩体检，不是资质认证，也不是投资建议。样本 = Polymarket 公开接口可见的已结算持仓（最多约 1000 仓，超出即截断、判决降级「样本不可判」）；分位样本 = 本站当前池成员（按本站口径挑选，非全体交易者）。",
        )}
      </div>

      {/* 44px 自测输入 —— 地址框与提交钮同框(设计稿 SearchField md2 尺寸)。
          设计稿把输入做成页头下的一条独立带,底边 1px 与下方判决卡分家。 */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(input);
        }}
        style={{
          paddingBottom: "var(--s-5)",
          marginBottom: "var(--s-5)",
          borderBottom: "1px solid var(--ww-border)",
        }}
      >
        {/* 让 input 自己承担外框、圆角与聚焦反馈,按钮绝对定位压在框内右侧
            (四边各让 4px、圆角 6)—— 与 app/market/page.tsx 的 48px 搜索框
            同一个做法。反面教材是「外层 div 画边框 + 内层 input border:0」:
            那样 .ds-input:focus 的 border-color 完全失效,而 --ring-focus
            (0 0 0 3px)会按 input 自己的直角画一圈浅蓝,把外框左侧的 8px
            圆角填平并溢出去。现在焦点环框住整只 44px 框,形状与设计稿一致。 */}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            maxWidth: 660,
          }}
        >
          <input
            className="ds-input ds-input--mono"
            style={{
              width: "100%",
              minWidth: 0,
              height: 44,
              // 右侧留出按钮的位置:中文「领取判决书」约 102px、
              // 英文「Get the verdict」约 137px,取 148 留余量。
              padding: "0 148px 0 14px",
            }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("0x 开头的 Polymarket 钱包地址")}
            spellCheck={false}
            autoComplete="off"
          />
          {/* 全页唯一主按钮 */}
          <button
            type="submit"
            className="ds-btn ds-btn--primary"
            disabled={loading}
            style={{
              position: "absolute",
              right: 4,
              top: 4,
              bottom: 4,
              // .ds-btn 自带 height:32,这里由 top/bottom 撑成 36。
              height: "auto",
              padding: "0 16px",
              borderRadius: "var(--r-sm)",
              fontSize: "var(--t-md)",
            }}
          >
            {loading ? t("体检中…") : t("领取判决书")}
          </button>
        </div>
      </form>

      {invalid ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-5)" }}
        >
          {t("地址格式不对——应为 0x 开头的 42 位十六进制。")}
        </div>
      ) : null}

      {error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{
            marginBottom: "var(--s-5)",
            display: "flex",
            alignItems: "center",
            gap: "var(--s-3)",
            flexWrap: "wrap",
          }}
        >
          <span style={{ flex: "1 1 260px", minWidth: 0 }}>
            {t("加载失败")}: {error}
          </span>
          <button className="ds-btn ds-btn--sm" onClick={() => void run(input)}>
            {t("立即重试")}
          </button>
        </div>
      ) : null}

      {data?.degraded && !error ? (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginBottom: "var(--s-5)" }}
        >
          {data.degraded === "rate_limited"
            ? t("⏳ 实时体检被限流（公共接口预算已满）——先展示本地留存判决。")
            : t("⚠️ 上游接口暂时不可用——先展示本地留存判决。")}
          {retryLeft != null && retryLeft > 0 ? (
            <> {t("{n}s 后自动重试", { n: retryLeft })}</>
          ) : null}
        </div>
      ) : null}

      {data && !error ? <SelfTestVerdictCard data={data} /> : null}

      {/* 等待态与空态都给内容和出路 —— 这两块永不返回 null */}
      {loading && !data ? (
        <div className="ds-empty">
          <div>{t("体检中…")}</div>
          <div style={{ marginTop: "var(--s-2)", fontSize: "var(--t-base)" }}>
            {t(
              "新地址首次体检要拉取全部已结算持仓，约需几秒；重测走 24 小时判决缓存，即时返回。",
            )}
          </div>
        </div>
      ) : null}

      {!data && !loading && !error && !invalid ? (
        <div className="ds-empty">
          <div>
            {t(
              "粘贴一个 0x 开头的钱包地址，按聪明钱池的准入口径领一份判决书。",
            )}
          </div>
          <div style={{ marginTop: "var(--s-3)" }}>
            <a className="ds-btn ds-btn--sm" href="/discovery">
              {t("先看看池内成员 →")}
            </a>
          </div>
        </div>
      ) : null}
    </main>
  );
}
