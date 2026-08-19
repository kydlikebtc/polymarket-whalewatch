import { describe, it, expect } from "vitest";
import { busTypeEnabled } from "./routing";

// 路由矩阵曾经读 legacy 的 config.bus_signal_settings 算开关。那份配置自
// 2026-08-19 起「不再参与任何判定」(见 /api/admin/signals 的注释),而新 UI
// 的 defAction create/update/delete 都不回写它 —— 结果:运营者启用了一档,
// bus_defs.enabled=1,legacy 仍是 false,矩阵永远显示「关」。

describe("busTypeEnabled", () => {
  it("有启用中的定义 = 开", () => {
    expect(
      busTypeEnabled([{ sourceType: "large", enabled: true }], "large"),
    ).toBe(true);
  });

  it("有定义但全部停用 = 关", () => {
    expect(
      busTypeEnabled(
        [
          { sourceType: "large", enabled: false },
          { sourceType: "large", enabled: false },
        ],
        "large",
      ),
    ).toBe(false);
  });

  it("多档里只要有一档开着就算开 —— 该类型确实在往外发", () => {
    expect(
      busTypeEnabled(
        [
          { sourceType: "large", enabled: false },
          { sourceType: "large", enabled: true },
        ],
        "large",
      ),
    ).toBe(true);
  });

  it("只看本类型,不被别的类型带偏", () => {
    const defs = [
      { sourceType: "consensus", enabled: true },
      { sourceType: "large", enabled: false },
    ];
    expect(busTypeEnabled(defs, "large")).toBe(false);
    expect(busTypeEnabled(defs, "consensus")).toBe(true);
  });

  it("没有任何定义 / 还没加载 = 关,不炸", () => {
    expect(busTypeEnabled([], "large")).toBe(false);
    expect(busTypeEnabled(null, "large")).toBe(false);
  });

  it("就是那个 bug 的现场:legacy 说关、定义说开,以定义为准", () => {
    // legacy busSettings = { large: { enabled: false } } —— 矩阵旧判据的输入。
    // 而运营者刚在 ① 里启用了「巨鲸档」。矩阵必须说「开」。
    const defs = [{ sourceType: "large", enabled: true }];
    expect(busTypeEnabled(defs, "large")).toBe(true);
  });
});
