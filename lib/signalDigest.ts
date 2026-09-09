// Bare specifier(next.config.mjs 约定)。
import { createHash } from "crypto";
import type { DB } from "./db";
import {
  DIGEST_GENESIS,
  digestPreimage,
  type DigestRow,
} from "./digestPreimage";
import {
  buildParamsSnapshot,
  computeParamsDigest,
} from "./paramsDigest";
import { ENTRY_MAX_AGE_SEC } from "./signalDelivery";

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
//
// --- 2026-09-07 三处补强(设计见 docs/plans/2026-09-07-*-round4.md #13/#14)---
//
//  ① **发布时刻推迟到 06:00 UTC**,让成员集可证明地冻结。此前摘要在 UTC 零点
//     一过就算,而投递有延迟档(minEmitAgeSec)—— 23:50 发出、延迟 30 分钟的
//     信号在 00:20 才 sent,它属于昨天却没进昨天的摘要。于是第三方拿公开导出
//     复算必然对不上,而对不上正是这套存证唯一要报的警。ENTRY_MAX_AGE_SEC(6h)
//     之后任何昨日 entry 都只会 skipped_stale、不可能再 sent,所以过了 06:00
//     成员集**结构上**冻结,复算才成为一件确定的事。
//  ② **逐日落库 `signal_digests`**。此前全库只留一个 `signal_digest_prev`
//     链尾,历史摘要只存在于 TG 消息里 —— 想验证得去人肉翻频道。落库后
//     /api/record 直接把逐日摘要发出来,验证脚本/浏览器按钮才有对账的另一半。
//  ③ **参数指纹**(lib/paramsDigest)同条消息公布。信号链回答「信号没被改」,
//     参数指纹回答「产生信号的规则没被悄悄挪」。两者刻意用不同构造:信号是
//     链式(改历史要改此后每一天),参数是**无链快照**(同一套规则每天给出
//     同一个值,读者才看得出「这天规则动过」)。分开还有一条硬要求:信号链
//     必须能被任何拿到公开 CSV 的人独立复算,混进参数就当场做不到了。

export const DIGEST_DAY_KEY = "signal_digest_last_day";
export const DIGEST_PREV_KEY = "signal_digest_prev";
// 链的定义(preimage / 创世哨兵)住在零依赖的 lib/digestPreimage —— 复算侧
// 要在浏览器里跑,不能顺着 import 把 node:crypto 与投递栈拖进客户端 bundle。
// 这里原样再导出,既有调用方无需改动。
export { DIGEST_GENESIS, digestPreimage };
export type { DigestRow };

/**
 * 摘要在每日几点(UTC)结算。取 ENTRY_MAX_AGE_SEC 的整小时上取整 ——
 * 过了这个点,昨日的 entry 只会 skipped_stale,成员集不可能再变。
 * 直接由那个常量推导而不是写死 6:阈值哪天改了,这里跟着走。
 */
export const DIGEST_POST_UTC_HOUR = Math.ceil(ENTRY_MAX_AGE_SEC / 3600);

const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/** 链式摘要:h_i = sha256(h_{i-1} | id | 档名 | 市场 | 方向 | 发布时刻 | 入场价)。 */
export function computeDigestChain(prevHex: string, rows: DigestRow[]): string {
  let h = prevHex;
  for (const r of rows) {
    h = createHash("sha256").update(digestPreimage(h, r)).digest("hex");
  }
  return h;
}

export interface DigestResult {
  sent: boolean;
  day: string;
  digest: string;
  count: number;
  paramsDigest: string;
  /** 参数指纹与上一条存证行相比是否变了;null = 没有上一条可比(首次记录)。 */
  paramsChanged: boolean | null;
}

/** 逐日存证行(落库 + /api/record 对外)。 */
export interface DigestDay {
  day: string;
  digest: string;
  prev: string;
  count: number;
  paramsDigest: string | null;
  createdAt: number;
}

export function listDigestDays(db: DB, limit = 30): DigestDay[] {
  return (
    db
      .prepare(
        `SELECT day, digest, prev, count, params_digest, created_at
           FROM signal_digests ORDER BY day DESC LIMIT ?`,
      )
      .all(limit) as {
      day: string;
      digest: string;
      prev: string;
      count: number;
      params_digest: string | null;
      created_at: number;
    }[]
  ).map((r) => ({
    day: r.day,
    digest: r.digest,
    prev: r.prev,
    count: r.count,
    paramsDigest: r.params_digest,
    createdAt: r.created_at,
  }));
}

export async function maybeDailySignalDigest(
  db: DB,
  send: ((html: string) => Promise<void>) | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<DigestResult | null> {
  if (!send) return null;
  const today = utcDay(nowSec);
  // 成员集冻结闸(见文件头 ①)。不到点就等下一轮 —— 消耗当日会让摘要整天
  // 不发,而不是晚发。
  if (new Date(nowSec * 1000).getUTCHours() < DIGEST_POST_UTC_HOUR) return null;
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

  const cfg = (key: string): string | null =>
    (
      db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
        | { value: string | null }
        | undefined
    )?.value ?? null;

  const prev = cfg(DIGEST_PREV_KEY) ?? DIGEST_GENESIS;
  const digest = computeDigestChain(prev, rows);
  const yesterday = utcDay(dayStartSec - 43_200);
  const paramsDigest = computeParamsDigest(buildParamsSnapshot(db));
  // 「参数变没变」比的是**上一条存证行**的指纹。指纹无链,所以规则没动时
  // 两天必然相等 —— 这条比较能成立,正是不给参数指纹加链的全部理由。
  const prevRow = db
    .prepare(
      "SELECT params_digest FROM signal_digests WHERE day < ? ORDER BY day DESC LIMIT 1",
    )
    .get(yesterday) as { params_digest: string | null } | undefined;
  const paramsChanged =
    prevRow?.params_digest == null ? null : prevRow.params_digest !== paramsDigest;

  // claim-first:先记 day / 新 prev / 逐日行,再发送 —— 瞬态失败损失一条消息,
  // 链本身保持一致(明日的链建立在今天算出的 prev 上)。
  const put = db.prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
  );
  put.run(DIGEST_DAY_KEY, today);
  put.run(DIGEST_PREV_KEY, digest);
  db.prepare(
    `INSERT OR REPLACE INTO signal_digests
       (day, digest, prev, count, params_digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(yesterday, digest, prev, rows.length, paramsDigest, nowSec);

  // 静默条件比此前更窄:昨日无已发布信号**且**参数没变才不发。
  // 「今天没有信号」是可以沉默的事实;「规则改了」不是 —— 那正是这条链
  // 新增的一半价值,沉默掉它等于没做。
  if (rows.length === 0 && paramsChanged !== true) {
    return {
      sent: false,
      day: yesterday,
      digest,
      count: 0,
      paramsDigest,
      paramsChanged,
    };
  }

  const paramsLine =
    paramsChanged === true
      ? `⚠️ 参数指纹 <code>${paramsDigest.slice(0, 12)}…</code> —— 与前一日<b>不同</b>,规则集当日有改动`
      : `参数指纹 <code>${paramsDigest.slice(0, 12)}…</code>${paramsChanged === false ? "(与前一日相同)" : "(首次记录)"}`;
  const html =
    (rows.length > 0
      ? `🔏 信号存证 ${yesterday} · ${rows.length} 条已发布信号\n` +
        `digest <code>${digest.slice(0, 16)}…</code> · 前链 <code>${prev === DIGEST_GENESIS ? prev : prev.slice(0, 8)}</code>\n`
      : `🔏 信号存证 ${yesterday} · 0 条已发布信号(链尾不变)\n`) +
    `${paramsLine}\n` +
    `按 id 升序对每条信号复算 sha256(前值|id|档位|市场|方向|发布时刻|入场价) 即可验证 —— 事后删改任何一条,此摘要必变;参数指纹只承诺「当日在用的是这一套」,核对需运营者出示原值`;
  await send(html);
  return {
    sent: true,
    day: yesterday,
    digest,
    count: rows.length,
    paramsDigest,
    paramsChanged,
  };
}
