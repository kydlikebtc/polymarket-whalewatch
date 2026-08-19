// /manage 分区组件共用的小工具(客户端)。

export const authHeaders = (token: string): Record<string, string> =>
  token ? { "x-admin-token": token } : {};

/**
 * 可订阅的信号类型。与 lib/signalBus.BUS_TYPES 同源语义(客户端组件不能
 * import 碰 DB 的模块),外加 "strategy" —— 19 档策略信号在订阅层面也是一个
 * 类型。不勾任何项 = 不限(全部),与既有 key 的语义一致。
 *
 * key 的订阅范围与 webhook 端点的推送类型共用这一份 —— 两处各写一份的话,
 * 加一个信号类型就会漏掉其中之一。
 */
export const SUBSCRIBABLE = [
  { type: "strategy", label: "② 策略信号(19 档)" },
  { type: "large", label: "① 🐳 大额成交" },
  { type: "consensus", label: "① 🔥 聪明钱共识" },
  { type: "discovery", label: "① 🔭 聪明钱发现" },
] as const;

export const cents = (p: number | null | undefined): string =>
  p == null ? "—" : `${(p * 100).toFixed(1).replace(/\.0$/, "")}¢`;

export const timeText = (sec: number | null | undefined): string =>
  sec == null
    ? "—"
    : new Date(sec * 1000).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

export const agoText = (sec: number | null | undefined): string => {
  if (sec == null) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 60) return `${d} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86_400) return `${(d / 3600).toFixed(1).replace(/\.0$/, "")} 小时前`;
  return `${Math.floor(d / 86_400)} 天前`;
};
