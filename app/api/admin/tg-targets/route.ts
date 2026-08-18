import { z } from "zod";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { parseConfig } from "../../../../lib/config";
import { openDb } from "../../../../lib/db";
import { sendMessage } from "../../../../lib/telegram";
import {
  addTarget,
  deleteTarget,
  listTargets,
  resolveTargets,
  setPaused,
  updateTarget,
} from "../../../../lib/tgTargets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TG 投递目标管理(/manage 的「📣 TG 推送」区)。
// 与 x-accounts / keys / webhooks 同一套运营者写凭证(ADMIN_TOKEN)。
//
// 凭据纪律:bot_token 只进不出 —— 新增时收下写库,此后任何读接口都不回显
// (listTargets 的返回类型压根没有该字段,只给一个尾部指纹供辨认)。

const Kinds = z.object({
  large: z.boolean().optional(),
  consensus: z.boolean().optional(),
  strategy: z.boolean().optional(),
  ops: z.boolean().optional(),
});

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    label: z.string().max(60).default(""),
    botToken: z.string().min(10).max(200),
    chatId: z.string().min(1).max(120),
    kinds: Kinds.optional(),
    delayMin: z.number().int().min(0).max(1440).optional(),
  }),
  z.object({
    action: z.literal("update"),
    id: z.number().int().positive(),
    label: z.string().max(60).optional(),
    kinds: Kinds.optional(),
    delayMin: z.number().int().min(0).max(1440).optional(),
  }),
  z.object({
    action: z.literal("pause"),
    id: z.number().int().positive(),
    paused: z.boolean(),
  }),
  z.object({ action: z.literal("delete"), id: z.number().int().positive() }),
  // 连通性自测:向该目标发一条测试消息。凭据从库里取,不经前端往返。
  z.object({ action: z.literal("test"), id: z.number().int().positive() }),
]);

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
    const targets = listTargets(db);
    // 当前实际生效的解析结果:库里没有行时会回退 env,后台要能一眼看出
    // 「现在到底在往哪儿发」,而不是看到空列表以为没在推。
    const active = resolveTargets(db, {
      botToken: cfg.telegramBotToken,
      alertChatId: cfg.telegramChannelId,
      signalChatId: cfg.telegramSignalChannelId,
      publicDelayMin: cfg.signalPublicDelayMin,
    }).map((t) => ({
      label: t.label,
      chatId: t.chatId,
      kinds: t.kinds,
      delayMin: t.delayMin,
      source: t.source,
    }));
    return Response.json({
      targets,
      active,
      // env 回退是否可用(库里清空后会落到它)。
      envConfigured: !!(cfg.telegramBotToken && cfg.telegramChannelId),
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
  const limited = guardExpensive(req, "admin-tg-targets", LIMITS, {});
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
  const db = openDash();
  try {
    if (body.action === "add") {
      try {
        const id = addTarget(db, {
          label: body.label,
          botToken: body.botToken,
          chatId: body.chatId,
          kinds: body.kinds,
          delayMin: body.delayMin,
        });
        return Response.json({ ok: true, id });
      } catch (e) {
        // UNIQUE(bot_token, chat_id) 冲突是最常见的失败,给人话。
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json(
          {
            error: msg.includes("UNIQUE")
              ? "这个 bot 已经在向该频道推送了(同一组合只能登记一次)"
              : `新增失败:${msg}`,
          },
          { status: 400 },
        );
      }
    }
    if (body.action === "update") {
      return updateTarget(db, body.id, {
        label: body.label,
        kinds: body.kinds,
        delayMin: body.delayMin,
      })
        ? Response.json({ ok: true })
        : Response.json({ error: "目标不存在" }, { status: 404 });
    }
    if (body.action === "pause") {
      return setPaused(db, body.id, body.paused)
        ? Response.json({ ok: true })
        : Response.json({ error: "目标不存在" }, { status: 404 });
    }
    if (body.action === "test") {
      const cfg = parseConfig(process.env);
      const target = resolveTargets(db, {
        botToken: cfg.telegramBotToken,
        alertChatId: cfg.telegramChannelId,
        signalChatId: cfg.telegramSignalChannelId,
        publicDelayMin: cfg.signalPublicDelayMin,
      }).find((t) => t.id === body.id);
      if (!target) {
        return Response.json(
          { error: "目标不存在或已暂停(暂停中的目标不发测试消息)" },
          { status: 404 },
        );
      }
      try {
        await sendMessage(
          target.creds,
          "🔧 <b>WhaleWatch 连通性测试</b>\n这条消息来自 /manage 的「测试」按钮 —— 收到即表示该 bot 有权限向本频道发消息。",
        );
        return Response.json({ ok: true });
      } catch (e) {
        return Response.json(
          {
            error: `发送失败:${e instanceof Error ? e.message : String(e)}(常见原因:bot 不是该频道管理员 / chat id 写错)`,
          },
          { status: 502 },
        );
      }
    }
    return deleteTarget(db, body.id)
      ? Response.json({ ok: true })
      : Response.json({ error: "目标不存在" }, { status: 404 });
  } finally {
    db.close();
  }
}
