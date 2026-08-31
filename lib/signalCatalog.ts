import type { DB } from "./db";
import { listBusDefs } from "./busDefs";
import { keyAllows } from "./apiKeys";
import { sourceOf } from "./strategyFeed";
import { strategyCode } from "./strategyCodes";

// 信号名录 —— 回答订阅方「我这把 key 到底能收到哪些信号」。
// 设计见 docs/plans/2026-08-27-signal-catalog-api-design.md。
//
// 存在理由:「能收到什么」是三层开关的乘积 —— tier(feedAuth)× key 订阅范围
// (api_keys.bus_types)× 运营开关(bus_defs.enabled / follow_strategies.
// push_enabled)。第三层公开在 /api-docs,第二层是这把 key 私有的,此前无处
// 可查。于是「接口通、返回 200、就是没数据」这个最难排查的状态没有诊断入口。
//
// 名录只回答**有哪些**,不回答**为什么没有**:收不到的直接不出现。三层各自
// 为什么关着是运营者的事,把开关矩阵吐给订阅方只会让他们去猜运营策略。
//
// 全 ASCII,不含中文展示名。这是 docs/api-access.md §8.3 自己的建议:`name`
// 是中文展示名,「运营改一次文案你就断了」。名录是拿来写代码的,不是拿来看的
// —— 一份只能眼睛读的清单等于没有名录。

/** ① 原始事件的一档定义。同一 type 可有多档,靠 threshold 区分。 */
export interface BusCatalogEntry {
  /** 与 bus[] 条目的 sourceType 同值。 */
  type: string;
  /**
   * 下限阈值,语义随 type(large=USD / consensus=钱包数 / discovery=评分)。
   * 去掉中文 label 之后,这是同一 type 下多档**唯一诚实的判别键**。
   * 不用 bus_defs.id 顶替:自增行号换个部署就指向另一档,与 §8.3 否掉
   * strategy.id 是同一个坑。
   */
  threshold: number;
}

/** ② 策略事件的一档。 */
export interface StrategyCatalogEntry {
  /** 跨部署稳定的档位码(§8.3「认档用它」);null = 运营手工建、未登记码。 */
  code: string | null;
  /** 检测器族:heavy / consensus / lopsided / resolved / lone_wolf / early_winner。 */
  source: string;
  /**
   * 该档会发出的事件种类(2026-08-31)。买入(entry)与兑现(settle)是
   * 一等对称动作:webhook 两种都推,feed 的 strategies.events[] 两种都列。
   * 此前名录只列档位不列事件,订阅方无从得知有 settle —— 名录承诺什么,
   * 通道就投什么,这一字段就是那句承诺。
   */
  events: ("entry" | "settle")[];
}

export interface SignalCatalog {
  /** ① 原始事件。空数组 = 这把 key 一条原始事件都收不到。 */
  bus: BusCatalogEntry[];
  /** ② 策略事件。空数组 = 收不到任何档位信号。 */
  strategy: StrategyCatalogEntry[];
}

/**
 * 组装名录。
 *
 * @param scopes key 的订阅范围;null / 空 = 不限(见 lib/apiKeys.keyAllows)。
 *
 * 过滤口径必须与 /api/signals 完全一致(两边都走 keyAllows):名录列出了而
 * feed 不投递,等于承诺一份收不到的信号 —— 那比没有名录更糟,订阅方会照着它
 * 写解析分支,然后永远等不到数据。
 */
export function buildSignalCatalog(
  db: DB,
  { scopes }: { scopes: string[] | null | undefined },
): SignalCatalog {
  // ① 启用的信号定义。listBusDefs 返回全部(含关掉的),这里只取开着的 ——
  // 关掉的类型压根不写入总线(见 lib/signalBus 的「关掉的类型不写入」),
  // 列出来就是骗人。
  const bus: BusCatalogEntry[] = listBusDefs(db)
    .filter((d) => d.enabled && keyAllows(scopes, d.sourceType))
    .map((d) => ({ type: d.sourceType, threshold: d.threshold }));

  // ② 已放开推送的档位。push_enabled=0 的档只跑纸面履历,不对外发信号。
  const strategy: StrategyCatalogEntry[] = keyAllows(scopes, "strategy")
    ? (
        db
          .prepare(
            "SELECT name, params_json FROM follow_strategies WHERE push_enabled = 1",
          )
          .all() as { name: string; params_json: string | null }[]
      )
        .map((r) => ({
          code: strategyCode(r.name),
          source: sourceOf(r.params_json),
          events: ["entry", "settle"] as ("entry" | "settle")[],
        }))
        // 按 code 排,不按 id:id 是部署本地自增行号,拿它排序会让同一份名录
        // 在两个部署上顺序不同 —— 而顺序是订阅方做 diff 的依据。
        // code 为 null 的(运营手工建的档)排在末尾,彼此保持查询顺序。
        .sort((a, b) => {
          if (a.code === b.code) return 0;
          if (a.code === null) return 1;
          if (b.code === null) return -1;
          return a.code < b.code ? -1 : 1;
        })
    : [];

  return { bus, strategy };
}
