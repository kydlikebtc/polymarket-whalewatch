// key 权限域的**唯一定义**。零依赖 —— 服务端(lib/apiKeys)与 /manage 的客户端
// 组件都从这里取,不再各抄一份。
//
// 此前 app/manage/shared.ts 手抄了一份,理由是「客户端组件不能 import 碰 DB 的
// 模块」——那个约束是真的(lib/apiKeys 引了 node 的 crypto),但结论下错了:该抽
// 出纯数据,而不是抄一遍。抄出来的那份立刻就分叉了:新增 `market` 范围时,API
// 认得它而发 key 的 UI 里没有,等于范围存在却没人能授予。
//
// 两个域刻意分开(理由见 lib/apiKeys 的「两个权限域」注释):
//   · SCOPES  = key 能被授予的**能力**全集,含非事件能力(market);
//   · PUSHABLE = 可经 webhook 推送的**事件类型**,是前者的真子集。
// 深度卡是拉取的,没有事件可推 —— 让它出现在端点推送勾选框里是无意义的选项,
// 服务端也会拒收。

export interface ScopeMeta {
  type: string;
  label: string;
}

/** 可经 webhook 推送的事件类型。顺序即 UI 展示顺序。 */
export const PUSHABLE_SCOPES: readonly ScopeMeta[] = [
  { type: "strategy", label: "② 策略信号(19 档)" },
  { type: "large", label: "① 🐳 大额成交" },
  { type: "consensus", label: "① 🔥 聪明钱共识" },
  { type: "discovery", label: "① 🔭 聪明钱发现" },
] as const;

/** 非事件能力:能被 key 授予,但没有事件可推。 */
export const CAPABILITY_SCOPES: readonly ScopeMeta[] = [
  { type: "market", label: "🎯 市场深度卡(按需查询,仅 realtime)" },
] as const;

/** key 可被授予的全部范围 = 事件类型 + 非事件能力。 */
export const ALL_SCOPES: readonly ScopeMeta[] = [
  ...PUSHABLE_SCOPES,
  ...CAPABILITY_SCOPES,
];

export const KEY_SCOPES: readonly string[] = ALL_SCOPES.map((s) => s.type);
export const PUSHABLE_TYPES: readonly string[] = PUSHABLE_SCOPES.map(
  (s) => s.type,
);

/** 展示名;未知类型回落成裸 key(不该发生,但不值得为它抛错)。 */
export const scopeLabel = (type: string): string =>
  ALL_SCOPES.find((s) => s.type === type)?.label ?? type;
