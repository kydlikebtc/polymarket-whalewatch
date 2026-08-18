// Telegram 投递目标 —— 后台可管理的「bot + 频道」组合。
//
// 背景:TG 推送原本是三个 env 变量写死的(一个 bot token + 告警频道 +
// 策略信号频道),改一次要重启,也没法按频道分别决定发什么。这里把它变成
// 库里的可管理行,与 x_accounts 同一套后台管理骨架。
//
// 与 X 的关键差异:X 一次只能用一个账号发帖(所以是「多账号、一个使用中」),
// 而 TG 可以同时发多个频道 —— 所以这里是「多目标各自独立开关」,没有
// active 的概念,只有 paused。
//
// 四类信号对应引擎里真实存在的四条发送路径,不造新概念:
//   large    大单/巨鲸/聪明钱告警(alertEngine)
//   consensus 聪明钱共识(consensus)
//   strategy 策略档位信号(signalDelivery;delayMin 就是免费/付费分层的杠杆)
//   ops      运维通知:日报自检 / 断更报警 / webhook 熔断 / 每日存证 digest
//
// 凭据纪律:bot_token 进库(与 x_accounts 的 access token 同等对待),但
// **永不出现在任何读取结构里** —— listTargets 的返回类型压根没有这个字段,
// 让「不小心渲染到前端」在类型层就不可能。
import type { DB } from "./db";
import { sendMessage, type TgCreds } from "./telegram";

export type TgKind = "large" | "consensus" | "strategy" | "ops";

export type TgKinds = Record<TgKind, boolean>;

export const DEFAULT_TG_KINDS: TgKinds = {
  large: true,
  consensus: true,
  strategy: false,
  ops: false,
};

export const TG_KINDS: { kind: TgKind; label: string; hint: string }[] = [
  {
    kind: "large",
    label: "🐳 大额成交",
    hint: "单笔达阈值的大单/巨鲸/聪明钱告警。量最大的一类",
  },
  {
    kind: "consensus",
    label: "🔥 聪明钱共识",
    hint: "多个白名单钱包同向买入同一结果。稀有且独家",
  },
  {
    kind: "strategy",
    label: "📡 策略信号",
    hint: "策略档位的进出场信号。可配延迟做免费/付费分层",
  },
  {
    kind: "ops",
    label: "🩺 运维通知",
    hint: "每日自检、断更报警、webhook 熔断、存证摘要。建议只发给自己",
  },
];

/** 管理列表用的一行 —— 刻意不含 bot_token。 */
export interface TgTargetRow {
  id: number;
  label: string;
  chatId: string;
  kinds: TgKinds;
  delayMin: number;
  paused: boolean;
  createdAt: number;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveFailures: number;
  /** bot token 的尾部指纹(如 `…AAA`),供运营者辨认用了哪个 bot,不可还原。 */
  botHint: string;
}

/** 引擎发送时用的解析结果 —— 这里才带凭据。 */
export interface ResolvedTarget {
  /** db 行 id;env 回退时为 null(没有对应行可更新健康度)。 */
  id: number | null;
  label: string;
  creds: TgCreds;
  chatId: string;
  kinds: TgKinds;
  delayMin: number;
  source: "db" | "env";
  /**
   * 投递台账(signal_deliveries)的 channel 键 —— **改动它等于重投**。
   *
   * 主键是 (signal_id, event, channel):换一个键,历史上已投过的信号会被
   * 判定为「本通道没投过」而全部重发一遍。所以 env 回退目标必须沿用现网
   * 的原键(tg_paid / tg_public),只有库里新建的目标才用 tg:<id>。
   */
  deliveryKey: string;
}

function parseKinds(raw: string | null): TgKinds {
  if (!raw) return { ...DEFAULT_TG_KINDS };
  try {
    const p = JSON.parse(raw) as Partial<TgKinds>;
    if (typeof p !== "object" || p === null) return { ...DEFAULT_TG_KINDS };
    const out = { ...DEFAULT_TG_KINDS };
    for (const k of Object.keys(DEFAULT_TG_KINDS) as TgKind[]) {
      if (typeof p[k] === "boolean") out[k] = p[k];
    }
    return out;
  } catch {
    // 一行脏数据不该打死整个推送:回落默认而不是抛。
    return { ...DEFAULT_TG_KINDS };
  }
}

/** token 尾部指纹:够运营者分辨「是哪个 bot」,又不足以还原凭据。 */
function botHintOf(token: string): string {
  const tail = token.slice(-4);
  return tail ? `…${tail}` : "";
}

interface Row {
  id: number;
  label: string;
  bot_token: string;
  chat_id: string;
  kinds: string | null;
  delay_min: number;
  paused: number;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  consecutive_failures: number;
}

const SELECT = `SELECT id, label, bot_token, chat_id, kinds, delay_min, paused,
                       created_at, last_ok_at, last_error, last_error_at,
                       consecutive_failures
                  FROM tg_targets ORDER BY id ASC`;

export function listTargets(db: DB): TgTargetRow[] {
  return (db.prepare(SELECT).all() as Row[]).map((r) => ({
    id: r.id,
    label: r.label,
    chatId: r.chat_id,
    kinds: parseKinds(r.kinds),
    delayMin: r.delay_min,
    paused: r.paused === 1,
    createdAt: r.created_at,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    consecutiveFailures: r.consecutive_failures,
    botHint: botHintOf(r.bot_token),
  }));
}

export function addTarget(
  db: DB,
  i: {
    label: string;
    botToken: string;
    chatId: string;
    kinds?: Partial<TgKinds>;
    delayMin?: number;
    nowSec?: number;
  },
): number {
  const kinds = { ...DEFAULT_TG_KINDS, ...(i.kinds ?? {}) };
  const r = db
    .prepare(
      `INSERT INTO tg_targets (label, bot_token, chat_id, kinds, delay_min, paused, created_at, consecutive_failures)
       VALUES (?, ?, ?, ?, ?, 0, ?, 0)`,
    )
    .run(
      i.label.trim() || i.chatId,
      i.botToken.trim(),
      i.chatId.trim(),
      JSON.stringify(kinds),
      Math.max(0, Math.round(i.delayMin ?? 0)),
      i.nowSec ?? Math.floor(Date.now() / 1000),
    );
  return Number(r.lastInsertRowid);
}

export function updateTarget(
  db: DB,
  id: number,
  patch: { label?: string; kinds?: Partial<TgKinds>; delayMin?: number },
): boolean {
  const cur = (
    db.prepare(SELECT.replace("ORDER BY id ASC", "")).all() as Row[]
  ).find((r) => r.id === id);
  if (!cur) return false;
  const kinds = patch.kinds
    ? { ...parseKinds(cur.kinds), ...patch.kinds }
    : parseKinds(cur.kinds);
  return (
    db
      .prepare(
        "UPDATE tg_targets SET label = ?, kinds = ?, delay_min = ? WHERE id = ?",
      )
      .run(
        (patch.label ?? cur.label).trim() || cur.chat_id,
        JSON.stringify(kinds),
        patch.delayMin != null
          ? Math.max(0, Math.round(patch.delayMin))
          : cur.delay_min,
        id,
      ).changes === 1
  );
}

export function setPaused(db: DB, id: number, paused: boolean): boolean {
  return (
    db
      .prepare("UPDATE tg_targets SET paused = ? WHERE id = ?")
      .run(paused ? 1 : 0, id).changes === 1
  );
}

export function deleteTarget(db: DB, id: number): boolean {
  return (
    db.prepare("DELETE FROM tg_targets WHERE id = ?").run(id).changes === 1
  );
}

/** 发送结果回写:成功清零失败计数,失败累加并留最后一条错误。 */
export function markSendResult(
  db: DB,
  id: number,
  r: { ok: boolean; error?: string; nowSec?: number },
): void {
  const now = r.nowSec ?? Math.floor(Date.now() / 1000);
  if (r.ok) {
    db.prepare(
      "UPDATE tg_targets SET last_ok_at = ?, consecutive_failures = 0 WHERE id = ?",
    ).run(now, id);
    return;
  }
  db.prepare(
    `UPDATE tg_targets
        SET consecutive_failures = consecutive_failures + 1,
            last_error = ?, last_error_at = ?
      WHERE id = ?`,
  ).run((r.error ?? "").slice(0, 500), now, id);
}

export interface TgEnvFallback {
  botToken: string;
  alertChatId: string;
  signalChatId: string;
  publicDelayMin: number;
}

/**
 * 引擎每轮调用:解出当前该往哪些目标发。
 *
 * **env 向后兼容是生产安全线**:TELEGRAM_BOT_TOKEN / CHANNEL_ID 是现网正在
 * 用的配置,加了后台管理就忽略它们,等于一次升级打断所有推送。规则是
 * 「库里有启用行就完全用库里的,一行都没有才回退 env」—— 不叠加,否则同一
 * 条消息会推两遍。
 *
 * 全部被暂停时**不回退 env**:那是运营者的明确意图,不该被「善意」覆盖。
 */
export function resolveTargets(db: DB, env: TgEnvFallback): ResolvedTarget[] {
  const rows = (db.prepare(SELECT).all() as Row[]).filter(
    (r) => r.paused !== 1,
  );
  if (rows.length > 0) {
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      creds: { botToken: r.bot_token, chatId: r.chat_id },
      chatId: r.chat_id,
      kinds: parseKinds(r.kinds),
      delayMin: r.delay_min,
      source: "db" as const,
      deliveryKey: `tg:${r.id}`,
    }));
  }
  // 库里一行都没有(不是「都暂停了」)→ 复刻现网的两条通道。
  const hasAnyRow =
    (db.prepare("SELECT COUNT(*) AS n FROM tg_targets").get() as { n: number })
      .n > 0;
  if (hasAnyRow) return [];
  const token = env.botToken.trim();
  if (!token) return [];
  const out: ResolvedTarget[] = [];
  if (env.alertChatId.trim()) {
    out.push({
      id: null,
      label: "告警频道(env)",
      creds: { botToken: token, chatId: env.alertChatId.trim() },
      chatId: env.alertChatId.trim(),
      // 现网语义:告警频道收大单/共识/运维,外加延迟版的策略信号
      // (tg_public —— 免费层靠延迟而非阉割字段)。
      kinds: { large: true, consensus: true, strategy: true, ops: true },
      delayMin: env.publicDelayMin,
      source: "env",
      // 现网这条通道的历史键就是 tg_public,不能改。
      deliveryKey: "tg_public",
    });
  }
  if (env.signalChatId.trim()) {
    out.push({
      id: null,
      label: "策略信号频道(env)",
      creds: { botToken: token, chatId: env.signalChatId.trim() },
      chatId: env.signalChatId.trim(),
      // tg_paid:零延迟,只收策略信号。
      kinds: { large: false, consensus: false, strategy: true, ops: false },
      delayMin: 0,
      source: "env",
      deliveryKey: "tg_paid",
    });
  }
  return out;
}

/**
 * 造一个「把这条消息发给所有订阅了 kind 的目标」的函数。
 *
 * 返回 undefined = 当前没有任何目标要这一类,调用方据此整段跳过(与既有
 * `send?: ...` 的可选语义无缝对接)。
 *
 * 三条语义:
 *
 * 1. **每次调用都重新解析目标**。后台改完开关,下一条消息就生效,无需重启
 *    —— 与 X 播报的凭据/开关同一套即时性承诺。SQLite 点查很便宜,而告警
 *    级的发送频率远够不上需要缓存的量级。
 * 2. **失败隔离**:一个频道挂了(被踢出群、chat 不存在)不该拖累其他频道。
 * 3. **部分成功视为成功**(不抛)。上游是 claim-then-send 的 at-least-once:
 *    抛出会让 claim 回滚重来,把已经发成功的那几个频道再推一遍。只有
 *    **全部**失败才抛,那时重试才是对的。
 */
export function makeKindSender(
  db: DB,
  env: TgEnvFallback,
  kind: TgKind,
  opts: {
    /** 注入点:测试替身 / 未来换传输层。默认走真实 Telegram API。 */
    sender?: (creds: TgCreds, html: string) => Promise<void>;
    nowSec?: () => number;
  } = {},
): ((html: string) => Promise<void>) | undefined {
  const send = opts.sender ?? ((c, html) => sendMessage(c, html));
  const now = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  // undefined 只代表「TG 整体没配置」(env 与库都空),不代表「这一类当前
  // 没人订阅」。
  //
  // 区别很要紧:引擎在启动时建一次 sender,若按「这一类有没有订阅者」来
  // 决定,那么冷启动时空库 + 没勾该类 ⇒ 永久 undefined,之后在后台新增
  // 目标也不会生效,除非重启 —— 与「改完下一轮生效、无需重启」的承诺
  // 直接冲突。所以这里只做「有没有任何目标」的判断,具体某类有没有订阅者
  // 留到每次调用时再解析。
  if (resolveTargets(db, env).length === 0) return undefined;

  return async (html: string) => {
    const targets = resolveTargets(db, env).filter((t) => t.kinds[kind]);
    if (targets.length === 0) return;
    const errors: unknown[] = [];
    let ok = 0;
    for (const t of targets) {
      try {
        await send(t.creds, html);
        ok++;
        if (t.id != null) markSendResult(db, t.id, { ok: true, nowSec: now() });
      } catch (e) {
        errors.push(e);
        const msg = e instanceof Error ? e.message : String(e);
        if (t.id != null) {
          markSendResult(db, t.id, { ok: false, error: msg, nowSec: now() });
        }
        console.error(
          `[tg] send failed for target ${t.label} (${t.chatId}) kind=${kind}: ${msg}`,
        );
      }
    }
    // 全部失败才抛:保住上游 claim 回滚重试的语义(见函数头第 3 条)。
    if (ok === 0 && errors.length > 0) throw errors[0];
  };
}
