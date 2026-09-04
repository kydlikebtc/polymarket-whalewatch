"use client";

import { useCallback, useEffect, useState } from "react";
import { StatCard } from "../ui";
import { SectionHead } from "./bits";
import { authHeaders } from "./shared";

// 区块:市场深度卡(/api/market-card/[cid])的预算与可观测。
//
// 这一页要回答运维的两个问题:「预算花在哪了」与「该不该调」。所以左边是五个
// 计数,右边是四个旋钮,中间那行 effectiveBudget 把两者连起来 —— 配置里的额度
// 是上限,此刻真正允许的由引擎健康度决定(循环漂移降到 25%、停跳归零)。只显示
// 配置值的话,运维在引擎喘不过气时会看不懂「为什么 refused 在涨」。

interface Stats {
  cold: number;
  warm: number;
  hit: number;
  degraded: number;
  refused: number;
  workingSet: number;
}

interface Settings {
  budgetPerMin: number;
  windowTtlSec: number;
  staleGateSec: number;
  lruMax: number;
}

interface Payload {
  settings: Settings;
  defaults: Settings;
  stats: Stats;
  effectiveBudget: number;
  healthy: boolean;
  staleLoops: string[];
  archivedWindows: number;
}

const FIELDS: { key: keyof Settings; label: string; hint: string }[] = [
  {
    key: "budgetPerMin",
    label: "上游预算",
    hint: "每分钟允许的上游请求数。0 = 暂时关掉这个端点",
  },
  {
    key: "windowTtlSec",
    label: "新鲜期(秒)",
    hint: "窗口多久算旧;也是卡片的年龄上限",
  },
  {
    key: "staleGateSec",
    label: "陈旧闸(秒)",
    hint: "超过它宁可 429 也不发卡。必须大于新鲜期,否则降级永远够不着",
  },
  {
    key: "lruMax",
    label: "工作集上限",
    hint: "内存里最多保留几个市场的窗口",
  },
];

export default function MarketCardSection({ token }: { token: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/market-card", {
        headers: authHeaders(token),
      });
      if (!res.ok) return;
      const body = (await res.json()) as Payload;
      setData(body);
      setDraft(body.settings);
    } catch {
      // 面板拉不到不该炸掉整个 /manage —— 其余区块各自拉各自的数据。
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setNote(null);
    try {
      const res = await fetch("/api/admin/market-card", {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await res.json()) as {
        settings?: Settings;
        error?: string;
      };
      if (!res.ok || !body.settings) {
        setNote(body.error ?? "保存失败");
        return;
      }
      // 回读生效值:夹取与「陈旧闸必须大于新鲜期」的修正都在服务端做,
      // 提交什么不等于生效什么 —— 直接把生效值写回输入框,不让两者分叉。
      setDraft(body.settings);
      const changed =
        JSON.stringify(body.settings) !== JSON.stringify(draft as Settings);
      setNote(changed ? "已保存(部分值被夹取到合法区间)" : "已保存");
      void load();
    } finally {
      setSaving(false);
    }
  };

  if (!data || !draft) {
    return (
      <section
        className="ds-card"
        style={{ padding: "var(--s-5)", marginBottom: "var(--s-5)" }}
      >
        <SectionHead title="🎯 市场深度卡" />
        {/* 空态给内容也给出路 —— 不返回 null,也不留一行孤零零的「加载中」。 */}
        <div className="ds-empty">
          正在读取预算与计数…
          <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
            读不到通常是管理令牌失效,或 /api/admin/market-card 拒绝了本次请求。
          </div>
        </div>
      </section>
    );
  }

  const s = data.stats;
  const served = s.cold + s.warm + s.hit + s.degraded;
  const hitRate = served > 0 ? Math.round((s.hit / served) * 100) : null;
  const throttled = data.effectiveBudget < data.settings.budgetPerMin;

  return (
    <section
      className="ds-card"
      style={{ padding: "var(--s-5)", marginBottom: "var(--s-5)" }}
    >
      <SectionHead title="🎯 市场深度卡" />

      {/* 口径先行 —— 统计声明放在数据前面,不放脚注（琥珀 = 读前必看）。 */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-4)" }}
      >
        计数是<b>进程内累计</b>,重启归零 ——
        它回答「这个进程活着这段时间里预算花在哪了」,不是历史统计。
      </div>

      {/* KPI 分格卡:一张白卡 N 等分,格间 1px 竖线;值 18px 常规字重。 */}
      <section className="kpi">
        <StatCard label="零上游命中" icon="🎯">
          <div className="kpi-value">
            {s.hit}
            {hitRate != null && <span className="muted"> · {hitRate}%</span>}
          </div>
          <div className="kpi-sub">窗口还新鲜,一次上游都没打</div>
        </StatCard>
        <StatCard label="热续 / 冷启" icon="🔥">
          <div className="kpi-value">
            {s.warm} / {s.cold}
          </div>
        </StatCard>
        <StatCard label="降级（发了旧卡）" icon="🕰">
          <div className="kpi-value">{s.degraded}</div>
        </StatCard>
        <StatCard label="拒绝（429）" icon="🚧">
          <div
            className="kpi-value"
            style={s.refused > 0 ? { color: "var(--ww-warn)" } : undefined}
          >
            {s.refused}
          </div>
        </StatCard>
        <StatCard label="工作集 / 存档" icon="📦">
          <div className="kpi-value">
            {s.workingSet} / {data.archivedWindows}
          </div>
        </StatCard>
        <StatCard label="此刻生效额度" icon="⛽">
          <div
            className="kpi-value"
            style={throttled ? { color: "var(--ww-warn)" } : undefined}
          >
            {data.effectiveBudget}/min
          </div>
          <div className="kpi-sub">
            配置上限 {data.settings.budgetPerMin}/min
          </div>
        </StatCard>
      </section>

      {throttled && (
        <div
          className="ds-callout ds-callout--warn"
          style={{ marginTop: "var(--s-4)" }}
        >
          生效额度低于配置值:引擎
          {data.staleLoops.length > 0
            ? `有循环停跳(${data.staleLoops.join(", ")}),预算已归零`
            : "循环出现漂移,预算已降到 25%"}
          。卡片永远给引擎让路 —— 引擎断更时继续取令牌是在加深故障。
        </div>
      )}

      {s.refused > 0 && (
        <div className="ds-callout" style={{ marginTop: "var(--s-3)" }}>
          有请求被拒:若持续非零,说明预算或工作集上限该往上调了。
        </div>
      )}

      <div style={{ marginTop: "var(--s-5)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-3)" }}>
          参数
        </div>
        {FIELDS.map((f) => (
          <label
            key={f.key}
            className="filter-row"
            style={{ marginBottom: "var(--s-3)" }}
          >
            <span className="filter-row__label" style={{ minWidth: "7rem" }}>
              {f.label}
            </span>
            <input
              type="number"
              className="ds-input"
              style={{ width: "7rem" }}
              value={draft[f.key]}
              onChange={(e) =>
                setDraft({ ...draft, [f.key]: Number(e.target.value) })
              }
            />
            <span className="ds-hint">
              {f.hint}（默认 {data.defaults[f.key]}）
            </span>
          </label>
        ))}
        <div className="filter-row" style={{ marginTop: "var(--s-4)" }}>
          <button
            className="ds-btn ds-btn--primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
          {note && <span className="ds-hint">{note}</span>}
        </div>
      </div>
    </section>
  );
}
