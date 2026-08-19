import { describe, it, expect } from "vitest";
import { clipError, sectionView } from "./sectionGate";

// 区块级的门。这套判据存在的理由是一次真实的自相矛盾:页头显示「已验证」,
// 而 EventsSection / TgTargetsSection / XAccountsSection 同时显示「填入管理
// 令牌后加载」并且压根不发请求 —— 因为前者问的是服务端(authGate 探针),
// 后者问的是本地那个 token 字符串。未配 ADMIN_TOKEN 的部署上,服务端恒放行、
// 本地 token 恒为空,于是整页解锁但三个区块永远空着。
//
// 修法不是改文案,是让区块判据**拿不到 token**:sectionView 的签名里没有它。

describe("sectionView", () => {
  it("没数据也没报错 = 还在路上", () => {
    expect(sectionView(null, null)).toEqual({ kind: "loading" });
  });

  it("有数据 = 可渲染,且数据随判别联合一起带出(调用方不必写 data!)", () => {
    const rows = [{ id: 1 }];
    expect(sectionView(rows, null)).toEqual({ kind: "ready", data: rows });
  });

  it("报错原样透传 —— 「要不要令牌」由服务端的话说了算,前端不改写", () => {
    // 401 的响应体原话。前端猜一句「请填入令牌」就会在「服务端未配置
    // ADMIN_TOKEN」(403,完全另一回事)时把人引向错误的下一步。
    const msg = "需要有效的管理令牌（x-admin-token）";
    expect(sectionView(null, msg)).toEqual({ kind: "error", message: msg });
  });

  it("刷新失败但手上有旧数据 → 仍渲染数据,不把已有内容藏起来", () => {
    // 60s 自动刷新撞上一次网络抖动,不该让运营者眼前的表整个消失。
    expect(sectionView({ targets: [] }, "HTTP 500")).toMatchObject({
      kind: "ready",
    });
  });

  it("空数组是「拿到了、就是没有」,不是「还没拿到」", () => {
    // truthy 判断会把 [] 当成有数据(对),但把 0/"" 判错;这里一律用 != null,
    // 语义是「请求回来了没有」,与数据内容无关。
    expect(sectionView([], null)).toEqual({ kind: "ready", data: [] });
  });

  it("签名里没有 token —— 这才是修复本身", () => {
    // 未配 ADMIN_TOKEN 的部署:服务端放行 → 数据到手 → ready。
    // 本地令牌是不是空串,与这里无关(也无从得知)。
    expect(sectionView.length).toBe(2);
  });
});

describe("clipError", () => {
  it("短消息原样返回", () => {
    expect(clipError("chat not found")).toBe("chat not found");
  });

  it("超长截断并加省略号 —— 完整原文由调用方放 title", () => {
    const long = "x".repeat(200);
    const out = clipError(long);
    expect(out).toHaveLength(161); // 160 + "…"
    expect(out.endsWith("…")).toBe(true);
  });

  it("真实的 TG 报错要留到「原因」那一段,不能砍在前缀上", () => {
    // 实测收到的那条:旧的 60 字符上限刚好砍在 telegram 回话之前,
    // 运营者看到的是一句纯前缀,等于没有诊断。
    const real =
      "telegram send failed even after plain-text downgrade: telegram 400: chat not found";
    const out = clipError(real);
    expect(out).toContain("chat not found");
    expect(clipError(real, 60)).not.toContain("chat not found");
  });

  it("空值给空串,不渲染出 undefined", () => {
    expect(clipError(null)).toBe("");
    expect(clipError(undefined)).toBe("");
  });
});
