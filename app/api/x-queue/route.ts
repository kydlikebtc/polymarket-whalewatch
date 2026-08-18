import { parseConfig } from "../../../lib/config";
import { openDb } from "../../../lib/db";
import { handleXQueueGet } from "../../../lib/xQueueRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 𝕏 插件发帖通道的租借端点。运营者本机 Chrome 里的插件每 60s 拉一次,拿到
// 服务端已经渲染好的帖文,在后台标签页里驱动 x.com 自己的编辑器发出去。
//
// 全部逻辑在 lib/xQueueRoute.ts(可脱离 Next 单测),这里只做壳 —— 与
// /api/signals 的分层一致。
export async function GET(req: Request) {
  const cfg = parseConfig(process.env);
  // routes 每请求开连接是本仓惯例(SQLite 打开成本亚毫秒级)。
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  try {
    return await handleXQueueGet(req, db, { publicUrl: cfg.publicUrl });
  } finally {
    db.close();
  }
}
