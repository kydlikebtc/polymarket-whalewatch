// /api/x-queue 与 /api/x-queue/ack 的处理逻辑。
//
// 从 route 文件抽出来是为了能不起 Next 就单测(与 lib/feedAuth 抽出的动机
// 相同):这两个端点是插件通道唯一的对外接口,鉴权、夹紧、幂等的每条分支
// 都必须有测试钉住 —— 它们在生产里的调用方是一个跑在别人浏览器里、
// 我们看不见日志的进程。
import { z } from "zod";
import type { DB } from "./db";
import type { EnvLike } from "./apiGuard";
import { checkXQueueAccess } from "./feedAuth";
import { ackQueued, leaseQueued, type LeasedPost } from "./xQueue";

// 一次最多租借几条。夹紧是必须的:插件一轮拉太多,发到一半浏览器关了,
// 这些条目要等满一个租约 TTL 才回到队列 —— 少量多次比大批量抖动小得多。
export const QUEUE_LIMIT_DEFAULT = 3;
export const QUEUE_LIMIT_MAX = 10;

function clampLimit(raw: string | null): number {
  if (!raw) return QUEUE_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return QUEUE_LIMIT_DEFAULT;
  return Math.min(Math.max(1, Math.floor(n)), QUEUE_LIMIT_MAX);
}

export interface XQueueGetOpts {
  /** 对外站点地址,用来拼周报图卡的绝对地址。 */
  publicUrl: string;
  nowSec?: number;
  env?: EnvLike;
}

/**
 * 租借一批待发帖。
 *
 * weekly 的图卡地址在这里现算,而不是入队时存进表里:图卡是按当前数据实时
 * 渲染的(/api/og/weekly),存一个地址进 x_posts 只会多一列还得跟着 publicUrl
 * 迁移。插件那头拿到 imageUrl 就自己下载 —— 服务端不再像 api 通道那样先
 * 抓一遍图。
 */
export async function handleXQueueGet(
  req: Request,
  db: DB,
  opts: XQueueGetOpts,
): Promise<Response> {
  const access = checkXQueueAccess(req, db, opts.env);
  if (!access.ok) {
    // 鉴权失败零副作用:一条都不能租走(否则一个配错 key 的插件能把队列
    // 反复抽干,每条都要等满租约 TTL 才回来)。
    return Response.json(
      { error: access.error, posts: [] },
      { status: access.status },
    );
  }
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const limit = clampLimit(new URL(req.url).searchParams.get("limit"));
  const leased = leaseQueued(db, { limit, nowSec });
  const posts: LeasedPost[] = leased.map((p) =>
    p.kind === "weekly"
      ? {
          ...p,
          imageUrl: `${opts.publicUrl.replace(/\/+$/, "")}/api/og/weekly`,
        }
      : p,
  );
  if (posts.length > 0) {
    console.log(
      `[xQueue] leased ${posts.length} post(s) to key #${access.keyId}: ${posts.map((p) => `${p.id}/${p.kind}`).join(", ")}`,
    );
  }
  return Response.json({ posts, serverTime: nowSec });
}

// 四种 ack 结果,与插件侧的观察一一对应(见设计文档 §8 的错误分类表)。
const AckBody = z.object({
  id: z.number().int().positive(),
  result: z.enum(["posted", "unconfirmed", "failed", "channel_error"]),
  xPostId: z.string().optional(),
  error: z.string().optional(),
});

export interface XQueueAckOpts {
  nowSec?: number;
  env?: EnvLike;
  /** 通道级故障的告警出口(注入以便测试;生产传 Telegram 发送函数)。 */
  notify?: (message: string) => Promise<unknown>;
}

export async function handleXQueueAck(
  req: Request,
  db: DB,
  opts: XQueueAckOpts = {},
): Promise<Response> {
  const access = checkXQueueAccess(req, db, opts.env);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  let parsed;
  try {
    parsed = AckBody.safeParse(await req.json());
  } catch {
    return Response.json({ error: "body 不是合法 JSON" }, { status: 400 });
  }
  if (!parsed.success) {
    return Response.json(
      { error: `body 不合法: ${parsed.error.issues[0]?.message ?? "unknown"}` },
      { status: 400 },
    );
  }
  const { id, result, xPostId, error } = parsed.data;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const settled = ackQueued(db, { id, result, xPostId, nowSec });

  if (result === "channel_error") {
    // 通道级故障(X 掉登录 / DOM 改版):这条帖已退回队列,但运营者必须立刻
    // 知道 —— 否则队列会静默积压,直到 TTL 把它们全部作废。
    console.error(
      `[xQueue] channel error reported by key #${access.keyId} on post ${id}: ${error ?? "(no detail)"}`,
    );
    if (opts.notify) {
      // 尽力而为:通知挂了也不能拖累 ack 的结果 —— 状态机的正确性优先于
      // 通知的送达。
      try {
        await opts.notify(
          `⚠️ 𝕏 插件通道故障：${error ?? "未知原因"}（帖 #${id} 已退回队列；请检查浏览器里的 x.com 登录状态）`,
        );
      } catch (e) {
        console.error("[xQueue] channel-error notify failed:", e);
      }
    }
  } else if (settled) {
    console.log(
      `[xQueue] post ${id} settled as '${result}'${xPostId ? ` (x_post_id=${xPostId})` : ""}`,
    );
  }

  // duplicate 不是错误:插件本地补 ack 必然产生重复,它需要一个明确的
  // "服务端已经知道了"的答复才能安全地清掉本地记录。
  return Response.json({ ok: true, duplicate: !settled });
}
