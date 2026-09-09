import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../../../../lib/db";
import { getConsensusWindowMode } from "../../../../lib/engineSettings";

// /api/admin/engine —— consensus_window_mode 回滚开关的读写接口。
// 关键契约:写入只收规范值(枚举),经 config_history 留痕,且写完引擎
// 读取端(getConsensusWindowMode,与 worker/embeddedEngine getMode 同一份)
// 立刻读得出 —— 「运营页拧了开关、引擎下一轮照做」的闭环在这里钉死。

let dir: string;
const saved = {
  dashDb: process.env.DASH_DB,
  publicReadonly: process.env.PUBLIC_READONLY,
};

beforeAll(() => {
  // 必须是真文件:route 每次自己 openDb,`:memory:` 会让 seed 与被测代码
  // 看到两个不相干的空库(webhooks 路由测试的既有姿态)。
  dir = mkdtempSync(join(tmpdir(), "engine-route-"));
  process.env.DASH_DB = join(dir, "test.sqlite");
  process.env.PUBLIC_READONLY = "false";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.DASH_DB = saved.dashDb;
  process.env.PUBLIC_READONLY = saved.publicReadonly;
});

beforeEach(() => {
  // 每条用例从干净配置出发 —— 开关只有一行,测试之间不该互相看见。
  const db = openDb(process.env.DASH_DB!);
  db.prepare("DELETE FROM config").run();
  db.prepare("DELETE FROM config_history").run();
  db.close();
});

const { GET, POST } = await import("./route");

interface Payload {
  mode?: string;
  history?: { value: string; changedAt: number }[];
  error?: string;
}

async function get() {
  const res = await GET(new Request("http://localhost/api/admin/engine"));
  return { res, body: (await res.json()) as Payload };
}

async function post(body: unknown) {
  const res = await POST(
    new Request("http://localhost/api/admin/engine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { res, body: (await res.json()) as Payload };
}

describe("GET", () => {
  it("出厂态:增量 + 空留痕(config 表尚无此行)", async () => {
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body.mode).toBe("incremental");
    expect(body.history).toEqual([]);
  });
});

describe("POST", () => {
  it("切到 'full':落库、留痕、回包即新状态(不必再 GET)", async () => {
    const { res, body } = await post({ mode: "full" });
    expect(res.status).toBe(200);
    expect(body.mode).toBe("full");
    expect(body.history).toHaveLength(1);
    expect(body.history![0].value).toBe("full");

    // 引擎读取端(与 embeddedEngine getMode 同一份代码)立刻读得出。
    const db = openDb(process.env.DASH_DB!);
    expect(getConsensusWindowMode(db)).toBe("full");
    db.close();
  });

  it("幂等重写不刷历史 —— 手抖连点两下只留一笔", async () => {
    await post({ mode: "full" });
    const { body } = await post({ mode: "full" });
    expect(body.mode).toBe("full");
    expect(body.history).toHaveLength(1);
  });

  it("切回 'incremental':写规范值(不是删行),留痕可直接读出意图", async () => {
    await post({ mode: "full" });
    const { body } = await post({ mode: "incremental" });
    expect(body.mode).toBe("incremental");
    expect(body.history!.map((h) => h.value)).toEqual(["incremental", "full"]);

    const db = openDb(process.env.DASH_DB!);
    const raw = db
      .prepare("SELECT value FROM config WHERE key = 'consensus_window_mode'")
      .get() as { value: string | null } | undefined;
    db.close();
    expect(raw?.value).toBe("incremental");
  });

  // 'FULL'/'off' 这类值在引擎侧会被静默判成增量,收下等于埋一个「拧了没反应」。
  it("非规范值被枚举挡住(400),不落库", async () => {
    for (const mode of ["FULL", "off", "", 1, null]) {
      const { res } = await post({ mode });
      expect(res.status, `mode=${JSON.stringify(mode)}`).toBe(400);
    }
    const { body } = await get();
    expect(body.mode).toBe("incremental");
    expect(body.history).toEqual([]);
  });

  it("空体/坏 JSON → 400 带人话", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/engine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Payload;
    expect(body.error).toBeTruthy();
  });
});
