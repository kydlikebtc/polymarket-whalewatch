"use client";

import { useCallback, useEffect, useState } from "react";
import { Tag } from "../ui";
import { SectionHead } from "./bits";
import { authHeaders } from "./shared";
import {
  WW_EXTENSION_MESSAGE,
  type WwExtensionAck,
} from "../../lib/extensionProtocol";

// 区块:𝕏 发帖通道(API 直发 / 浏览器插件)。
//
// 两条通道共享同一张 x_posts 表,所以切换既不会重发也不会断档;引擎每轮
// 读一次配置,切换后 ≤60s 生效,无需重启(与账号切换同一套即时性承诺)。
//
// 切回 API 会**作废**插件队列里的待发:切换往往正因为插件那条路出了问题,
// 用付费 API 把积压旧闻补发出去是双输(烧钱 + 发旧闻)。按钮上明示条数。

interface ChannelPayload {
  channel: "api" | "extension";
  dailyCaps: { whale: number; pregame: number };
  queueDepth: number;
}

type Notice = { text: string; tone: "ok" | "err" } | null;

export default function XChannelSection({ token }: { token: string }) {
  const [data, setData] = useState<ChannelPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [caps, setCaps] = useState({ whale: 100, pregame: 6 });
  const [apiKey, setApiKey] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/x-accounts", {
        headers: authHeaders(token),
      });
      const j = (await res.json()) as Partial<ChannelPayload> & {
        error?: string;
      };
      if (j.error) {
        setError(j.error);
        setData(null);
        return;
      }
      if (j.channel && j.dailyCaps) {
        setData({
          channel: j.channel,
          dailyCaps: j.dailyCaps,
          queueDepth: j.queueDepth ?? 0,
        });
        setCaps(j.dailyCaps);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    if (token) void load();
  }, [token, load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/x-accounts", {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { error?: string; voided?: number };
      if (j.error) {
        setError(j.error);
        return;
      }
      if (j.voided) {
        setNotice({ text: `已作废 ${j.voided} 条待发`, tone: "ok" });
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const switchChannel = (next: "api" | "extension") => {
    if (!data || data.channel === next) return;
    if (next === "api" && data.queueDepth > 0) {
      if (
        !window.confirm(
          `切回 API 直发会作废插件队列里的 ${data.queueDepth} 条待发（不会用付费 API 补发旧闻）。确认切换？`,
        )
      ) {
        return;
      }
    }
    void post({ action: "channel", channel: next });
  };

  // 配置推送:页面 → content script → background。协议常量来自
  // lib/extensionProtocol(插件侧逐字复制同一份),握手不会漂移。
  const pushToExtension = () => {
    if (!apiKey.trim()) {
      setNotice({ text: "先填入带「𝕏 发帖队列」能力的 API key", tone: "err" });
      return;
    }
    setNotice(null);
    const onAck = (ev: MessageEvent) => {
      const d = ev.data as
        | { source?: string; action?: string; payload?: WwExtensionAck }
        | undefined;
      if (
        ev.source !== window ||
        d?.source !== WW_EXTENSION_MESSAGE.source ||
        d?.action !== WW_EXTENSION_MESSAGE.ack
      ) {
        return;
      }
      window.removeEventListener("message", onAck);
      clearTimeout(timer);
      setNotice(
        d.payload?.ok
          ? {
              text: `已推送到插件${d.payload.version ? `（v${d.payload.version}）` : ""}`,
              tone: "ok",
            }
          : {
              text: `插件拒绝了配置：${d.payload?.error ?? "未知原因"}`,
              tone: "err",
            },
      );
    };
    // 没装插件时没人回 ack —— 必须自己超时,否则按钮点了像没反应。
    const timer = setTimeout(() => {
      window.removeEventListener("message", onAck);
      setNotice({
        text: "没有收到插件响应：确认已在 chrome://extensions 装好并启用，且当前域名在插件的匹配范围内",
        tone: "err",
      });
    }, 3000);
    window.addEventListener("message", onAck);
    window.postMessage(
      {
        source: WW_EXTENSION_MESSAGE.source,
        action: WW_EXTENSION_MESSAGE.configure,
        payload: {
          baseUrl: window.location.origin,
          apiKey: apiKey.trim(),
        },
      },
      window.location.origin,
    );
  };

  const isExt = data?.channel === "extension";

  return (
    <section className="ds-card" style={{ padding: "var(--s-5)" }}>
      <SectionHead
        title="𝕏 发帖通道"
        hint="两条通道共享同一份发帖台账，切换不重发也不断档；引擎下一轮（≤60s）自动生效。"
        aside={
          data ? (
            isExt ? (
              <Tag variant="up">🧩 浏览器插件</Tag>
            ) : (
              <Tag>☁️ API 直发</Tag>
            )
          ) : null
        }
      />

      {error ? (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-3)" }}
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          className={
            notice.tone === "ok" ? "ds-callout" : "ds-callout ds-callout--error"
          }
          style={{ marginBottom: "var(--s-3)" }}
        >
          {notice.text}
        </div>
      ) : null}

      {!token ? (
        <div className="ds-empty">填入管理令牌后可切换发帖通道</div>
      ) : !data ? (
        <div className="ds-empty">加载中…</div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              gap: "var(--s-3)",
              flexWrap: "wrap",
              marginBottom: "var(--s-4)",
            }}
          >
            <ChannelCard
              active={!isExt}
              disabled={busy}
              title="☁️ API 直发"
              desc="worker 用 X API 发帖。按量付费，月预算是硬上限（大单 20 条/天）。"
              onClick={() => switchChannel("api")}
            />
            <ChannelCard
              active={isExt}
              disabled={busy}
              title="🧩 浏览器插件"
              desc="落队列，由本机 Chrome 插件用已登录会话代发。边际成本为零，上限只为防封号。"
              onClick={() => switchChannel("extension")}
            />
          </div>

          {isExt ? (
            <>
              <div
                className="ds-callout"
                style={{ marginBottom: "var(--s-3)" }}
              >
                队列待发：<b>{data.queueDepth}</b> 条
                {data.queueDepth > 20
                  ? "　—— 积压偏高，检查本机 Chrome 的插件是否在运行、x.com 是否还登录着"
                  : ""}
              </div>

              <h3 style={{ fontSize: "var(--t-sm)", margin: "0 0 var(--s-2)" }}>
                每日上限
              </h3>
              <div className="ds-hint" style={{ marginBottom: "var(--s-2)" }}>
                插件通道不花钱，这个上限管的是刷屏与封号风险，与 API
                通道的预算上限无关。
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "var(--s-3)",
                  alignItems: "flex-end",
                  flexWrap: "wrap",
                  marginBottom: "var(--s-4)",
                }}
              >
                <label>
                  <div className="ds-hint">🐳 巨鲸大单</div>
                  <input
                    className="ds-input"
                    type="number"
                    min={1}
                    value={caps.whale}
                    onChange={(e) =>
                      setCaps((c) => ({ ...c, whale: Number(e.target.value) }))
                    }
                    style={{ width: 90 }}
                  />
                </label>
                <label>
                  <div className="ds-hint">⏰ 赛前聚合</div>
                  <input
                    className="ds-input"
                    type="number"
                    min={1}
                    value={caps.pregame}
                    onChange={(e) =>
                      setCaps((c) => ({
                        ...c,
                        pregame: Number(e.target.value),
                      }))
                    }
                    style={{ width: 90 }}
                  />
                </label>
                <button
                  className="ds-btn ds-btn--sm"
                  disabled={
                    busy ||
                    !Number.isInteger(caps.whale) ||
                    caps.whale < 1 ||
                    !Number.isInteger(caps.pregame) ||
                    caps.pregame < 1
                  }
                  onClick={() => void post({ action: "caps", caps })}
                >
                  保存上限
                </button>
              </div>

              <h3 style={{ fontSize: "var(--t-sm)", margin: "0 0 var(--s-2)" }}>
                连接插件
              </h3>
              <div className="ds-hint" style={{ marginBottom: "var(--s-2)" }}>
                在「🔑 接入」里签发一把勾选了「𝕏 发帖队列」的
                key，粘到这里推给插件 —— 服务器地址会自动带上，不用手抄。
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "var(--s-2)",
                  flexWrap: "wrap",
                }}
              >
                <input
                  className="ds-input mono"
                  type="password"
                  placeholder="wlk_…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  style={{ minWidth: 280, flex: 1 }}
                />
                <button
                  className="ds-btn ds-btn--primary ds-btn--sm"
                  onClick={pushToExtension}
                >
                  推送配置到插件
                </button>
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function ChannelCard({
  active,
  disabled,
  title,
  desc,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="ds-card"
      style={{
        flex: "1 1 240px",
        textAlign: "left",
        padding: "var(--s-4)",
        cursor: disabled ? "default" : "pointer",
        borderColor: active ? "var(--up-500)" : undefined,
        background: active ? "var(--up-50)" : undefined,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "var(--s-1)" }}>
        {title}
        {active ? (
          <span className="ds-hint" style={{ marginLeft: 6 }}>
            使用中
          </span>
        ) : null}
      </div>
      <div className="ds-hint">{desc}</div>
    </button>
  );
}
