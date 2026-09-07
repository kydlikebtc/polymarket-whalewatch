// 存证链的**唯一定义**,单独成模块且**零 import**。
//
// 为什么值得为一个字符串模板单开一个文件:这段文本有三个消费方 ——
// 生成侧(lib/signalDigest,跑在 Node,用 crypto)、复算侧(lib/digestVerify,
// 同时跑在 Node 脚本与**浏览器**里,用 WebCrypto)、以及将来任何第三方实现。
// 若它继续住在 signalDigest 里,浏览器那条路径就会顺着 import 链把
// `node:crypto` 与整个投递栈(signalDelivery → telegram/strategySignals)
// 拖进客户端 bundle —— 一个「验证按钮」把半个服务端打包进页面,而且构建
// 直接失败。
//
// 另一半理由是防漂移:两处各写一遍拼接,迟早有一处改了分隔符或空值写法,
// 而那种漂移会伪装成「存证验证失败」——把可信度工件本身变成噪音。

/** 创世 prev:第一天之前没有链,固定哨兵让复算者有确定起点。 */
export const DIGEST_GENESIS = "genesis";

export interface DigestRow {
  id: number;
  strategyName: string;
  conditionId: string;
  outcome: string;
  emittedAt: number;
  /**
   * 入场价。允许 string 是给复算侧用的:公开 CSV 的字段原文可以直接塞进来,
   * 不做 Number 往返 —— 生成 CSV 用的就是 `String(number)`,原文进模板与数字
   * 进模板逐字等价,少一次浮点↔字符串转换就少一处能出错的地方。
   */
  entryPrice: number | string | null;
}

/** h_i 的输入:`前值|id|档名|市场|方向|发布时刻|入场价`。 */
export function digestPreimage(prevHex: string, r: DigestRow): string {
  return `${prevHex}|${r.id}|${r.strategyName}|${r.conditionId}|${r.outcome}|${r.emittedAt}|${r.entryPrice ?? "null"}`;
}
