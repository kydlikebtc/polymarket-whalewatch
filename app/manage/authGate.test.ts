import { describe, it, expect } from "vitest";
import {
  gateMessage,
  gateState,
  probeFromResponse,
  type Probe,
} from "./authGate";

describe("gateState —— fail closed", () => {
  it("只有服务端明确认可才解锁", () => {
    expect(gateState({ kind: "ok" })).toBe("unlocked");
  });

  it("探针还没结果时不解锁(水合期不闪运营数据)", () => {
    expect(gateState({ kind: "pending" })).toBe("verifying");
  });

  it("401/403 锁定", () => {
    expect(gateState({ kind: "denied", status: 401 })).toBe("locked");
    expect(gateState({ kind: "denied", status: 403 })).toBe("locked");
  });

  it("**探针失败也锁定** —— 「请求挂了就当通过」是这类门最经典的失效模式", () => {
    expect(gateState({ kind: "error", message: "network down" })).toBe(
      "locked",
    );
    expect(gateState({ kind: "error", message: "HTTP 500" })).toBe("locked");
  });

  it("除 ok 外没有任何一种输入能解锁", () => {
    const nonOk: Probe[] = [
      { kind: "pending" },
      { kind: "denied", status: 401 },
      { kind: "denied", status: 403 },
      { kind: "denied", status: 429 },
      { kind: "error", message: "x" },
    ];
    for (const p of nonOk) expect(gateState(p)).not.toBe("unlocked");
  });
});

describe("gateMessage", () => {
  it("403 指向服务端未配置,而不是让人去改令牌", () => {
    const m = gateMessage({ kind: "denied", status: 403 }, true)!;
    expect(m).toContain("ADMIN_TOKEN");
    expect(m).not.toContain("无效");
  });

  it("401 有令牌 = 令牌错;无令牌 = 请填入", () => {
    expect(gateMessage({ kind: "denied", status: 401 }, true)).toContain(
      "无效",
    );
    expect(gateMessage({ kind: "denied", status: 401 }, false)).toContain(
      "请填入",
    );
  });

  it("探针失败的措辞不能说「令牌无效」(会让人去改一个没问题的令牌)", () => {
    const m = gateMessage({ kind: "error", message: "boom" }, true)!;
    expect(m).toContain("boom");
    expect(m).toContain("锁定");
    expect(m).not.toContain("令牌无效");
  });

  it("解锁态无消息", () => {
    expect(gateMessage({ kind: "ok" }, true)).toBeNull();
  });
});

describe("probeFromResponse", () => {
  it("200 + 干净响应体 = ok", () => {
    expect(probeFromResponse(200, {})).toEqual({ kind: "ok" });
    expect(probeFromResponse(200, null)).toEqual({ kind: "ok" });
  });

  it("401/403 = denied,并保留状态码供文案分流", () => {
    expect(probeFromResponse(401, { error: "需要令牌" })).toEqual({
      kind: "denied",
      status: 401,
    });
    expect(probeFromResponse(403, { error: "未配置" })).toEqual({
      kind: "denied",
      status: 403,
    });
  });

  it("429(被自己的限流挡住)按 error 处理,不冒充鉴权失败", () => {
    expect(probeFromResponse(429, { error: "rate limited" })).toEqual({
      kind: "error",
      message: "rate limited",
    });
  });

  it("200 但响应体带 error 字段 = error,绝不当成 ok", () => {
    // /api/admin/signals 内部异常时会 200 + {error} 降级返回 —— 把它读成
    // 「令牌通过」就等于让一次服务端故障打开整个页面。
    expect(probeFromResponse(200, { error: "db locked" })).toEqual({
      kind: "error",
      message: "db locked",
    });
  });

  it("5xx = error", () => {
    expect(probeFromResponse(500, null)).toEqual({
      kind: "error",
      message: "HTTP 500",
    });
  });
});
