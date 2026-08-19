// 路由矩阵的判据(与渲染分开,才测得动)。
//
// 每格必须回答「**现在**这条线通不通」。矩阵一度用 legacy 的
// config.bus_signal_settings 算「bus[]/总线 开关」,而 2026-08-19 起唯一真相
// 是 bus_defs(同一类型可多档、各档独立启停):新 UI 的 defAction
// create/update/delete 三条路径都不回写 legacy,于是运营者在「① 原始事件」
// 里启用了一档,矩阵照旧显示「关」—— 一块永远说着旧话的仪表盘。

/** /api/admin/signals 的 busDefs 元素(只取判据用得上的字段)。 */
export interface BusDefLike {
  sourceType: string;
  enabled: boolean;
}

/**
 * 某个事件类型是否有**启用中的**信号定义。
 *
 * 判据与 EventsSection 的 `typeDefs.some(d => d.enabled)` 逐字一致 —— 同一个
 * 问题在两个地方给出不同答案,正是这次要消灭的东西。
 */
export function busTypeEnabled(
  defs: BusDefLike[] | null,
  sourceType: string,
): boolean {
  return (defs ?? []).some((d) => d.sourceType === sourceType && d.enabled);
}
