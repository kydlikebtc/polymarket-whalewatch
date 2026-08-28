import { spawn } from "node:child_process";
import { checkWriteAccess, guardExpensive } from "../../../../lib/apiGuard";
import { openDb } from "../../../../lib/db";
import type { WalkforwardReport } from "../../../../lib/walkforward";
import { createWalkforwardRunner } from "../../../../lib/walkforwardRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /manage「🧪 阈值重推」tab 的数据口(ADMIN_TOKEN 后,非公开 API):
//   GET               最新报告 + 运行状态(卡轮询它)
//   GET ?download=1   最新(或 ?id=N 指定)报告完整 JSON,Content-Disposition 附件
//   POST              触发一次生产库重推 —— spawn 子进程跑
//                     `npx tsx scripts/walkforward.ts <DASH_DB>`,与运维手工
//                     SSH 跑的是逐字节同一条路径;独立进程不占 Node 事件循环
//                     (请求内直算会把 4s 告警循环一起冻住)。互斥锁防并跑。
//
// 报告本体永远从 walkforward_reports 表读 —— POST 只负责「让脚本跑」,跑完
// 的那行由下一次 GET 自然读到,页面轮询收敛,无需回传大对象。

const LIMITS = { perIp: 60, global: 120 };
// 触发是分钟级计算,限得更紧(互斥锁才是真闸,这里只挡手抖连点)。
const RUN_LIMITS = { perIp: 6, global: 12 };

const runner = createWalkforwardRunner((dbPath) =>
  // --no-install:tsx 必须已在 node_modules(镜像/工作区都有),绝不允许
  // npx 现场去 registry 拉包 —— 生产容器可能无外网,且静默装依赖不可审计。
  spawn("npx", ["--no-install", "tsx", "scripts/walkforward.ts", dbPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }),
);

function dbPath() {
  return process.env.DASH_DB ?? "data.sqlite";
}

interface ReportRow {
  id: number;
  created_at: number;
  window_from: number;
  window_to: number;
  grid_size: number;
  config_json: string;
  report_json: string;
}

export async function GET(req: Request) {
  const access = checkWriteAccess(req);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  const limited = guardExpensive(req, "admin-walkforward", LIMITS, {});
  if (limited) return limited;
  const url = new URL(req.url);
  const wantDownload = url.searchParams.get("download") != null;
  const idParam = url.searchParams.get("id");
  const db = openDb(dbPath());
  try {
    const row = (
      idParam != null
        ? db
            .prepare(
              `SELECT id, created_at, window_from, window_to, grid_size, config_json, report_json
                 FROM walkforward_reports WHERE id = ?`,
            )
            .get(Number(idParam))
        : db
            .prepare(
              `SELECT id, created_at, window_from, window_to, grid_size, config_json, report_json
                 FROM walkforward_reports ORDER BY created_at DESC, id DESC LIMIT 1`,
            )
            .get()
    ) as ReportRow | undefined;

    if (wantDownload) {
      if (!row) {
        return Response.json(
          { error: "还没有任何报告可下载" },
          { status: 404 },
        );
      }
      let parsed: { config: unknown; report: unknown };
      try {
        parsed = {
          config: JSON.parse(row.config_json),
          report: JSON.parse(row.report_json),
        };
      } catch (e) {
        console.error("[admin-walkforward] 下载解析失败:", e);
        return Response.json(
          { error: `报告行 id=${row.id} 的 JSON 损坏` },
          { status: 500 },
        );
      }
      const day = new Date(row.created_at * 1000)
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "");
      // 完整落库行原样打包:config(可复现清单)+ report(全部格明细),
      // 卡上摘要没展开的候选/折/观察名单都在这里。
      const body = JSON.stringify(
        {
          id: row.id,
          createdAt: row.created_at,
          windowFrom: row.window_from,
          windowTo: row.window_to,
          gridSize: row.grid_size,
          config: parsed.config,
          report: parsed.report,
        },
        null,
        2,
      );
      return new Response(body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="walkforward-${row.id}-${day}.json"`,
          "cache-control": "no-store",
        },
      });
    }

    let report: WalkforwardReport | null = null;
    if (row) {
      try {
        report = JSON.parse(row.report_json) as WalkforwardReport;
      } catch (e) {
        console.error("[admin-walkforward] report_json 解析失败:", e);
        return Response.json(
          { error: `报告行 id=${row.id} 的 report_json 损坏` },
          { status: 500 },
        );
      }
    }
    return Response.json({
      id: row?.id ?? null,
      createdAt: row?.created_at ?? null,
      windowFrom: row?.window_from ?? null,
      windowTo: row?.window_to ?? null,
      gridSize: row?.grid_size ?? null,
      report,
      runState: runner.state(),
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
  const limited = guardExpensive(req, "admin-walkforward-run", RUN_LIMITS, {});
  if (limited) return limited;
  const res = runner.start(dbPath());
  if (!res.ok) {
    return Response.json(
      { error: res.reason, runState: runner.state() },
      { status: 409 },
    );
  }
  return Response.json({ started: true, runState: runner.state() });
}
