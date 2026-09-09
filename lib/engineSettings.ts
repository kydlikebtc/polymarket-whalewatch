// 引擎运行时开关的唯一真相 —— 读(worker/embeddedEngine getMode)、写
// (/api/admin/engine)、展示(app/manage/EngineSection)三端共用这一份键名
// 与判读语义。此前读取端内联 SQL、写入端只存在于设计文档里的 docker 命令,
// 键名靠抄 —— 一个字符的漂移就是「开关拧了没反应」,而且事故当口才会发现。
//
// **零运行时依赖**(只 import type,编译期抹掉):客户端组件可以安全引用
// 模式注册表(CONSENSUS_WINDOW_MODES),不会把碰 DB 的模块拖进浏览器
// bundle —— 与 lib/keyScopes 同一姿态。可达性守卫见
// app/manage/engineParity.test.ts。
import type { DB } from "./db";

export type ConsensusWindowMode = "incremental" | "full";

export const CONSENSUS_WINDOW_MODE_KEY = "consensus_window_mode";

export interface ConsensusWindowModeMeta {
  mode: ConsensusWindowMode;
  label: string;
  hint: string;
}

// 模式注册表:/manage 的分段控件直接渲染它,不手抄(kindsParity 那次教训:
// cohort 在数据层上线、运营页清单没跟上,能力不可达藏了十天)。
export const CONSENSUS_WINDOW_MODES: ConsensusWindowModeMeta[] = [
  {
    mode: "incremental",
    label: "增量维护(默认)",
    hint: "windowKeeper 常驻 6h 缓冲,每轮只抓水位线之后的新增;每小时定时全量重扫兜底",
  },
  {
    mode: "full",
    label: "全量重扫(回滚)",
    hint: "每轮全量重拉 6h 窗口(老抓取路径)。整体绕开增量机制,节奏不变、上游成本上升",
  },
];

/**
 * 读当前模式。语义与回滚设计一致(docs/plans/2026-09-08-incremental-window-design.md
 * 回滚节):**只有精确值 'full' 是全量**,缺行或任何其它值一律增量 ——
 * 坏配置不该悄悄改变引擎行为。
 */
export function getConsensusWindowMode(db: DB): ConsensusWindowMode {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONSENSUS_WINDOW_MODE_KEY) as { value: string | null } | undefined;
  return row?.value === "full" ? "full" : "incremental";
}

/**
 * 写模式,经 config_history 留痕(与 lib/signalBus setBusSettings 同一套写法:
 * 值变了才记一笔,幂等重写不刷历史)。只写规范值('incremental'/'full'),
 * 留痕要能直接读出意图 —— 「删行 = 增量」的等价写法审计时得先懂判读规则。
 */
export function setConsensusWindowMode(db: DB, mode: ConsensusWindowMode): void {
  const prev = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(CONSENSUS_WINDOW_MODE_KEY) as { value: string | null } | undefined;
  if (prev?.value !== mode) {
    db.prepare(
      "INSERT INTO config_history (key, value, changed_at) VALUES (?, ?, ?)",
    ).run(CONSENSUS_WINDOW_MODE_KEY, mode, Math.floor(Date.now() / 1000));
  }
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    CONSENSUS_WINDOW_MODE_KEY,
    mode,
  );
}

/** 该键的最近变更(新→旧),供运营页把留痕摆在开关旁边。 */
export function listConsensusWindowModeHistory(
  db: DB,
  limit = 5,
): { value: string; changedAt: number }[] {
  const rows = db
    .prepare(
      `SELECT value, changed_at FROM config_history
        WHERE key = ? ORDER BY changed_at DESC, id DESC LIMIT ?`,
    )
    .all(CONSENSUS_WINDOW_MODE_KEY, limit) as {
    value: string | null;
    changed_at: number;
  }[];
  return rows.map((r) => ({ value: r.value ?? "", changedAt: r.changed_at }));
}
