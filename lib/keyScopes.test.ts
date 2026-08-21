import { describe, it, expect } from "vitest";
import {
  ALL_SCOPES,
  CAPABILITY_SCOPES,
  KEY_SCOPES,
  PUSHABLE_SCOPES,
  PUSHABLE_TYPES,
  scopeLabel,
} from "./keyScopes";
import { BUS_WEBHOOK_TYPES } from "./busWebhook";

describe("keyScopes", () => {
  it("每一项都有非空展示名 —— 漏了 UI 上就是一个裸 key", () => {
    for (const s of ALL_SCOPES) {
      expect(s.type.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it("可推送域 ⊂ key 范围域,且差集正是非事件能力", () => {
    for (const t of PUSHABLE_TYPES) expect(KEY_SCOPES).toContain(t);
    const diff = KEY_SCOPES.filter((t) => !PUSHABLE_TYPES.includes(t));
    expect(diff.sort()).toEqual(CAPABILITY_SCOPES.map((s) => s.type).sort());
  });

  it("非事件能力不得出现在 webhook 端点的可勾选类型里", () => {
    // 深度卡是拉取的,没有事件可推。让它出现在勾选框里是一个服务端会拒收的
    // 无意义选项 —— 这正是当初把 market 塞进共用清单时冒出来的那个别扭。
    for (const c of CAPABILITY_SCOPES) {
      expect(BUS_WEBHOOK_TYPES as readonly string[]).not.toContain(c.type);
      expect(PUSHABLE_TYPES).not.toContain(c.type);
    }
  });

  it("bus 三类与 webhook 的实际值域对齐 —— 两边各自维护必然分叉", () => {
    // PUSHABLE 比 BUS_WEBHOOK_TYPES 多一个 strategy(它走既有策略投递轨,
    // 不是 bus 事件),差集只允许是它。
    const extra = PUSHABLE_TYPES.filter(
      (t) => !(BUS_WEBHOOK_TYPES as readonly string[]).includes(t),
    );
    expect(extra).toEqual(["strategy"]);
  });

  it("未知类型的展示名回落成裸 key,不抛错", () => {
    expect(scopeLabel("nope")).toBe("nope");
    expect(scopeLabel("market")).toContain("深度卡");
  });

  it("PUSHABLE_SCOPES 与 PUSHABLE_TYPES 同源,顺序一致", () => {
    expect(PUSHABLE_SCOPES.map((s) => s.type)).toEqual([...PUSHABLE_TYPES]);
  });
});
