// 区块级的门 —— authGate 管整页,这里管单个分区里「显示加载中 / 报错 / 内容」。
//
// 存在的理由是一次真实的自相矛盾:页头显示「已验证」,而 EventsSection /
// TgTargetsSection / XAccountsSection 同时显示「填入管理令牌后加载」,并且
// 压根不发请求。原因是两套判据 —— 页头问服务端(authGate 探针),区块问本地
// 那个 token 字符串。在**未配 ADMIN_TOKEN 的部署**上(本地开发就是),
// checkWriteAccess 恒放行、本地 token 恒为空,于是整页解锁而三个区块永远空着。
//
// 所以这里的签名刻意**不接受 token**:区块无从判断令牌,只能看「请求回来了
// 没有、服务端说了什么」。与 authGate 同一条纪律 —— 服务端认了才算认。

export type SectionView<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

/**
 * @param data  已到手的数据;还没拿到是 null
 * @param error 服务端/网络给出的错误原话;没有则 null
 *
 * ready 分支**带着数据**:调用方在 `view.kind === "ready"` 之后拿到的
 * `view.data` 已是非空类型,省掉一串 `data!`。断言只是骗过编译器,判别
 * 联合让编译器真的帮上忙。
 *
 * 有数据就渲染数据 —— 即便同时带着错误。60s 自动刷新撞上一次网络抖动,
 * 不该让运营者眼前的表整个消失(错误另由区块顶部的 callout 说明)。
 */
export function sectionView<T>(
  data: T | null | undefined,
  error: string | null,
): SectionView<T> {
  if (data != null) return { kind: "ready", data };
  if (error) return { kind: "error", message: error };
  return { kind: "loading" };
}

/** 错误行的展示上限。TG 的报错前缀就有 50+ 字符,截短了等于只显示前缀。 */
const ERROR_CLIP = 160;

/**
 * 截断错误文本供行内展示。完整原文应由调用方放进 title —— 截断是为了不撑破
 * 表格,不是为了丢信息。
 */
export function clipError(
  text: string | null | undefined,
  max: number = ERROR_CLIP,
): string {
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
