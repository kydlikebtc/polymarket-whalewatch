// /manage 分区组件共用的小工具(客户端)。

export const authHeaders = (token: string): Record<string, string> =>
  token ? { "x-admin-token": token } : {};

// 事件类型 / key 范围的定义在 lib/keyScopes(零依赖,服务端与本页共用一份)。
// 此前这里手抄了一份,新增 `market` 时立刻分叉:API 认得它而发 key 的 UI 里没有,
// 范围存在却没人能授予。再导出是为了不改各组件的既有 import 路径。
export {
  PUSHABLE_SCOPES as SUBSCRIBABLE,
  ALL_SCOPES as KEY_SCOPES,
  scopeLabel,
} from "../../lib/keyScopes";

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
