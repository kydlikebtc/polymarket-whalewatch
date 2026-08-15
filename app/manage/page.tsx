"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminSignalOverview } from "../../lib/adminOverview";
import { Tag } from "../ui";
import AlertRulesSection from "./AlertRulesSection";
import HealthSection, { type HealthReport } from "./HealthSection";
import KeysSection from "./KeysSection";
import SignalsSection from "./SignalsSection";
import StatusStrip from "./StatusStrip";
import { authHeaders } from "./shared";

// /manage — 运营管理页。刻意**不进 TopNav**(知道路径者可达),但这不是
// 安全边界:页面本身公开,所有敏感读写都压在服务端 ADMIN_TOKEN 上
// (/api/admin/* 的 GET/POST 与 /api/alert-config 的 POST 全部要令牌;
// 无令牌者只能看到公开信息 + 明确的「令牌无效」提示)。令牌与 /alerts
// 配置面板共用同一份 localStorage("adminToken"),两页输入一次即可。
//
// 数据刷新模型:页面统一拉 /api/health(公开)+ /api/admin/signals(令牌),
// 手动刷新按钮 + 60s 自动刷新 —— 运营页通常开着不关,数据不能停在打开那一刻。

const AUTO_REFRESH_MS = 60_000;

const SECTIONS = [
  { id: "signals", label: "📡 推送信号" },
  { id: "rules", label: "🔔 提醒规则" },
  { id: "health", label: "🩺 健康度" },
  { id: "keys", label: "🔑 key / webhook" },
] as const;

export default function ManagePage() {
  const [token, setToken] = useState("");
  const [overview, setOverview] = useState<AdminSignalOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 初次挂载先读 localStorage 再发请求,避免「无令牌请求 → 401 红条 → 令牌
  // 水合后又变绿」的闪烁。
  const hydrated = useRef(false);

  useEffect(() => {
    setToken(window.localStorage.getItem("adminToken") ?? "");
    hydrated.current = true;
  }, []);

  const saveToken = (v: string) => {
    setToken(v);
    window.localStorage.setItem("adminToken", v);
  };

  const loadAll = useCallback(async () => {
    if (!hydrated.current) return;
    setRefreshing(true);
    try {
      const [healthRes, ovRes] = await Promise.allSettled([
        fetch("/api/health").then((r) => r.json() as Promise<HealthReport>),
        fetch("/api/admin/signals", { headers: authHeaders(token) }).then(
          async (r) => ({ status: r.status, body: await r.json() }),
        ),
      ]);
      if (healthRes.status === "fulfilled") setHealth(healthRes.value);
      if (ovRes.status === "fulfilled") {
        const { status, body } = ovRes.value as {
          status: number;
          body: AdminSignalOverview & { error?: string };
        };
        if (status === 401 || status === 403) {
          setOverview(null);
          setOverviewError(
            token
              ? "管理令牌无效 —— 请核对服务器 .env 的 ADMIN_TOKEN"
              : "未填管理令牌 —— 运营数据(推送开关/key/积压)需要令牌",
          );
        } else if (body.error) {
          setOverview(null);
          setOverviewError(body.error);
        } else {
          setOverviewError(null);
          setOverview(body);
        }
      }
      setRefreshedAt(Math.floor(Date.now() / 1000));
    } finally {
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    void loadAll();
    const timer = setInterval(() => void loadAll(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadAll]);

  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

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
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          无入口页面(不在导航栏)。读写运营数据需管理令牌 —— 令牌只存本浏览器, 与
          /alerts 配置面板共用。
        </div>
      </header>

      <StatusStrip health={health} overview={overview} onJump={jump} />

      <div
        className="ds-card"
        style={{
          marginBottom: "var(--s-5)",
          display: "flex",
          gap: "var(--s-4)",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
        }}
      >
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
            {overview != null && <Tag variant="up">已验证</Tag>}
            {overviewError != null && <Tag variant="warn">受限</Tag>}
          </div>
          <input
            id="manage-token"
            className="ds-input ds-input--mono"
            type="password"
            placeholder="x-admin-token"
            value={token}
            onChange={(e) => saveToken(e.target.value)}
            style={{ width: "100%" }}
          />
          {overviewError && (
            <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
              {overviewError}
            </div>
          )}
        </div>
        <nav
          style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}
          aria-label="分区导航"
        >
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className="ds-btn ds-btn--ghost ds-btn--sm"
              onClick={() => jump(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </div>

      <SignalsSection token={token} overview={overview} reload={loadAll} />
      <AlertRulesSection token={token} />
      <HealthSection health={health} ops={overview?.ops ?? null} />
      <KeysSection token={token} />
    </main>
  );
}
