import type { DB } from "./db";
import { strategyCode } from "./strategyCodes";

// 公开数据集导出(docs/plans/2026-08-27-outlet-trio-design.md #3)。
// 范围与 /api/record 同一分母:**已公开发布**(存在 sent entry 投递)的信号,
// 逐行全量 —— 未结算行也在(won 留空),分母诚实是这个产品的命。
// 防篡改校验不在这里重造:逐日 hash 链走 /api/record 的 digest,CSV 是
// 便利导出不是存证载体(文档同此表述)。

export const DATASET_LICENSE_LINE =
  "# license: CC BY 4.0 — attribution: whalewatch.wired.fund";

const HEADER = [
  "emitted_at_utc",
  "formation_at_utc",
  "strategy_code",
  "strategy_name",
  "condition_id",
  "outcome",
  "title",
  "entry_price",
  "settled",
  "won",
  "exit_price",
  "realized_pnl",
  "settled_at_utc",
].join(",");

/** RFC 4180 转义:含 , " 换行 的字段加引号,引号翻倍。 */
export function csvField(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const iso = (sec: number | null): string =>
  sec == null ? "" : new Date(sec * 1000).toISOString();

interface Row {
  emitted_at: number;
  formation_ts: number | null;
  name: string | null;
  condition_id: string;
  outcome: string;
  title: string | null;
  entry_price: number | null;
  settled: number;
  won: number | null;
  exit_price: number | null;
  realized_pnl: number | null;
  settled_ts: number | null;
}

/**
 * 全量已发布信号 → CSV 文本。头三行是 `#` 注释(license/生成时刻/口径),
 * pandas 用 `comment="#"` 读,文档写明;正文首行是列头。
 */
export function buildRecordCsv(
  db: DB,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const rows = db
    .prepare(
      `SELECT s.emitted_at, s.formation_ts, st.name, s.condition_id, s.outcome,
              s.title, s.entry_price, s.settled, s.won, s.exit_price,
              s.realized_pnl, s.settled_ts
       FROM strategy_signals s
       JOIN follow_strategies st ON st.id = s.strategy_id
       WHERE EXISTS (SELECT 1 FROM signal_deliveries d
                     WHERE d.signal_id = s.id AND d.event = 'entry'
                       AND d.status = 'sent')
       ORDER BY s.emitted_at ASC, s.id ASC`,
    )
    .all() as Row[];

  const lines = [
    DATASET_LICENSE_LINE,
    `# generated: ${iso(nowSec)} — rows: ${rows.length} (published signals only; unsettled rows included with empty won)`,
    "# integrity: per-day sha256 digest chain via /api/record — this CSV is a convenience export, not the tamper-evidence carrier",
    HEADER,
  ];
  for (const r of rows) {
    lines.push(
      [
        iso(r.emitted_at),
        iso(r.formation_ts),
        csvField(r.name ? strategyCode(r.name) : null),
        csvField(r.name),
        csvField(r.condition_id),
        csvField(r.outcome),
        csvField(r.title),
        csvField(r.entry_price),
        String(r.settled === 1 ? 1 : 0),
        r.won == null ? "" : r.won === 1 ? "true" : "false",
        csvField(r.exit_price),
        csvField(r.realized_pnl),
        iso(r.settled_ts),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
