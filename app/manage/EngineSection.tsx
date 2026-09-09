"use client";

import { useCallback, useEffect, useState } from "react";
import { Segmented, Tag } from "../ui";
import { SectionHead } from "./bits";
import { authHeaders, timeText } from "./shared";
import { sectionView } from "./sectionGate";
import {
  CONSENSUS_WINDOW_MODES,
  type ConsensusWindowMode,
} from "../../lib/engineSettings";

// 区块:⚙️ 引擎设置 —— 共识循环的运行时开关。
//
// 目前只有一个旋钮:consensus_window_mode(共识窗口抓取模式),windowKeeper
// 增量机制的事故回滚开关。在这个区块出现之前,拧它的唯一办法是进生产容器
// 手写 SQLite(设计文档回滚节里那条 docker 命令)—— 「已实现却不可达」对
// 回滚开关比对普通能力更糟:事故当口没人想翻文档抄命令。
//
// 模式清单从 lib/engineSettings 导入而非手抄(kindsParity 那次教训的正面
// 做法);该 lib 零运行时依赖,不会把碰 DB 的模块拖进客户端 bundle。写入
// 经 config_history 留痕,最近变更就摆在开关旁边。可达性与单一真相的守卫:
// ./engineParity.test.ts。
//
// 两个方向都单击生效、不加确认:回滚(→全量)是止损方向,事故里要快;切回
// (→增量)从常驻缓冲续跑,失误了再点一下就回来 —— 都不是对外动作
// (对外才二次确认,见 SignalsSection 的规矩)。

interface HistoryRow {
  value: string;
  changedAt: number;
}

interface Payload {
  mode: ConsensusWindowMode;
  history: HistoryRow[];
}

const modeLabel = (v: string): string =>
  CONSENSUS_WINDOW_MODES.find((m) => m.mode === v)?.label ?? v;

export default function EngineSection({ token }: { token: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/engine", {
        headers: authHeaders(token),
      });
      const j = (await res.json()) as Payload & { error?: string };
      if (j.error) {
        setError(j.error);
        setData(null);
        return;
      }
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    // 不按本地 token 拦 —— 能不能读由服务端说了算(见 ./sectionGate)。
    void load();
  }, [load]);

  const view = sectionView(data, error);

  const switchMode = async (mode: ConsensusWindowMode) => {
    if (busy || data?.mode === mode) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/engine", {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const j = (await res.json()) as Payload & { error?: string };
      if (!res.ok || j.error) {
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      // POST 回的就是全量 payload(模式 + 留痕),不必再 GET 一次。
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const current =
    view.kind === "ready"
      ? CONSENSUS_WINDOW_MODES.find((m) => m.mode === view.data.mode)
      : undefined;

  return (
    <section
      className="ds-card"
      style={{ padding: "var(--s-5)", marginBottom: "var(--s-5)" }}
    >
      <SectionHead
        title="⚙️ 引擎设置 · 共识窗口模式"
        hint="共识循环(90s)每轮拿 6h 窗口的抓取方式;改完下一轮生效,无需重启。分析窗口与信号定义不受影响。"
        aside={
          data ? (
            // 回滚态是需留神的状态(上游成本上升,且说明增量机制被怀疑),
            // 走琥珀;增量是出厂常态,走绿。
            data.mode === "full" ? (
              <Tag variant="warn">⏪ 回滚:全量重扫中</Tag>
            ) : (
              <Tag variant="up">✅ 增量维护中</Tag>
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

      {view.kind === "error" ? (
        <div className="ds-empty">
          {view.message}
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            通常是管理令牌失效;换令牌后自动重试。
          </div>
        </div>
      ) : view.kind === "loading" ? (
        <div className="ds-empty">正在读取引擎设置…</div>
      ) : (
        <>
          <Segmented
            ariaLabel="共识窗口模式"
            options={CONSENSUS_WINDOW_MODES.map((m) => ({
              value: m.mode,
              label: busy && view.data.mode !== m.mode ? "…" : m.label,
            }))}
            value={view.data.mode}
            onChange={(v) => void switchMode(v)}
          />
          {/* 当前模式的机制说明贴在控件正下方 —— 选中哪个说哪个,不摆两段。 */}
          {current ? (
            <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
              {current.hint}。
            </div>
          ) : null}

          <div className="ds-label" style={{ margin: "var(--s-4) 0 var(--s-2)" }}>
            最近变更(config_history 留痕)
          </div>
          {view.data.history.length === 0 ? (
            <div className="ds-hint">
              从未切换过 —— 出厂即增量,config 表尚无此行。
            </div>
          ) : (
            <ul
              className="ds-hint"
              style={{ margin: 0, paddingLeft: "var(--s-4)" }}
            >
              {view.data.history.map((h, i) => (
                <li key={`${h.changedAt}-${i}`}>
                  {timeText(h.changedAt)} → {modeLabel(h.value)}
                </li>
              ))}
            </ul>
          )}

          <div className="note-strip" style={{ marginTop: "var(--s-4)" }}>
            {
              "开关隔离的是增量机制自身的风险:回滚后节奏仍是 90s(实测全量 ~5 页/轮可承受),切回增量从常驻缓冲续跑。管理页打不开时的容器内兜底命令见设计文档回滚节。"
            }
          </div>
        </>
      )}
    </section>
  );
}
