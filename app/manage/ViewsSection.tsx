"use client";

import { SectionHead } from "./bits";

// 区块:视图(状态,非信号)。
//
// 2026-08-19 概念重排:此前占着「信号线 ①」位置的「聪明钱动向」其实是
// ① 原始事件的**折叠视图** —— 拉取快照、共识升级原地更新、没有稳定的
// 逐事件 id,因此没有「触发后发出」的语义,也就不存在管线。视图挪到这里,
// 信号线只剩两条(原始事件/策略)。
//
// 本区块纯说明,无任何开关:视图没有可管理的东西 —— 折叠规则是固定常量
// (这正是它对订阅方可信的原因),数据由 /api/signals 请求时现算。

const VIEWS = [
  {
    name: "active[] / settled[]",
    from: "① 大额/共识事件,按市场×方向折叠",
    rule: "共识 ≥2 白名单同向 · 分歧两侧都有(不给方向) · 单笔大额白名单 ≥$50k(常量)",
    use: "订阅方渲染卡片;共识升级原地更新金额,formationTs 保持最初形成时刻",
  },
  {
    name: "record30d",
    from: "① 已结算事件的 30 天汇总",
    rule: "价格调整口径:wins/implied/excess/sd 全是条数量纲(gradeRows 唯一实现)",
    use: "战绩展示;|excess| < 2×sd 必须写「仍在运气范围内」",
  },
  {
    name: "strategies.active / settled / recordByStrategy",
    from: "② 策略事件台账的窗口视图与汇总",
    rule: "active 固定 48h 窗 · settled 回看 3 天 · record 按档 30 天",
    use: "订阅方渲染策略卡;事件本体在 ② 台账(有稳定 id,可推送)",
  },
];

export default function ViewsSection() {
  return (
    <section
      className="ds-card"
      style={{ padding: "var(--s-5)", marginBottom: "var(--s-5)" }}
    >
      <SectionHead
        title="👁 视图（状态,非信号）"
        hint="视图 = 事件的折叠/汇总,回答「现在该看什么」,由 /api/signals 请求时现算。它没有稳定的逐事件 id,不承担触发语义,因此没有管线、也没有开关 —— 想被推送,订阅对应的事件(① 或 ②)。"
      />
      <div className="ds-table-wrap">
        <table className="ds-table ds-table--compact">
          <thead>
            <tr>
              <th>视图</th>
              <th>由什么折叠而来</th>
              <th>规则（固定,非配置）</th>
              <th>用途</th>
            </tr>
          </thead>
          <tbody>
            {VIEWS.map((v) => (
              <tr key={v.name}>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>
                  {v.name}
                </td>
                <td>{v.from}</td>
                <td className="ds-hint">{v.rule}</td>
                <td className="ds-hint">{v.use}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
        推荐消费模式:<b>事件做触发,视图做渲染</b> —— webhook 收到事件后,拿
        conditionId + outcome 去视图取当前折叠状态展示。把 ① 的每条共识
        升级事件当独立信号计数是唯一的坑(一个组会被数成多个),视图已替你 折叠好。
      </div>
    </section>
  );
}
