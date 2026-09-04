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
        // 「视图为什么没有管线」是分类模型的解释,总览表已讲;这里只说本区块
        // 唯一会改变操作的事实 —— 没有开关可调。
        hint="视图无管线、无开关;想被推送,订阅对应的事件(① 或 ②)。"
      />
      {/* 口径先行：这张表全是固定常量,读之前先知道它不可配置。 */}
      <div
        className="ds-callout ds-callout--warn"
        style={{ marginBottom: "var(--s-4)" }}
      >
        下表的折叠规则是<b>写死的常量</b>,要改只能改代码并重新部署。
      </div>
      <div className="ds-table-wrap">
        <table className="ds-table">
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
                <td data-label="视图" className="cell-wrap">
                  {v.name}
                </td>
                <td data-label="由什么折叠而来" className="cell-wrap">
                  {v.from}
                </td>
                <td data-label="规则" className="cell-wrap">
                  {v.rule}
                </td>
                <td data-label="用途" className="cell-wrap">
                  {v.use}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* 卡底说明条 —— 灰底、与表同框,不是脚注也不是新的一块内容。 */}
        <div className="note-strip">
          <b>事件做触发,视图做渲染</b>
          {
            " —— 把 ① 的每条共识升级事件当独立信号计数是唯一的坑(一个组会被数成多个)。"
          }
        </div>
      </div>
    </section>
  );
}
