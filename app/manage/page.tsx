"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminSignalOverview } from "../../lib/adminOverview";
import { Segmented, Tag } from "../ui";
import AlertRulesSection from "./AlertRulesSection";
import BusTypesSection from "./BusTypesSection";
import HealthSection, { type HealthReport } from "./HealthSection";
import KeysSection from "./KeysSection";
import TgTargetsSection from "./TgTargetsSection";
import XAccountsSection from "./XAccountsSection";
import SignalsSection from "./SignalsSection";
import StatusStrip from "./StatusStrip";
import { PipelinesOverview, SignalLinesOverview } from "./TaxonomyOverview";
import {
  gateMessage,
  gateState,
  probeFromResponse,
  type Probe,
} from "./authGate";
import { authHeaders } from "./shared";

// /manage — 运营管理页。
//
// 2026-08-18:整页改为**令牌门后**才渲染。此前页面结构是公开的,无令牌者
// 虽然拿不到 /api/admin/* 的数据,却照样看得到引擎心跳表、告警阈值明文,
// 以及一整套 tab 与 KPI 标签 —— 后者本身就是情报:它把这套系统的运营结构
// (有哪些循环、哪些投递通道、多少档策略、存证链、备份日、有几个 API key)
// 白送给任何知道路径的人。服务端那道 ADMIN_TOKEN 闸一直都在、也一直有效,
// 这次补的是**信息暴露**那一面。
//
// 门的判据只有一个:服务端认不认(GET /api/admin/signals 的响应码,见
// ./authGate.ts)。前端不做任何本地令牌判断,探针失败一律锁死。
// 本地开发(非公开部署)下 checkWriteAccess 恒放行,探针直接 200,零摩擦。
//
// 唯独引擎健康度**不**藏在这道门后:它搬去了公开状态页 /status。
// 「引擎还活着吗」是每个订阅方都有权随时知道的事实(信号 feed 的 healthy
// 位、频道沉默、webhook 停投都指向它),藏起来只会让订阅方靠猜;而「哪些
// 档位放开了推送、TG 连败几次、有几个 key」才是运营内部事。
//
// 数据刷新模型:解锁后统一拉 /api/health + /api/admin/signals,手动刷新
// 按钮 + 60s 自动刷新 —— 运营页通常开着不关,数据不能停在打开那一刻。

const AUTO_REFRESH_MS = 60_000;
// 令牌输入是逐字符 onChange。不防抖的话,手打一个 40 字符的令牌会打出 40 次
// /api/admin/signals —— 该路由 perIp 限流 60 次/分钟,而现在整页都吊在这个
// 探针上:一旦 429,运营者会被自己锁在门外,且提示还是「服务端异常」。
const TOKEN_DEBOUNCE_MS = 400;

// 信息架构(2026-08-19 重排):两步模型 —— 第一步「产什么信号」(三条线,
// 与接入文档 §6.1 同一套分类),第二步「投给谁」(下游管线)。此前五个 tab
// 把两层揉在一起,策略开关/总线开关/TG 告警条件同住一个 tab,而 TG 目标、
// API key、𝕏 又各占一个 —— 没有一张图回答「这条信号最终到谁手里」。
const TABS = [
  { id: "lines", label: "🧭 信号 · 三条线" },
  { id: "pipes", label: "🚚 下游管线" },
  { id: "health", label: "🩺 健康度" },
] as const;
type TabId = (typeof TABS)[number]["id"];

// StatusStrip 发出的是**区块** id(它不该知道 tab 怎么分组),这里把它映射
// 到承载该区块的 tab —— 契约不变,StatusStrip 零改动。
const SECTION_TAB: Record<string, TabId> = {
  rules: "lines",
  signals: "lines",
  bus: "lines",
  tg: "pipes",
  keys: "pipes",
  x: "pipes",
  health: "health",
};

const TAB_STORAGE_KEY = "manageTab";

export default function ManagePage() {
  const [token, setToken] = useState("");
  // 防抖后的令牌 —— 只有它变化才发探针。
  const [probeToken, setProbeToken] = useState("");
  const [probe, setProbe] = useState<Probe>({ kind: "pending" });
  const [overview, setOverview] = useState<AdminSignalOverview | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 初次挂载先读 localStorage 再发请求,避免「无令牌请求 → 锁定 → 令牌
  // 水合后又解锁」的闪烁。
  const hydrated = useRef(false);

  const [tab, setTab] = useState<TabId>("lines");

  useEffect(() => {
    const saved = window.localStorage.getItem("adminToken") ?? "";
    setToken(saved);
    // 存过的令牌不必再等防抖:它不是刚敲进来的。
    setProbeToken(saved);
    const savedTab = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (savedTab && TABS.some((x) => x.id === savedTab)) {
      setTab(savedTab as TabId);
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setProbeToken(token), TOKEN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [token]);

  const selectTab = (id: TabId) => {
    setTab(id);
    window.localStorage.setItem(TAB_STORAGE_KEY, id);
  };

  const saveToken = (v: string) => {
    setToken(v);
    window.localStorage.setItem("adminToken", v);
  };

  const loadAll = useCallback(async () => {
    if (!hydrated.current) return;
    setRefreshing(true);
    try {
      const ovRes = await fetch("/api/admin/signals", {
        headers: authHeaders(probeToken),
      }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as AdminSignalOverview & { error?: string },
      }));
      const next = probeFromResponse(ovRes.status, ovRes.body);
      setProbe(next);
      if (next.kind !== "ok") {
        // 锁定时清空既有数据:留着上一把有效令牌的运营数据在内存里、
        // 只是不渲染,是在赌「不渲染」永远不出 bug。
        setOverview(null);
        setHealth(null);
        return;
      }
      setOverview(ovRes.body);
      // 健康度只在解锁后才拉 —— 锁定态一个请求都不该发出去。
      // 公开状态页 /status 才是这份数据对外的正门。
      try {
        setHealth((await (await fetch("/api/health")).json()) as HealthReport);
      } catch {
        // 健康度拿不到不该影响已解锁的运营数据。
        setHealth(null);
      }
      setRefreshedAt(Math.floor(Date.now() / 1000));
    } catch (e) {
      setProbe({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      setOverview(null);
      setHealth(null);
    } finally {
      setRefreshing(false);
    }
  }, [probeToken]);

  useEffect(() => {
    void loadAll();
    const timer = setInterval(() => void loadAll(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadAll]);

  const state = gateState(probe);
  const message = gateMessage(probe, probeToken !== "");

  // 状态条上的 chip 点击:切到承载该区块的 tab(切完区块就在首屏,不必再滚动)。
  // 同 tab 内有多个区块,只切 tab 不滚动等于没跳 —— 切完等目标挂载再滚锚点。
  const jump = (id: string) => {
    selectTab(SECTION_TAB[id] ?? "lines");
    window.setTimeout(() => {
      document
        .getElementById(`sec-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  };

  const tokenField = (
    <div style={{ flex: "1 1 320px", maxWidth: 480 }}>
      <div
        className="ds-label"
        style={{
          marginBottom: "var(--s-2)",
          display: "flex",
          gap: "var(--s-2)",
          alignItems: "center",
        }}
      >
        管理令牌(x-admin-token)
        {state === "unlocked" && <Tag variant="up">已验证</Tag>}
        {state === "locked" && <Tag variant="warn">已锁定</Tag>}
      </div>
      <input
        id="manage-token"
        className="ds-input ds-input--mono"
        type="password"
        placeholder="x-admin-token"
        value={token}
        onChange={(e) => saveToken(e.target.value)}
        autoComplete="off"
        style={{ width: "100%" }}
      />
      {message && (
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          {message}
        </div>
      )}
    </div>
  );

  // 锁定/验证中:只有标题、令牌框、以及一条去公开状态页的出口。
  // 没有 tab、没有 KPI、没有区块骨架 —— 这些标签本身就是运营结构的情报。
  if (state !== "unlocked") {
    return (
      <main className="ds-main" style={{ maxWidth: 560 }}>
        <header style={{ marginBottom: "var(--s-5)" }}>
          <h1 style={{ fontSize: "var(--t-2xl)", margin: 0 }}>🔒 运营管理</h1>
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            本页需要管理令牌。令牌只存本浏览器,与 /alerts 配置面板共用。
          </div>
        </header>
        <div className="ds-card" style={{ padding: "var(--s-5)" }}>
          {tokenField}
        </div>
        <div className="ds-hint" style={{ marginTop: "var(--s-4)" }}>
          想确认引擎是否在正常运行？这不需要令牌 ——{" "}
          <Link href="/status">查看系统状态 →</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-5)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-3)",
            flexWrap: "wrap",
          }}
        >
          <h1 style={{ fontSize: "var(--t-2xl)", margin: 0 }}>🛠 运营管理</h1>
          <button
            className="ds-btn ds-btn--subtle ds-btn--sm"
            disabled={refreshing}
            onClick={() => void loadAll()}
          >
            {refreshing ? "刷新中…" : "↻ 刷新"}
          </button>
          {refreshedAt != null && (
            <span className="ds-hint mono">
              更新于 {new Date(refreshedAt * 1000).toLocaleTimeString("zh-CN")}
              <span className="muted"> · 每分钟自动</span>
            </span>
          )}
        </div>
        {/* /status 不在全站导航里,/manage 是它唯一的常规入口 —— 所以这条
            链接放在页头而不是只放在健康度区块内:运维在别的 tab 上发现数字
            不对劲时,不该还要先切回健康度才找得到去处。 */}
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          无入口页面(不在导航栏)。令牌只存本浏览器,与 /alerts 配置面板共用。
          <span className="muted"> · </span>
          <Link href="/status">🩺 系统状态页 →</Link>
        </div>
      </header>

      <StatusStrip health={health} overview={overview} onJump={jump} />

      <div
        className="ds-card"
        style={{
          marginBottom: "var(--s-5)",
          padding: "var(--s-4)",
          display: "flex",
          gap: "var(--s-4)",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
        }}
      >
        {tokenField}
      </div>

      <div style={{ marginBottom: "var(--s-5)" }}>
        <Segmented
          options={TABS.map((x) => ({ value: x.id, label: x.label }))}
          value={tab}
          onChange={(v) => selectTab(v)}
          ariaLabel="运营分区"
          className="ds-segmented--wrap"
        />
      </div>

      {/* 每个 tab 只挂载自己的区块:各 Section 在挂载时拉取自己的数据,
          切走即卸载,回来重新拉 —— 运营页的数据本来就要求新鲜,重挂载
          顺带成了「切 tab 即刷新」。 */}
      {tab === "lines" && (
        <>
          <SignalLinesOverview overview={overview} onJump={jump} />
          <div id="sec-rules" style={{ scrollMarginTop: "var(--s-6)" }}>
            <AlertRulesSection token={token} />
          </div>
          <div id="sec-signals" style={{ scrollMarginTop: "var(--s-6)" }}>
            <SignalsSection
              token={token}
              overview={overview}
              reload={loadAll}
            />
          </div>
          <div id="sec-bus" style={{ scrollMarginTop: "var(--s-6)" }}>
            <BusTypesSection token={token} />
          </div>
        </>
      )}
      {tab === "pipes" && (
        <>
          <PipelinesOverview overview={overview} onJump={jump} />
          <div id="sec-tg" style={{ scrollMarginTop: "var(--s-6)" }}>
            <TgTargetsSection token={token} />
          </div>
          <div id="sec-keys" style={{ scrollMarginTop: "var(--s-6)" }}>
            <KeysSection token={token} />
          </div>
          <div id="sec-x" style={{ scrollMarginTop: "var(--s-6)" }}>
            <XAccountsSection token={token} />
          </div>
        </>
      )}
      {tab === "health" && (
        <HealthSection health={health} ops={overview?.ops ?? null} />
      )}
    </main>
  );
}
