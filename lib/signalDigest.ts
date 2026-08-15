// Bare specifier(next.config.mjs 约定)。
import { createHash } from "crypto";
import type { DB } from "./db";

// 对外信号批次 3:每日存证 digest(可信度产品化的核心工件)。
//
// 承诺:「信号是事前发布的,没删帖没改单」。实现:每 UTC 日把昨日全部
// **已发布**(存在 status='sent' 的 entry 投递)信号按 id 升序做链式 sha256,
// 摘要发进公开 TG 频道。频道消息带 Telegram 官方时间戳、频道历史不可编辑,
// 于是任何第三方拿当日信号明细(拉取 API / 公开频道消息本身)即可复算摘要
// 比对 —— 事后删改任何一条,摘要必变。这是零基础设施成本的 timestamping,
// 对着 PolyPick 式假社会证明的反面做(landing.js 'fake-but-believable wins')。
//
// 链式而非逐日独立:prev 摘要参与次日计算,改历史要改此后每一天 —— 与频道里
// 已发出的每条摘要消息全部对不上。
//
// day-gate 纪律与 maybeDailySelfCheck 相同:claim-first(先记 day 再发送),
// 瞬态发送失败最多损失一天的存证消息,绝不重复轰炸;无 send(公开频道未配置)
// 完全 no-op 且不消耗当日 —— 当日中途配好凭证仍能补发。

export const DIGEST_DAY_KEY = "signal_digest_last_day";
export const DIGEST_PREV_KEY = "signal_digest_prev";
/** 创世 prev:第一天之前没有链,固定哨兵让复算者有确定起点。 */
export const DIGEST_GENESIS = "genesis";

export interface DigestRow {
  id: number;
  strategyName: string;
  conditionId: string;
  outcome: string;
  emittedAt: number;
  entryPrice: number | null;
}

const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/** 链式摘要:h_i = sha256(h_{i-1} | id | 档名 | 市场 | 方向 | 发布时刻 | 入场价)。 */
export function computeDigestChain(prevHex: string, rows: DigestRow[]): string {
  let h = prevHex;
  for (const r of rows) {
    h = createHash("sha256")
      .update(
        `${h}|${r.id}|${r.strategyName}|${r.conditionId}|${r.outcome}|${r.emittedAt}|${r.entryPrice ?? "null"}`,
      )
      .digest("hex");
  }
  return h;
}

export interface DigestResult {
  sent: boolean;
  day: string;
  digest: string;
  count: number;
}

export async function maybeDailySignalDigest(
  db: DB,
  send: ((html: string) => Promise<void>) | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<DigestResult | null> {
  if (!send) return null;
  const today = utcDay(nowSec);
  const last = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(DIGEST_DAY_KEY) as { value: string | null } | undefined;
  if (last?.value === today) return null;

  // 昨日 UTC 窗口 [dayStart-86400, dayStart)。
  const dayStartSec = Math.floor(Date.parse(`${today}T00:00:00Z`) / 1000);
  const rows = db
    .prepare(
      `SELECT s.id, st.name AS strategyName, s.condition_id AS conditionId,
              s.outcome, s.emitted_at AS emittedAt, s.entry_price AS entryPrice
       FROM strategy_signals s
       JOIN follow_strategies st ON st.id = s.strategy_id
       WHERE s.emitted_at >= ? AND s.emitted_at < ?
         AND EXISTS (SELECT 1 FROM signal_deliveries d
                     WHERE d.signal_id = s.id AND d.event = 'entry' AND d.status = 'sent')
       ORDER BY s.id ASC`,
    )
    .all(dayStartSec - 86_400, dayStartSec) as DigestRow[];

  if (rows.length === 0) {
    // 昨日无已发布信号:是已封闭的最终事实,消耗当日、不发空消息。
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
      DIGEST_DAY_KEY,
      today,
    );
    return null;
  }

  const prev =
    (
      db
        .prepare("SELECT value FROM config WHERE key = ?")
        .get(DIGEST_PREV_KEY) as { value: string | null } | undefined
    )?.value ?? DIGEST_GENESIS;
  const digest = computeDigestChain(prev, rows);
  const yesterday = utcDay(dayStartSec - 43_200);

  // claim-first:先记 day 与新 prev,再发送 —— 瞬态失败损失一条消息,
  // 链本身保持一致(明日的链建立在今天算出的 prev 上)。
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    DIGEST_DAY_KEY,
    today,
  );
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    DIGEST_PREV_KEY,
    digest,
  );

  const html =
    `🔏 信号存证 ${yesterday} · ${rows.length} 条已发布信号\n` +
    `digest <code>${digest.slice(0, 16)}…</code> · 前链 <code>${prev === DIGEST_GENESIS ? prev : prev.slice(0, 8)}</code>\n` +
    `按 id 升序对每条信号复算 sha256(前值|id|档位|市场|方向|发布时刻|入场价) 即可验证 —— 事后删改任何一条,此摘要必变`;
  await send(html);
  return { sent: true, day: yesterday, digest, count: rows.length };
}
