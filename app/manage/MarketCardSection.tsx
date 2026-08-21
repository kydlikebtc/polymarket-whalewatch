"use client";

import { useCallback, useEffect, useState } from "react";
import { StatCard } from "../ui";
import { Dot, SectionHead } from "./bits";
import { authHeaders } from "./shared";

// 区块:市场深度卡(/api/signals/market/[cid])的预算与可观测。
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
      <section>
        <SectionHead title="🎯 市场深度卡" />
        <p className="ds-muted">加载中…</p>
      </section>
    );
  }

  const s = data.stats;
  const served = s.cold + s.warm + s.hit + s.degraded;
  const hitRate = served > 0 ? Math.round((s.hit / served) * 100) : null;
  const throttled = data.effectiveBudget < data.settings.budgetPerMin;

  return (
    <section>
      <SectionHead title="🎯 市场深度卡" />

      <p className="ds-muted" style={{ marginBottom: "var(--s-3)" }}>
        计数是<strong>进程内累计</strong>,重启归零——它回答「这个进程活着这段
        时间里预算花在哪了」,不是历史统计。
      </p>

      <div className="kpi-grid">
        <StatCard label="零上游命中">
          <div className="ds-num">
            {s.hit}
            {hitRate != null && (
              <span className="ds-muted" style={{ fontSize: "0.8em" }}>
                {" "}
                · {hitRate}%
              </span>
            )}
          </div>
        </StatCard>
        <StatCard label="热续 / 冷启">
          <div className="ds-num">
            {s.warm} / {s.cold}
          </div>
        </StatCard>
        <StatCard label="降级(发了旧卡)">
          <div className="ds-num">{s.degraded}</div>
        </StatCard>
        <StatCard label="拒绝(429)">
          <div className="ds-num">
            <Dot tone={s.refused > 0 ? "warn" : "muted"}>{s.refused}</Dot>
          </div>
        </StatCard>
        <StatCard label="工作集 / 存档">
          <div className="ds-num">
            {s.workingSet} / {data.archivedWindows}
          </div>
        </StatCard>
        <StatCard label="此刻生效额度">
          <div className="ds-num">
            <Dot tone={throttled ? "warn" : "up"}>
              {data.effectiveBudget}/min
            </Dot>
          </div>
        </StatCard>
      </div>

      {throttled && (
        <p className="ds-muted" style={{ marginTop: "var(--s-2)" }}>
          ⚠️ 生效额度低于配置值:引擎
          {data.staleLoops.length > 0
            ? `有循环停跳(${data.staleLoops.join(", ")}),预算已归零`
            : "循环出现漂移,预算已降到 25%"}
          。卡片永远给引擎让路——引擎断更时继续取令牌是在加深故障。
        </p>
      )}

      {s.refused > 0 && (
        <p className="ds-muted" style={{ marginTop: "var(--s-2)" }}>
          有请求被拒:若持续非零,说明预算或工作集上限该往上调了。
        </p>
      )}

      <div style={{ marginTop: "var(--s-4)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-2)" }}>
          参数
        </div>
        {FIELDS.map((f) => (
          <label
            key={f.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-3)",
              marginBottom: "var(--s-2)",
              flexWrap: "wrap",
            }}
          >
            <span style={{ minWidth: "7rem" }}>{f.label}</span>
            <input
              type="number"
              className="ds-input"
              style={{ width: "7rem" }}
              value={draft[f.key]}
              onChange={(e) =>
                setDraft({ ...draft, [f.key]: Number(e.target.value) })
              }
            />
            <span className="ds-muted" style={{ fontSize: "0.85em" }}>
              {f.hint}(默认 {data.defaults[f.key]})
            </span>
          </label>
        ))}
        <button
          className="ds-btn"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {note && (
          <span className="ds-muted" style={{ marginLeft: "var(--s-3)" }}>
            {note}
          </span>
        )}
      </div>
    </section>
  );
}
