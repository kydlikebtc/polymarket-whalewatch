import { createHash } from "crypto";
import type { DB } from "./db";

// 参数指纹 —— 存证链的第二条腿(2026-09-07)。
//
// 问题:每日存证链只链**已发布信号**,回答的是「这些信号是事前发的、没删没改」。
// 它回答不了另一半:「产生这些信号的规则,当时是不是现在说的这一套」。阈值、
// 档位参数、投递开关全都是运营者随时可改的,而 config_history 这条审计轨躺在
// 本地库里 —— 谁也没法验证它没被一起改。于是「阈值没被悄悄挪过」目前只是
// 一句需要信任运营者的话,恰恰是本项目最不该靠信任的地方。
//
// 为什么是指纹而不是公开原值:`GET /api/alert-config` 是**刻意**关在
// ADMIN_TOKEN 后面的 —— 「阈值是一套规则集,知道了就能规避;这和一份可被
// 验证的战绩是两回事」(见 lib/apiGuard 与 ARCHITECTURE 的请求路径一节)。
// 哈希承诺正好落在这两者之间:不泄露任何参数值,却把「当天在用的是这一套」
// 钉死在一条公开时间戳上。事后想改口,必须拿出能对上当日指纹的原值。
//
// 因此它能证明与不能证明的,必须写清楚(/record 与 TG 文案都照抄这两句):
//   能:参数在哪一天变过 —— 指纹变了就是变了,而且变的日期被公开钉死;
//   不能:参数**是什么** —— 完成验证需要运营者出示原值(承诺-揭示两步)。
//
// 与信号链**分开链**是硬要求:信号链必须能被任何拿到公开 CSV 的人独立复算,
// 把参数混进同一条链会让它当场失去这个性质。两条链各自 prev、同一条消息里
// 一起公布。

/** 参数快照的一条目 —— 稳定排序后拼成待哈希文本。 */
export interface ParamsEntry {
  kind: "strategy" | "bus_def" | "config";
  key: string;
  value: string;
}

/**
 * JSON 规范化:解析后按键名排序重新序列化,让「同一套参数换个键序写入」
 * 不产生假变更。解析不了就原样返回(脏值也是当时的事实,照样入指纹)。
 */
export function canonicalJson(raw: string | null): string {
  if (raw == null) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    return stableStringify(parsed);
  } catch {
    return raw;
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * 当前规则集的完整快照。三个来源,合起来就是「信号为什么会长成这样」:
 *
 *  1. `follow_strategies` —— 19 档的检测参数、启停、是否进对外投递;
 *  2. `bus_defs` —— ① 原始事件线的阈值档(large/consensus/discovery);
 *  3. `config` 里**曾经出现在 config_history 的每一个键**的当前值。
 *
 * 第 3 条的选法是刻意的:config 表里混着日门标记、迁移版本号、引擎启动时刻
 * 这些每天都在变的运行态,把它们混进指纹会让指纹天天变、从而什么也不说明。
 * 而「写过 config_history」恰好就是「运营者改得动的东西」的精确定义 ——
 * 那条审计轨的写入方全是设置类模块(alertConditions / xParams / xSettings /
 * xTemplates / cardSettings / signalBus)。新增任何一项运营可调设置,只要它
 * 照惯例记 config_history,就自动进入指纹,无需改本文件。
 */
export function buildParamsSnapshot(db: DB): ParamsEntry[] {
  const out: ParamsEntry[] = [];
  const strategies = db
    .prepare(
      `SELECT id, name, params_json, enabled, push_enabled
         FROM follow_strategies ORDER BY id ASC`,
    )
    .all() as {
    id: number;
    name: string;
    params_json: string | null;
    enabled: number;
    push_enabled: number;
  }[];
  for (const s of strategies) {
    out.push({
      kind: "strategy",
      key: String(s.id),
      value: `${s.name}|${s.enabled ? 1 : 0}|${s.push_enabled ? 1 : 0}|${canonicalJson(s.params_json)}`,
    });
  }
  const defs = db
    .prepare(
      `SELECT id, source_type, label, params_json, enabled
         FROM bus_defs ORDER BY id ASC`,
    )
    .all() as {
    id: number;
    source_type: string;
    label: string;
    params_json: string | null;
    enabled: number;
  }[];
  for (const d of defs) {
    out.push({
      kind: "bus_def",
      key: String(d.id),
      value: `${d.source_type}|${d.label}|${d.enabled ? 1 : 0}|${canonicalJson(d.params_json)}`,
    });
  }
  const keys = (
    db
      .prepare("SELECT DISTINCT key FROM config_history ORDER BY key ASC")
      .all() as { key: string }[]
  ).map((r) => r.key);
  const get = db.prepare("SELECT value FROM config WHERE key = ?");
  for (const k of keys) {
    const row = get.get(k) as { value: string | null } | undefined;
    out.push({ kind: "config", key: k, value: canonicalJson(row?.value ?? null) });
  }
  return out;
}

/** 快照 → 待哈希文本。逐条一行,行内用 \t 分隔,顺序即 buildParamsSnapshot 的顺序。 */
export function paramsPreimage(entries: ParamsEntry[]): string {
  return entries.map((e) => `${e.kind}\t${e.key}\t${e.value}`).join("\n");
}

/**
 * 参数指纹:sha256(快照文本)。**刻意不链式** —— 与信号链的取舍正好相反。
 *
 * 信号链要的是「改历史要改此后每一天」,所以必须链;参数指纹要的是
 * **跨日可比**:同一套规则今天和昨天必须给出同一个值,读者一眼看出
 * 「9 月 5 日这天规则动过」。一旦混入 prev,每天的值都不同,那句唯一
 * 想说的话就说不出来了。
 *
 * 防篡改由另一层给:每日指纹逐条发进不可编辑的公开频道,并逐日落库
 * (signal_digests),两边对不上就是改过。
 */
export function computeParamsDigest(entries: ParamsEntry[]): string {
  return createHash("sha256").update(paramsPreimage(entries)).digest("hex");
}
