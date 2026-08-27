import { openDb } from "../../../../lib/db";
import { checkFeedAccess } from "../../../../lib/feedAuth";
import { createPromiseCache } from "../../../../lib/promiseCache";
import { buildSignalCatalog } from "../../../../lib/signalCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 信号名录 —— 「我这把 key 能收到哪些信号」。
// 设计见 docs/plans/2026-08-27-signal-catalog-api-design.md。
//
// 与 /api/signals 的分工:那边给**信号条目**,这边给**能收到什么的清单**。
// 鉴权、401/403 响应体、tier 语义全部复用同一套(checkFeedAccess),不新造第二
// 套 —— 订阅方因此可以拿本端点当「我的 key 还活着吗」的探针,不必为了探活去
// 拉一整份 feed。
//
// 零上游调用:全部字段来自本地 sqlite,一次突发打不进引擎的 data-api 预算。

const CACHE_TTL_MS = 30_000;

type Body = {
  updatedAt: number;
  tier: string;
  signals: ReturnType<typeof buildSignalCatalog>;
};

// let 而非 const:测试要能把缓存清干净(越权隔离那条用例的全部意义就在于
// 「先烤热、再换 key」,带着上一条用例的残留跑等于没测)。
let catalogCache = createPromiseCache<Body>(CACHE_TTL_MS);

/** 测试专用:丢弃当前缓存。 */
export function __resetCatalogCache(): void {
  catalogCache = createPromiseCache<Body>(CACHE_TTL_MS);
}

export async function GET(req: Request) {
  const dbPath = process.env.DASH_DB ?? "data.sqlite";
  // 鉴权用短连接(verifyApiKey 会写 last_used_at):routes 每请求开连接是本仓
  // 惯例,SQLite 打开成本亚毫秒级。
  const authDb = openDb(dbPath);
  let access: ReturnType<typeof checkFeedAccess>;
  try {
    access = checkFeedAccess(req, authDb);
  } finally {
    authDb.close();
  }
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  // 从判别式联合里取出来存 const:narrowing 不会跨进下面的异步闭包(access
  // 是 let),而闭包里要用到范围。
  const { tier, busTypes } = access;

  // 缓存键必须含**订阅范围** —— 与 /api/signals 同一个坑(见那边的注释):
  // 两把 tier 相同、范围不同的 key 会共用缓存,全量 key 烤热之后受限 key 就
  // 拿到了它无权看到的类型。那是**越权泄露**,不是多给了点数据。
  // 排序后再拼,保证 ["a","b"] 与 ["b","a"] 命中同一份。
  const scopeKey = busTypes?.length ? [...busTypes].sort().join(",") : "all";
  try {
    const body = await catalogCache(`catalog:${tier}:${scopeKey}`, async () => {
      const db = openDb(dbPath);
      try {
        return {
          updatedAt: Math.floor(Date.now() / 1000),
          tier,
          signals: buildSignalCatalog(db, { scopes: busTypes }),
        };
      } finally {
        db.close();
      }
    });
    return Response.json(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[/api/signals/list] failed:", message);
    // 这里刻意**与 /api/signals 的降级语义相反**(§11 那边是 200 + 空 feed)。
    //
    // 理由是同一条纪律的镜像:在 feed 上,空数组的谎言是「今天没信号」;在名录
    // 上,空名录的谎言是「你的 key 被削了范围」—— 订阅方会照着它去找运营者
    // 理论,或者干脆停掉集成。一份说不准的权限清单比没有更贵,所以宁可报错。
    return Response.json({ error: message }, { status: 503 });
  }
}
