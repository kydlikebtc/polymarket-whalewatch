// 存证链复算 —— 任何第三方都能跑,不需要访问这台服务器的库。
//
//   npx tsx scripts/verify-digest.ts                       # 验线上站点
//   npx tsx scripts/verify-digest.ts https://your.host     # 验自建部署
//
// 拉两份**公开**数据:
//   · GET /api/dataset/record.csv —— 全量已发布信号(含 signal_id 列)
//   · GET /api/record            —— 逐日存证行 digests[]
// 然后逐日按 id 升序复算 sha256 链,与公布值比对。退出码非 0 = 有对不上的天。
//
// 这个脚本存在的意义:每日存证消息里那句「按 id 升序复算即可验证」在
// 2026-09-07 之前**没人执行得了** —— 导出里没有 id,历史摘要只在 TG 消息里。
// 一个没人能执行的验证承诺,和没有承诺是一回事。
import { createHash } from "crypto";
import {
  parseRecordCsv,
  verifyDigestDays,
  type VerifyDigest,
} from "../lib/digestVerify";

const DEFAULT_BASE = "https://whalewatch.wired.fund";

const sha256 = async (s: string): Promise<string> =>
  createHash("sha256").update(s).digest("hex");

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

const ICON: Record<string, string> = {
  ok: "✅",
  tampered: "❌",
  "missing-rows": "❌",
  "extra-rows": "⚠️",
};

async function main(): Promise<number> {
  const base = (process.argv[2] ?? DEFAULT_BASE).replace(/\/+$/, "");
  console.log(`存证复算 · ${base}\n`);

  const [csv, recordJson] = await Promise.all([
    getText(`${base}/api/dataset/record.csv`),
    getText(`${base}/api/record`),
  ]);

  const rows = parseRecordCsv(csv);
  const feed = JSON.parse(recordJson) as { digests?: VerifyDigest[] };
  const digests = feed.digests ?? [];
  if (digests.length === 0) {
    console.log(
      "该部署还没有逐日存证行(signal_digests 自 2026-09-07 起向前积累)。",
    );
    console.log("链尾仍可在公开 TG 频道的每日存证消息里人工比对。");
    return 0;
  }

  const r = await verifyDigestDays(rows, digests, sha256);
  console.log(`导出 ${rows.length} 条已发布信号 · 存证 ${digests.length} 天\n`);
  for (const d of r.days) {
    const link = d.linked === false ? " ⛓️‍💥 前链接不上" : "";
    const counts =
      d.exportCount === d.digestCount
        ? `${d.digestCount} 条`
        : `摘要 ${d.digestCount} 条 / 导出 ${d.exportCount} 条`;
    console.log(
      `${ICON[d.status] ?? "?"} ${d.day}  ${counts}  ${d.expected.slice(0, 16)}…${link}`,
    );
    if (d.status === "tampered") {
      console.log(`     复算得到 ${d.actual.slice(0, 16)}… —— 内容与公布值不符`);
    }
  }

  console.log("");
  console.log(
    `相符 ${r.ok} · 内容不符 ${r.tampered} · 导出缺行 ${r.missingRows} · 导出多行 ${r.extraRows} · 断链 ${r.brokenLinks}`,
  );
  if (r.extraRows > 0) {
    // 良性成因要说清楚,否则读者会把 ⚠️ 读成 ❌。2026-09-07 起摘要改到
    // 06:00 UTC 结算(过了 ENTRY_MAX_AGE_SEC,成员集结构上冻结),此后这一类
    // 不该再出现;更早的天数出现属于历史遗留。
    console.log(
      "⚠️ 「导出多行」通常是良性的:摘要算完之后那条信号才投递成功。2026-09-07 起摘要改在 06:00 UTC 结算,成员集已冻结,新的日子不该再出现这一类。",
    );
  }
  if (r.missingRows > 0 || r.tampered > 0 || r.brokenLinks > 0) {
    console.log("❌ 有对不上的天 —— 这正是这条链要报的警。");
    return 1;
  }
  console.log("✅ 全部相符。");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("复算失败:", e instanceof Error ? e.message : e);
    process.exit(2);
  });
