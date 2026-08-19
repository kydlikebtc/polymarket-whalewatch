import type { DB } from "./db";
import { BUS_TYPES, getBusSettings, type BusSourceType } from "./signalBus";
import { DIGEST_DAY_KEY } from "./signalDigest";

// /api-docs 的「当前开放状态」数据层。
//
// 存在理由:这张表此前是手写在 docs/api-access.md 里的日期快照
// （「截至 2026-08-19 只有『激进』一档」）。运营者在 /manage 拨一下开关,
// 文档立刻开始撒谎,而没有任何东西会提醒任何人去改它 —— 一份会过期的接入
// 文档比没有文档更贵,订阅方会照着它写解析代码。
//
// 于是把易变事实从 markdown 里赶出去:markdown 只留**系统能力的全集**
// (永不过期),「此刻开着什么」由本模块查库回答(永不撒谎)。
//
// 公开面纪律:/api-docs 无需令牌即可访问,所以这里只输出**开/关**与**档位名**,
// 绝不输出阈值(minUsd/minWallets/minScore)—— 那些是可被规避的规则集,上一轮
// 刚随 /api/alert-config 一起锁进 ADMIN_TOKEN。档位名与其战绩本来就已经在
// 公开的 /api/record 上,不构成新增暴露。

export interface PublishedStrategy {
  id: number;
  name: string;
}

export interface BusTypeStatus {
  type: BusSourceType;
  /** 带 emoji 的展示名,与 /manage 同源(lib/signalBus.BUS_TYPES)。 */
  label: string;
  enabled: boolean;
}

export interface ApiDocsStatus {
  /** push_enabled=1 的档位,按 id 升序。空数组 = 当前没有任何档位对外发布。 */
  strategies: PublishedStrategy[];
  /** 三个可订阅的总线类型各自的开关。 */
  busTypes: BusTypeStatus[];
  /** 最近一次存证 digest 的 UTC 日期;null = 尚未生成过。 */
  digestDay: string | null;
}

/** 只有这三类可被 key 订阅(其余 BUS_TYPES 尚未落库,不出现在对外文档里)。 */
const SUBSCRIBABLE_BUS: BusSourceType[] = ["large", "consensus", "discovery"];

export function buildApiDocsStatus(db: DB): ApiDocsStatus {
  const strategies = db
    .prepare(
      "SELECT id, name FROM follow_strategies WHERE push_enabled = 1 ORDER BY id",
    )
    .all() as PublishedStrategy[];

  const settings = getBusSettings(db);
  const busTypes: BusTypeStatus[] = SUBSCRIBABLE_BUS.map((type) => ({
    type,
    label: BUS_TYPES.find((b) => b.type === type)?.label ?? type,
    enabled: settings[type]?.enabled === true,
  }));

  const digestDay =
    (
      db
        .prepare("SELECT value FROM config WHERE key = ?")
        .get(DIGEST_DAY_KEY) as { value: string | null } | undefined
    )?.value ?? null;

  return { strategies, busTypes, digestDay };
}
