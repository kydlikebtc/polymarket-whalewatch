import { parseConfig } from "../../../../lib/config";
import { openDb } from "../../../../lib/db";
import { sendMessage } from "../../../../lib/telegram";
import { handleXQueueAck } from "../../../../lib/xQueueRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 插件回报一条帖的结局。四种 result 见设计文档 §8 的错误分类表。
//
// channel_error(找不到编辑器 / 跳到登录页)会额外走一条 Telegram 告警:
// 那是**通道级**故障而不是单帖失败,不报出来的话队列会静默积压到 TTL 全部
// 作废,而运营者以为一切正常。
export async function POST(req: Request) {
  const cfg = parseConfig(process.env);
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  try {
    return await handleXQueueAck(req, db, {
      notify: cfg.telegramEnabled
        ? (message) =>
            sendMessage(
              {
                botToken: cfg.telegramBotToken,
                chatId: cfg.telegramChannelId,
              },
              message,
            )
        : undefined,
    });
  } finally {
    db.close();
  }
}
