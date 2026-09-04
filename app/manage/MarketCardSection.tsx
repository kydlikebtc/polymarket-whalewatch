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

// hint 不再占一行正文 —— 它进 label 的 title(设计系统里表头 (?) 的那套
// 做法),输入框旁边只留「默认 N」这一个读数。
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
  // 读取失败与保存回执分开存:save() 写完 note 就 void load(),两者共用一个
  // 状态的话「已保存」会被随后的加载结果冲掉。
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/market-card", {
        headers: authHeaders(token),
      });
      const body = (await res.json()) as Payload & { error?: string };
      // 服务端的原话必须露出来 —— 此前这里是 `if (!res.ok) return;` 加一个
      // 空 catch:令牌失效时 data 恒为 null,空态永远停在「正在读取…」,把
      // 故障说成了慢。与同目录 AlertRulesSection 同一副姿态。
      if (!res.ok) {
        setLoadErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setLoadErr(null);
      setData(body);
      setDraft(body.settings);
    } catch (e) {
      // 面板拉不到不该炸掉整个 /manage —— 其余区块各自拉各自的数据,
      // 但本区块得说清自己为什么空。
      setLoadErr(e instanceof Error ? e.message : String(e));
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
        {loadErr && (
          <div
            className="ds-callout ds-callout--error"
            style={{ marginBottom: "var(--s-3)" }}
          >
            {loadErr}
          </div>
        )}
        {/* 空态给内容也给出路 —— 不返回 null,也不把「读不到」说成「正在读取」。 */}
        <div className="ds-empty">
          {loadErr ? "读不到预算与计数。" : "正在读取预算与计数…"}
          {loadErr && (
            <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
              通常是管理令牌失效;换令牌后自动重试。
            </div>
          )}
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

      {/* 刷新失败时(如保存后回读被拒)数据还是旧的 —— 说出来,别让它装新。 */}
      {loadErr && (
        <div
          className="ds-callout ds-callout--error"
          style={{ marginBottom: "var(--s-3)" }}
        >
          {loadErr}
        </div>
      )}

      {/* 口径先行 —— 统计声明放在数据前面,不放脚注（琥珀 = 读前必看）。
          本区块只留这一条琥珀:限流与被拒的成因改写在对应那格 KPI 的副行上,
          读数在哪儿,解释就在哪儿。 */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-4)" }}
      >
        计数是<b>进程内累计</b>,重启归零 —— 不是历史统计。
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
          {/* 「持续非零该调参数了」原本是数据下方一整条说明条 —— 挪到它解释的
              那个数底下。 */}
          {s.refused > 0 && (
            <div className="kpi-sub">持续非零 = 该上调预算或工作集</div>
          )}
        </StatCard>
        <StatCard label="工作集 / 存档" icon="📦">
          <div className="kpi-value">
            {s.workingSet} / {data.archivedWindows}
          </div>
        </StatCard>
        {/* 「为什么此刻的额度比配置低」原本是数据下方一整条琥珀说明条 ——
            成因挪到这一格的副行,与那个变琥珀的数字同处。「卡片永远给引擎
            让路」是设计理由,收进 title。 */}
        <StatCard label="此刻生效额度" icon="⛽">
          <div
            className="kpi-value"
            style={throttled ? { color: "var(--ww-warn)" } : undefined}
            title={
              throttled
                ? "卡片永远给引擎让路:引擎断更时继续取上游令牌是在加深故障"
                : undefined
            }
          >
            {data.effectiveBudget}/min
          </div>
          <div className="kpi-sub">
            配置上限 {data.settings.budgetPerMin}/min
            {throttled &&
              (data.staleLoops.length > 0
                ? ` · 循环停跳(${data.staleLoops.join(", ")}),已归零`
                : " · 循环漂移,已降到 25%")}
          </div>
        </StatCard>
      </section>

      <div style={{ marginTop: "var(--s-5)" }}>
        <div className="ds-label" style={{ marginBottom: "var(--s-3)" }}>
          参数
        </div>
        {FIELDS.map((f) => (
          <label
            key={f.key}
            className="filter-row"
            style={{ marginBottom: "var(--s-3)" }}
            title={f.hint}
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
            <span className="ds-hint">默认 {data.defaults[f.key]}</span>
          </label>
        ))}
        <div className="filter-row" style={{ marginTop: "var(--s-4)" }}>
          {/* 描边白底 —— 页头的「刷新」是全页唯一的蓝底主按钮,它在这个子
              tab 上同屏可见,这里再来一枚就是一屏两主。 */}
          <button
            className="ds-btn"
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
