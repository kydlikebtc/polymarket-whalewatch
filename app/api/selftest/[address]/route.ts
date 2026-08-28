import { openDb, type DB } from "../../../../lib/db";
import { guardExpensive } from "../../../../lib/apiGuard";
import { createBoundedCache } from "../../../../lib/boundedCache";
import { getWalletStats } from "../../../../lib/walletStats";
import {
  buildSelfTestVerdict,
  readLocalStats,
  readPool,
  readStatsFetchedAt,
  type SelfTestResponse,
} from "../../../../lib/selfTest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// 24h 判决缓存(设计文档成本闸 §2):同地址重测不再回源。底下还有
// getWalletStats 自己的 24h SQLite 缓存兜底(跨进程重启仍在),这里是
// 内存层双保险 + 判决体(含分位快照)的稳定性。上限 2000:病毒场景地址数
// 多于档案页的 500,而判决体只有几百字节。降级/no_data 判决**不入缓存**
// (一次限流不能把地址钉在旧数据上 24 小时 —— loadHoldings 同纪律)。
const VERDICT_TTL_MS = 24 * 3600_000;
const verdictCache = createBoundedCache<SelfTestResponse>(VERDICT_TTL_MS, 2000);

/** 降级判决:只读本地缓存(readLocalStats 绝不回源),池分位本来就是本地读。 */
async function localVerdict(
  db: DB,
  address: string,
  degraded: "rate_limited" | "upstream_error",
  retryAfterSec: number,
): Promise<SelfTestResponse> {
  const { stats, fetchedAt } = await readLocalStats(db, address);
  const v = buildSelfTestVerdict(address, stats, readPool(db));
  console.log(
    `[/api/selftest] degraded(${degraded}) ${address} — local-only verdict ` +
      `${v.verdict}${stats ? ` (stats cached at ${fetchedAt})` : " (no cached stats)"}`,
  );
  return {
    address,
    ...v,
    computedAt: Math.floor(Date.now() / 1000),
    statsFetchedAt: fetchedAt,
    degraded,
    retryAfterSec,
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: raw } = await params;
  const address = String(raw ?? "").toLowerCase();
  if (!ADDRESS_RE.test(address)) {
    return Response.json({ error: "invalid address" }, { status: 400 });
  }
  const db = openDb(process.env.DASH_DB ?? "data.sqlite");
  try {
    const hit = verdictCache.get(address);
    if (hit) {
      console.log(
        `[/api/selftest] HIT ${address} — ${hit.verdict} (computed at ${hit.computedAt})`,
      );
      return Response.json(hit);
    }

    // 与 /api/wallet/[address] **同一个桶**:自测触发的就是同一个
    // getWalletStats 扇出(冷地址 ~42 次上游调用),单独开桶等于给枚举者
    // 一条绕开钱包档案预算的新路。cost 3 同款。
    const limited = guardExpensive(
      req,
      "wallet-profile",
      { perIp: 120, global: 400, cost: 3 },
      { error: "rate limited" },
    );
    if (limited) {
      // 限流 ≠ 报错:计费照收,回本地缓存判决,前端 60s 后重试实时层
      // (窗口定长 1 分钟,lib/apiGuard)。
      return Response.json(await localVerdict(db, address, "rate_limited", 60));
    }

    // 实时路径:getWalletStats 命中 24h SQLite 缓存则零上游,冷地址扇出。
    // 取数失败在 getWalletStats 内部吞掉表现为 null —— 那正是上游故障的
    // 降级场景,回本地判决(本地也没有时 buildSelfTestVerdict 给 no_data)。
    const stats = (await getWalletStats(db, [address]))[address] ?? null;
    if (!stats) {
      return Response.json(
        await localVerdict(db, address, "upstream_error", 30),
      );
    }
    const v = buildSelfTestVerdict(address, stats, readPool(db));
    const payload: SelfTestResponse = {
      address,
      ...v,
      computedAt: Math.floor(Date.now() / 1000),
      statsFetchedAt: readStatsFetchedAt(db, address),
    };
    verdictCache.set(address, payload);
    console.log(
      `[/api/selftest] MISS ${address} — ${v.verdict} (gate ${v.gate}, ` +
        `pool ${v.poolSize}, stats fetched at ${payload.statsFetchedAt}, cached ${VERDICT_TTL_MS / 3600_000}h)`,
    );
    return Response.json(payload);
  } catch (e) {
    // 连本地组装都失败(SQLite 故障等)才是真·错误。
    console.error("[/api/selftest] verdict failed:", e);
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  } finally {
    db.close();
  }
}
