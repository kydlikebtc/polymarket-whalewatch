import type { PulseBoardTag, PulseReport } from "../../lib/marketPulse";

// /pulse 的跨榜成员身份 —— 纯逻辑,与渲染无关。单独成模块的理由同
// lib/categoryLabel.ts 那条既有先例:app/ 下没有组件测试基建,但归并/去重
// 这类合成规则是可测纯逻辑;留在 boards.tsx 里就只能连着 ../ui 整棵客户端
// 组件树一起 import,node 测试环境跑不动。
//
// 四个市场级榜单的成员身份。与品类标签是两回事,且这个区别是本页的核心:
//   品类标签(体育/电竞)= Polymarket 对市场的分类,「这是什么市场」;
//   榜单标记(异常/分歧/无鲸/洗量)= 本站对市场的评价,「我们发现它怎么了」。
// 确信指数不在其列 —— 它是品类级的,不落到单个市场。
//
// 同一个市场经常同时上好几个榜(高洗量的市场往往也是异常榜常客)。改成分段
// 标签页后一次只渲染一个榜,跨榜身份就看不见了 —— 这些标记把它带回每一行,
// 否则想知道「这个异常市场是不是也在洗量榜上」只能切过去人肉扫一遍。
// 标记的单一来源在 lib/marketPulse.ts —— 市场信号卡的 pulse 段也消费同一个
// 联合类型,两边各定义一份迟早漂移,且漂移时两个页面会给同一市场贴不同标签、
// 谁都不报错。此处只做本地别名,不重新定义。
export type BoardTag = PulseBoardTag;
export type Membership = Map<string, BoardTag[]>;

/** buildMembership 的入参:四个市场级榜单的数组,后两个可能缺席(缓存里的旧
 *  payload 没有这两个 additive 键)。 */
export interface MembershipSource {
  top: PulseReport["top"];
  divergences: PulseReport["divergences"];
  ghosts?: PulseReport["ghosts"];
  washTop?: PulseReport["washTop"];
}

/**
 * 按 conditionId 归并四个榜的成员身份。
 *
 * ⚠️ 诚实的覆盖边界:top 在数据层就被 slice(0, topN) 封到 10 条
 * (marketPulse.ts:262),所以「异常」标记只覆盖当日前 10 名。排到第 11 的
 * 异常市场在别的榜上不会带「异常」标记 —— 不知道 ≠ 没有,与本仓其余「空值
 * 不进榜也不画图」同一条纪律。其余三榜的数组是全量,不受此限。
 *
 * 标记顺序固定为 异常 → 分歧 → 无鲸 → 洗量(即榜单的漏斗顺序),与插入顺序
 * 无关地稳定 —— 否则同一个市场在不同榜上会看到不同排列的 chip。
 */
export function buildMembership(r: MembershipSource): Membership {
  const m: Membership = new Map();
  const add = (id: string, tag: BoardTag) => {
    const cur = m.get(id);
    if (cur == null) m.set(id, [tag]);
    else if (!cur.includes(tag)) cur.push(tag);
  };
  for (const x of r.top) add(x.conditionId, "anomaly");
  for (const x of r.divergences) add(x.conditionId, "divergence");
  for (const x of r.ghosts ?? []) add(x.conditionId, "ghost");
  for (const x of r.washTop ?? []) add(x.conditionId, "wash");
  return m;
}

/**
 * 当前榜自己的标记不重复发 —— 你已经在看这个榜了,标题就写着。只显示「它还
 * 上了哪些榜」,那才是切标签页看不到的信息。
 */
export function otherTags(
  m: Membership,
  id: string,
  self: BoardTag,
): BoardTag[] {
  return (m.get(id) ?? []).filter((k) => k !== self);
}
