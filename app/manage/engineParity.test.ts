import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONSENSUS_WINDOW_MODES } from "../../lib/engineSettings";

// 引擎设置的可达性守卫 —— kindsParity 的思路搬到「区块本身」这一层。
//
// kindsParity 钉的是「数据层能力 ↔ 运营页勾选清单」;这里钉它的前一层:
// **区块挂没挂、路由在不在、清单是不是同一份**。存在理由同款:
// consensus_window_mode 开关 2026-09-08 随 windowKeeper 上线,而唯一的操作
// 入口曾是进生产容器手写 SQLite —— 一个已实现、测过、部署了的回滚开关,
// 在产品上不可达(cohort 藏十天的同一种病,病灶在回滚开关上更危险)。
// 组件写好但忘了挂载 / 路由改名而组件没跟上,没有任何东西会红 —— 除了这里。

const read = (...p: string[]) =>
  readFileSync(join(process.cwd(), ...p), "utf8");

const SECTION = read("app", "manage", "EngineSection.tsx");
const PAGE = read("app", "manage", "page.tsx");

describe("引擎设置 ↔ /manage 可达性", () => {
  it("EngineSection 在 /manage 挂载(import 与 JSX 两处都在)", () => {
    expect(
      PAGE.includes('import EngineSection from "./EngineSection"'),
      "page.tsx 没有 import EngineSection —— 组件存在但页面不认识它",
    ).toBe(true);
    expect(
      PAGE.includes("<EngineSection"),
      "page.tsx 没有渲染 <EngineSection> —— 运营者点遍所有 tab 也找不到开关",
    ).toBe(true);
  });

  it("组件请求的 /api/admin/engine 路由文件存在且导出 GET/POST", () => {
    // 判定材料取组件源码里的 fetch 字面量:那是浏览器真正会打的路径。
    expect(
      SECTION.includes('fetch("/api/admin/engine"'),
      "EngineSection 不再请求 /api/admin/engine —— 本守卫的路径断言需要同步",
    ).toBe(true);
    const routePath = join(
      process.cwd(),
      "app",
      "api",
      "admin",
      "engine",
      "route.ts",
    );
    expect(existsSync(routePath), "路由文件 app/api/admin/engine/route.ts 不存在").toBe(
      true,
    );
    const route = read("app", "api", "admin", "engine", "route.ts");
    expect(route).toContain("export async function GET");
    expect(route).toContain("export async function POST");
  });

  it("组件的模式清单来自 lib/engineSettings 注册表,不手抄", () => {
    expect(
      SECTION.includes("CONSENSUS_WINDOW_MODES"),
      "EngineSection 不再渲染 CONSENSUS_WINDOW_MODES —— 手抄清单正是 cohort 那次漂移的来源",
    ).toBe(true);
  });

  it("注册表恰是双态 incremental/full,带非空文案 —— 与 windowKeeper getMode 契约一致", () => {
    // windowKeeper 的 getMode 类型是 () => "incremental" | "full";
    // 注册表多出第三态 = UI 能选出引擎不认识的值(它会被静默判成增量)。
    expect(new Set(CONSENSUS_WINDOW_MODES.map((m) => m.mode))).toEqual(
      new Set(["incremental", "full"]),
    );
    for (const m of CONSENSUS_WINDOW_MODES) {
      expect(m.label.trim(), m.mode).not.toBe("");
      expect(m.hint.trim(), m.mode).not.toBe("");
    }
  });

  it("引擎读取点走同一份 lib(worker/embeddedEngine 不再内联 SQL)", () => {
    const engine = read("worker", "embeddedEngine.ts");
    expect(
      engine.includes("getConsensusWindowMode"),
      "embeddedEngine 的 getMode 不再调用 getConsensusWindowMode —— 读写两端的键名/判读语义又变回两份手抄",
    ).toBe(true);
  });
});
