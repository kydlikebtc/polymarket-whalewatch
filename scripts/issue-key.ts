// 对外信号:本机签发订户 key(不经 HTTP,直接写库)。
//   npx tsx scripts/issue-key.ts <label> [realtime|delayed]
// 服务器上跑在容器里时:
//   docker compose exec whalewatch npx tsx scripts/issue-key.ts "订户A" realtime
import "dotenv/config";
import { issueApiKey } from "../lib/apiKeys";
import { openDb } from "../lib/db";

const [label, tierRaw] = process.argv.slice(2);
if (!label) {
  console.error(
    "用法: npx tsx scripts/issue-key.ts <label> [realtime|delayed](默认 delayed)",
  );
  process.exit(1);
}
const tier = tierRaw === "realtime" ? "realtime" : "delayed";
if (tierRaw && tierRaw !== "realtime" && tierRaw !== "delayed") {
  console.error(`未知 tier "${tierRaw}" — 已按 delayed 签发(宁降级不越权)`);
}

const db = openDb(process.env.DASH_DB ?? "data.sqlite");
try {
  const issued = issueApiKey(db, { label, tier });
  console.log(`✅ 已签发 #${issued.id} · ${label} · ${tier}`);
  console.log(`   ${issued.key}`);
  console.log("   明文只显示这一次,库中仅存 sha256 — 请立即保存并交付订户。");
  console.log("   吊销: DELETE /api/admin/keys?id=" + issued.id);
} finally {
  db.close();
}
