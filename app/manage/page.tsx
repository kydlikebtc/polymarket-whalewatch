"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminSignalOverview } from "../../lib/adminOverview";
import AlertRulesSection from "./AlertRulesSection";
import HealthSection from "./HealthSection";
import KeysSection from "./KeysSection";
import SignalsSection from "./SignalsSection";
import { authHeaders } from "./shared";

// /manage — 运营管理页。刻意**不进 TopNav**(知道路径者可达),但这不是
// 安全边界:页面本身公开,所有敏感读写都压在服务端 ADMIN_TOKEN 上
// (/api/admin/* 的 GET/POST 与 /api/alert-config 的 POST 全部要令牌;
// 无令牌者只能看到公开信息 + 一堆 401)。令牌与 /alerts 配置面板共用同一份
// localStorage("adminToken"),两页输入一次即可。

export default function ManagePage() {
  const [token, setToken] = useState("");
  const [overview, setOverview] = useState<AdminSignalOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  useEffect(() => {
    setToken(window.localStorage.getItem("adminToken") ?? "");
  }, []);

  const saveToken = (v: string) => {
    setToken(v);
    window.localStorage.setItem("adminToken", v);
  };

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/signals", {
        headers: authHeaders(token),
      });
      const j = (await res.json()) as AdminSignalOverview & { error?: string };
      if (!res.ok || j.error) {
        setOverview(null);
        setOverviewError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setOverviewError(null);
      setOverview(j);
    } catch (e) {
      setOverview(null);
      setOverviewError(String(e));
    }
  }, [token]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  return (
    <main className="ds-main">
      <header style={{ marginBottom: "var(--s-4)" }}>
        <h1 style={{ fontSize: "var(--t-2xl)", marginBottom: "var(--s-1)" }}>
          🛠 运营管理
        </h1>
        <div className="ds-hint">
          无入口页面(不在导航栏)。读写运营数据需管理令牌 —— 令牌只存本浏览器, 与
          /alerts 配置面板共用。
        </div>
      </header>

      <div className="ds-card" style={{ marginBottom: "var(--s-5)" }}>
        <label className="ds-label" htmlFor="manage-token">
          管理令牌(x-admin-token)
        </label>
        <input
          id="manage-token"
          className="ds-input"
          type="password"
          placeholder="x-admin-token"
          value={token}
          onChange={(e) => saveToken(e.target.value)}
          style={{ maxWidth: 420 }}
        />
        {overviewError && (
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            运营数据:{overviewError}
          </div>
        )}
      </div>

      <SignalsSection token={token} overview={overview} reload={loadOverview} />
      <AlertRulesSection token={token} />
      <HealthSection ops={overview?.ops ?? null} />
      <KeysSection token={token} />
    </main>
  );
}
