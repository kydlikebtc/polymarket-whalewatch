import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DAILY_CAP } from "../../../../lib/xQuota";

// /api/admin/x-accounts 的「数字参数」动作(action:"params")。重点钉三件事:
//   1. 合并语义 —— 缺键不动、null 是明确的「不限」(与 kinds 的逐键可选一致);
//   2. 跨键约束 —— 赛前窗口倒挂必须 400 拒绝,而不是读侧静默回落;
//   3. GET 的 budgetUsd 用生效值 —— 后台改过预算后播报历史头必须如实。

let dir: string;
const saved = {
  dashDb: process.env.DASH_DB,
  publicReadonly: process.env.PUBLIC_READONLY,
  budget: process.env.X_MONTHLY_BUDGET_USD,
  minTrade: process.env.X_MIN_TRADE_USD,
};

beforeAll(() => {
  // 必须是真文件:route 每次自己 openDb,`:memory:` 会让 seed 与被测代码
  // 看到两个不相干的空库。
  dir = mkdtempSync(join(tmpdir(), "xacct-route-"));
  process.env.DASH_DB = join(dir, "test.sqlite");
  process.env.PUBLIC_READONLY = "false";
  // 钉死 env 派生默认(budget 15 / whale floor 50k),外部 env 不得干扰断言。
  process.env.X_MONTHLY_BUDGET_USD = "";
  process.env.X_MIN_TRADE_USD = "";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.DASH_DB = saved.dashDb;
  process.env.PUBLIC_READONLY = saved.publicReadonly;
  process.env.X_MONTHLY_BUDGET_USD = saved.budget;
  process.env.X_MIN_TRADE_USD = saved.minTrade;
});

const { GET, POST } = await import("./route");

async function get() {
  const res = await GET(new Request("http://localhost/api/admin/x-accounts"));
  return (await res.json()) as Record<string, unknown> & {
    params: Record<string, unknown>;
    defaults: Record<string, unknown>;
  };
}

async function post(body: unknown) {
  const res = await POST(
    new Request("http://localhost/api/admin/x-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("GET params/defaults", () => {
  it("空库 → params = 出厂默认;defaults 一并返回给 UI 标注", async () => {
    const j = await get();
    expect(j.params).toEqual({
      budgetUsd: 15,
      dailySpendCapUsd: null,
      weeklySpendCapUsd: null,
      whaleMinTradeUsd: 50_000,
      whaleDailyCap: DAILY_CAP.whale,
      whaleSirenUsd: 250_000,
      consensusDailyCap: DAILY_CAP.consensus,
      pregameDailyCap: DAILY_CAP.pregame,
      pregameMinH: 1,
      pregameMaxH: 6,
      settledDailyCap: DAILY_CAP.settled,
      weeklyUtcHour: 13,
      pulseUtcHour: 14,
      scorecardUtcHour: 14,
    });
    expect(j.defaults).toEqual(j.params);
    expect(j.budgetUsd).toBe(15);
  });

  it("templates 默认全 null(内置);词表与时间分布一并返回", async () => {
    const j = await get();
    expect(j.templates).toEqual({
      whale: null,
      consensus: null,
      pregame: null,
      weekly: null,
      settled: null,
      scorecard: null,
      pulse: null,
      divergence: null,
    });
    expect((j.templateVocab as Record<string, string[]>).whale).toContain(
      "title",
    );
    // 空库:14 天 × 24 小时的空网格(total 全 0)。
    const hist = j.histogram as { day: string; total: number }[];
    expect(hist).toHaveLength(14);
    expect(hist.every((d) => d.total === 0)).toBe(true);
  });
});

describe("POST action=params", () => {
  it("合并语义:只提交一个键,其余不动", async () => {
    const { res, body } = await post({
      action: "params",
      params: { whaleDailyCap: 7 },
    });
    expect(res.status).toBe(200);
    expect((body.params as Record<string, unknown>).whaleDailyCap).toBe(7);
    const j = await get();
    expect(j.params.whaleDailyCap).toBe(7);
    expect(j.params.pregameDailyCap).toBe(DAILY_CAP.pregame); // 没动
  });

  it("consensusDailyCap:数字设限,null 改回「不限」", async () => {
    await post({ action: "params", params: { consensusDailyCap: 4 } });
    expect((await get()).params.consensusDailyCap).toBe(4);
    await post({ action: "params", params: { consensusDailyCap: null } });
    expect((await get()).params.consensusDailyCap).toBeNull();
  });

  it("预算改动后 GET 的 budgetUsd 用生效值(播报历史头必须如实)", async () => {
    await post({ action: "params", params: { budgetUsd: 20 } });
    const j = await get();
    expect(j.params.budgetUsd).toBe(20);
    expect(j.budgetUsd).toBe(20);
    // 出厂默认仍是 env 派生的 15,UI 拿它标注「默认」。
    expect(j.defaults.budgetUsd).toBe(15);
  });

  it("赛前窗口倒挂 → 400 直接拒绝(写侧不做静默回落)", async () => {
    const { res, body } = await post({
      action: "params",
      params: { pregameMinH: 5, pregameMaxH: 3 },
    });
    expect(res.status).toBe(400);
    expect(String(body.error)).toContain("赛前窗口");
  });

  it("单端提交也过跨键校验:minH=7 与现存 maxH=6 倒挂 → 400", async () => {
    const { res } = await post({
      action: "params",
      params: { pregameMinH: 7 },
    });
    expect(res.status).toBe(400);
    // 拒绝的写入不得落库。
    expect((await get()).params.pregameMinH).toBe(1);
  });

  it("zod 拦越界:weeklyUtcHour=24 / whaleDailyCap=0 都是 400", async () => {
    expect(
      (await post({ action: "params", params: { weeklyUtcHour: 24 } })).res
        .status,
    ).toBe(400);
    expect(
      (await post({ action: "params", params: { whaleDailyCap: 0 } })).res
        .status,
    ).toBe(400);
  });

  it("日/周花费上限:数字设限、null 改回不限;负数被 zod 拦", async () => {
    await post({
      action: "params",
      params: { dailySpendCapUsd: 1, weeklySpendCapUsd: 5 },
    });
    let j = await get();
    expect(j.params.dailySpendCapUsd).toBe(1);
    expect(j.params.weeklySpendCapUsd).toBe(5);
    await post({ action: "params", params: { dailySpendCapUsd: null } });
    j = await get();
    expect(j.params.dailySpendCapUsd).toBeNull();
    expect(j.params.weeklySpendCapUsd).toBe(5); // 缺键不动
    expect(
      (await post({ action: "params", params: { dailySpendCapUsd: -1 } })).res
        .status,
    ).toBe(400);
  });
});

describe("POST action=templates", () => {
  it("合法模板落库;空串 = 恢复内置;缺键不动", async () => {
    const tpl = "{icon} {amount} on {outcome} @ {price}\n\n{title}\n\n{tags}";
    const { res } = await post({
      action: "templates",
      templates: { whale: tpl },
    });
    expect(res.status).toBe(200);
    let j = await get();
    expect((j.templates as Record<string, string | null>).whale).toBe(tpl);
    expect((j.templates as Record<string, string | null>).consensus).toBeNull();
    await post({ action: "templates", templates: { whale: "" } });
    j = await get();
    expect((j.templates as Record<string, string | null>).whale).toBeNull();
  });

  it("坏模板整单 400:未知占位符 / 缺 {title} / 夹带链接", async () => {
    const bad = await post({
      action: "templates",
      templates: { whale: "{nope} {title}" },
    });
    expect(bad.res.status).toBe(400);
    expect(String(bad.body.error)).toContain("未知占位符");
    expect(
      (
        await post({
          action: "templates",
          templates: { consensus: "no title here {tags}" },
        })
      ).res.status,
    ).toBe(400);
    expect(
      (
        await post({
          action: "templates",
          templates: { settled: "{title} https://spam.example {tags}" },
        })
      ).res.status,
    ).toBe(400);
  });
});
