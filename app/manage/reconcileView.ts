import type { SettlementReconcile } from "../../lib/adminOverview";
import type { Tone } from "./bits";

// 🩺 健康度「结算对账」卡的纯展示逻辑(与渲染分开,才测得动 —— walkforwardView
// 同一纪律)。读数语义见 lib/adminOverview.ts 的 SettlementReconcile:stray 是
// 主读数(应恒为 0),tsMismatch7d 是次级口径检查。

export interface ReconcileCardView {
  tone: Tone;
  /** 任一读数非零即高亮 —— 运营者扫一眼就该停下来的那种。 */
  hot: boolean;
  /** 卡下方那句说明:正常态讲清读数含义,异常态直接给排查入口。 */
  sub: string;
}

export function reconcileCardView(s: SettlementReconcile): ReconcileCardView {
  if (s.stray > 0) {
    return {
      tone: "down",
      hot: true,
      sub: "回填路径可能在坏,看 [follow] 日志中的「对账补齐 / 对账写入失败」",
    };
  }
  if (s.tsMismatch7d > 0) {
    return {
      tone: "warn",
      hot: true,
      sub: `近 7 天有 ${s.tsMismatch7d} 行台账 settled_ts 与仓位 exit_ts 偏差超过 5 分钟,核查回填口径`,
    };
  }
  return {
    tone: "up",
    hot: false,
    sub: "仓位已结算而台账未回填的行数;对账每轮兜底,应恒为 0",
  };
}
