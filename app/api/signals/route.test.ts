import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { HEAVY_MIN_USD } from "../../../lib/signalFeed";

// 失败降级的**形状**必须与成功路径一致。
//
// 这两条路径的构造方式天然不对称:成功路径是拼出来的(`...buildSignalFeed()`
// 的 spread + route 自己追加的 strategies/bus/delayedMin/healthy/staleLoops),
// 失败路径是一份手抄的对象字面量。手抄的那份漏过 heavyMinUsd 与 staleLoops
// —— 注释写着「结构完整的空 feed」、文档也这么承诺,实际却缺两个字段,接入方
// 只能把它们标成可选,或者在解析时踩空。
//
// 所以期望值从**成功响应现算**,不硬编码字段清单:以后往成功路径加字段却忘了
// 同步 catch 分支,这条测试立刻红,而不是等接入方来报。
const throwing = vi.hoisted(() => ({ bus: false }));

// 只 mock 信号总线这一个下游。lib/signalFeed 保持完全真实 —— 降级响应里的
// heavyMinUsd 必须等于真常量,而不是 mock 自己的回声。
vi.mock("../../../lib/signalBus", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/signalBus")>();
  return {
    ...actual,
    getBusSignals: (...args: Parameters<typeof actual.getBusSignals>) => {
      if (throwing.bus) throw new Error("模拟内部异常：bus 查询失败");
      return actual.getBusSignals(...args);
    },
  };
});

import { GET } from "./route";

const saved = {
  dashDb: process.env.DASH_DB,
  publicReadonly: process.env.PUBLIC_READONLY,
};

beforeAll(() => {
  // 空的内存库:每次 openDb 都建全表,查询能跑通但没有数据 —— 成功路径拿到的
  // 是一份合法的空 feed,正是要拿来比形状的那个基准。
  process.env.DASH_DB = ":memory:";
  // 显式钉死「非公开部署」,鉴权直接放行 realtime,测试不依赖 NODE_ENV 的默认值。
  process.env.PUBLIC_READONLY = "false";
});

afterAll(() => {
  process.env.DASH_DB = saved.dashDb;
  process.env.PUBLIC_READONLY = saved.publicReadonly;
});

afterEach(() => {
  throwing.bus = false;
  vi.restoreAllMocks();
});

// route 有 30 秒的进程内缓存,键含 windowHours。成功/失败各用不同的窗口,
// 两条用例互不串味,也不依赖执行顺序。
async function call(windowHours: number) {
  const res = await GET(
    new Request(`http://localhost/api/signals?windowHours=${windowHours}`),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("/api/signals 失败降级", () => {
  it("catch 分支的字段集合与成功路径完全一致（只多一个 error）", async () => {
    const ok = await call(24);
    // 先证明这确实是成功路径:空库上 healthy 本来就是 false(引擎从没跑过),
    // 所以判别只能看 error 在不在。
    expect(ok.body.error).toBeUndefined();

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    throwing.bus = true;
    const failed = await call(6);

    // 再证明这确实走进了 catch 分支,而不是碰巧也成功了。
    expect(failed.res.status).toBe(200);
    expect(failed.body.healthy).toBe(false);
    expect(String(failed.body.error)).toContain("bus 查询失败");
    expect(spy).toHaveBeenCalledWith(
      "[/api/signals] failed:",
      expect.stringContaining("bus 查询失败"),
    );

    expect(Object.keys(failed.body).sort()).toEqual(
      [...Object.keys(ok.body), "error"].sort(),
    );
  });

  it("降级响应里的 heavyMinUsd 是真阈值、staleLoops 是空数组（不是 null）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    throwing.bus = true;
    const { body } = await call(12);

    // 键在但值是 null,JSON 序列化后照样能骗过「字段集合一致」——所以值也要钉。
    expect(body.heavyMinUsd).toBe(HEAVY_MIN_USD);
    expect(body.staleLoops).toEqual([]);
  });
});
