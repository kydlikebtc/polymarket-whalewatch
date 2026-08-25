import { z } from "zod";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { parseConfig } from "../../../../lib/config";
import { openDb } from "../../../../lib/db";
import {
  activateAccount,
  deleteAccount,
  listAccounts,
  savePending,
} from "../../../../lib/xAccounts";
import { startAuth } from "../../../../lib/xOauth";
import {
  DEFAULT_X_KINDS,
  getXKindSwitches,
  getXPostHistogram,
  getXPostHistory,
  setXKindSwitches,
  type XKindSwitches,
  type XPostKind,
} from "../../../../lib/xSettings";
import {
  getXTemplates,
  setXTemplates,
  validateXTemplate,
} from "../../../../lib/xTemplates";
import { TEMPLATE_VOCAB } from "../../../../lib/xComposer";
import {
  defaultXParams,
  getXBroadcastParams,
  setXBroadcastParams,
  type XParamEnvDefaults,
} from "../../../../lib/xParams";
import type { AppConfig } from "../../../../lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 𝕏 播报账号管理(/manage 的「𝕏 播报账号」区)。
// 全部动作走 ADMIN_TOKEN(x-admin-token),与 keys/webhooks 同一套运营者
// 写凭证。注意:OAuth 回调 GET /api/x-callback 不能要求令牌(X 直接跳
// 浏览器过来,带不上自定义头),它的防重放靠 pending 一次性消费。
// access token 属于账号故进库;consumer key/secret 属于 App,只从 .env 读。

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("activate"), id: z.number().int().positive() }),
  z.object({ action: z.literal("delete"), id: z.number().int().positive() }),
  z.object({
    action: z.literal("kinds"),
    // 逐键可选:UI 只提交被改动的那个开关,不必回传整份配置。
    kinds: z.object({
      whale: z.boolean().optional(),
      consensus: z.boolean().optional(),
      pregame: z.boolean().optional(),
      weekly: z.boolean().optional(),
      settled: z.boolean().optional(),
    }),
  }),
  z.object({
    action: z.literal("params"),
    // 数字参数(与 kinds 同款合并语义:缺键 = 不动)。规则与
    // lib/xParams 的读侧校验同一套 —— 读写两侧同规,见设计文档。
    // cap 最小 1:「不发」永远用类型开关表达,cap=0 是配置陷阱。
    params: z.object({
      budgetUsd: z.number().finite().positive().optional(),
      // null = 明确改回「不限」(与「键缺失 = 不动」不同)。
      dailySpendCapUsd: z.number().finite().positive().nullable().optional(),
      weeklySpendCapUsd: z.number().finite().positive().nullable().optional(),
      whaleMinTradeUsd: z.number().finite().positive().optional(),
      whaleDailyCap: z.number().int().min(1).optional(),
      whaleSirenUsd: z.number().finite().positive().optional(),
      consensusDailyCap: z.number().int().min(1).nullable().optional(),
      pregameDailyCap: z.number().int().min(1).optional(),
      pregameMinH: z.number().finite().min(0).max(168).optional(),
      pregameMaxH: z.number().finite().positive().max(168).optional(),
      settledDailyCap: z.number().int().min(1).optional(),
      weeklyUtcHour: z.number().int().min(0).max(23).optional(),
    }),
  }),
  z.object({
    action: z.literal("templates"),
    // 文案模板(逐键可选合并):null/空串 = 恢复内置文案;非空串会做
    // 词表/{title}/URL/底座长度校验(lib/xTemplates),不合法整单 400。
    templates: z.object({
      whale: z.string().max(2000).nullable().optional(),
      consensus: z.string().max(2000).nullable().optional(),
      pregame: z.string().max(2000).nullable().optional(),
      weekly: z.string().max(2000).nullable().optional(),
      settled: z.string().max(2000).nullable().optional(),
    }),
  }),
]);

// budget/whale 阈值的出厂默认来自 env(未后台保存过的部署行为不变)。
function envDefaults(cfg: AppConfig): XParamEnvDefaults {
  return {
    budgetUsd: cfg.xMonthlyBudgetUsd,
    whaleMinTradeUsd: cfg.xMinTradeUsd,
  };
}

const LIMITS = { perIp: 30, global: 60 };

function openDash() {
  return openDb(process.env.DASH_DB ?? "data.sqlite");
}

export async function GET(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const db = openDash();
  try {
    const cfg = parseConfig(process.env);
    const history = getXPostHistory(db, Math.floor(Date.now() / 1000));
    const params = getXBroadcastParams(db, envDefaults(cfg));
    return Response.json({
      accounts: listAccounts(db),
      kinds: getXKindSwitches(db),
      history,
      // 数字参数:params = 生效值(后台保存过的优先,否则出厂),
      // defaults = 出厂值(UI 拿它标注「默认 N」,含 env 派生的两项)。
      params,
      defaults: defaultXParams(envDefaults(cfg)),
      // 文案模板(null = 内置)与各 kind 的占位符词表(UI 图例)。
      templates: getXTemplates(db),
      templateVocab: TEMPLATE_VOCAB,
      // 时间分布:近 14 天,天 × UTC 小时 × 类型的 posted 计数。
      histogram: getXPostHistogram(db, Math.floor(Date.now() / 1000)),
      // 播报历史头部的「$X 预算」用生效值 —— 后台改过预算后这里必须如实。
      budgetUsd: params.budgetUsd,
      // App 未配置时前端直接提示去 .env 补,而不是让人点了授权才报错。
      appConfigured: cfg.xAppConfigured,
      // env 单账号回退是否在用(库里没有账号时才生效)。
      envFallback: !!(cfg.xAccessToken && cfg.xAccessSecret),
      callbackUrl: `${cfg.publicUrl}/api/x-callback`,
    });
  } finally {
    db.close();
  }
}

export async function POST(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-x-accounts", LIMITS, {});
  if (limited) return limited;
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return Response.json(
      { error: `请求体不合法:${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }
  const cfg = parseConfig(process.env);
  const db = openDash();
  try {
    if (body.action === "start") {
      if (!cfg.xAppConfigured) {
        return Response.json(
          {
            error:
              "未配置 X App 凭据:请先在服务器 .env 设置 X_API_KEY / X_API_SECRET 并重启",
          },
          { status: 400 },
        );
      }
      // 回调地址必须与 X App 后台登记的 Callback URI 完全一致。
      const callbackUrl = `${cfg.publicUrl}/api/x-callback`;
      try {
        const link = await startAuth(
          { apiKey: cfg.xApiKey, apiSecret: cfg.xApiSecret },
          callbackUrl,
        );
        savePending(
          db,
          link.oauthToken,
          link.oauthTokenSecret,
          Math.floor(Date.now() / 1000),
        );
        return Response.json({ url: link.url, callbackUrl });
      } catch (e) {
        // 最常见的失败:callback 未登记在 App 后台(X 报 403)。
        return Response.json(
          {
            error: `向 X 请求授权链接失败:${e instanceof Error ? e.message : String(e)}(请确认 App 后台的 Callback URI 已登记 ${callbackUrl})`,
          },
          { status: 502 },
        );
      }
    }
    if (body.action === "kinds") {
      const next: XKindSwitches = { ...getXKindSwitches(db) };
      for (const k of Object.keys(DEFAULT_X_KINDS) as XPostKind[]) {
        const v = body.kinds[k];
        if (typeof v === "boolean") next[k] = v;
      }
      setXKindSwitches(db, next);
      return Response.json({ ok: true, kinds: next });
    }
    if (body.action === "params") {
      const next = { ...getXBroadcastParams(db, envDefaults(cfg)) };
      // 通用合并:undefined = 没动这个键;null = 明确改回「不限」。zod 已
      // 剥掉未知键并做过范围校验,这里不必逐键手抄 —— 手抄白名单在加新
      // 参数时必漏(dailySpendCapUsd 就漏过一次,route 测试抓的)。
      for (const [k, v] of Object.entries(body.params)) {
        if (v !== undefined) {
          (next as unknown as Record<string, number | null>)[k] = v;
        }
      }
      // 跨键约束:窗口不能倒挂(读侧遇到会静默回落默认,但写侧必须直接
      // 拒绝 —— 静默回落对正在调参的运营者是惊吓)。
      if (!(next.pregameMinH < next.pregameMaxH)) {
        return Response.json(
          {
            error: `赛前窗口不合法:下限 ${next.pregameMinH}h 必须小于上限 ${next.pregameMaxH}h`,
          },
          { status: 400 },
        );
      }
      setXBroadcastParams(db, next);
      return Response.json({ ok: true, params: next });
    }
    if (body.action === "templates") {
      const next = { ...getXTemplates(db) };
      for (const k of Object.keys(next) as XPostKind[]) {
        const v = body.templates[k];
        if (v === undefined) continue; // 缺键 = 不动
        const trimmed = v === null ? "" : v.trim();
        if (trimmed === "") {
          next[k] = null; // 空 = 恢复内置文案
          continue;
        }
        const check = validateXTemplate(k, trimmed);
        if (!check.ok) {
          // 整单拒绝而不是跳过坏键:静默丢弃正在编辑的文案是最坏的体验。
          return Response.json(
            { error: `「${k}」模板不合法:${check.error}` },
            { status: 400 },
          );
        }
        next[k] = trimmed;
      }
      setXTemplates(db, next);
      return Response.json({ ok: true, templates: next });
    }
    if (body.action === "activate") {
      return activateAccount(db, body.id)
        ? Response.json({ ok: true })
        : Response.json({ error: "账号不存在" }, { status: 404 });
    }
    return deleteAccount(db, body.id)
      ? Response.json({ ok: true })
      : Response.json({ error: "账号不存在" }, { status: 404 });
  } finally {
    db.close();
  }
}
