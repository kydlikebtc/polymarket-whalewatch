// /manage 的令牌门 —— 纯状态机,与 React 无关,所以能被穷举测试。
//
// 这一层要挡的不是「越权写入」(那道防线在服务端 ADMIN_TOKEN 上,每个
// /api/admin/* 路由各自校验,页面怎么改都动不了它),而是**信息暴露**:
// 页面此前在没有令牌时照样渲染引擎心跳表、告警阈值、以及一整套 tab/KPI
// 标签 —— 后者等于把这套系统的运营结构(有哪些循环、哪些通道、哪些档位、
// 存证链、备份)白送给任何知道路径的人。
//
// 判据只有一个:**服务端认了才算认**。前端不解析令牌、不比对长度、不做
// 任何本地判断 —— 唯一的真相来源是 GET /api/admin/signals 的响应码。
// 本地开发(非公开部署)下 checkWriteAccess 恒放行,探针直接 200,页面照旧
// 零摩擦解锁,这是刻意保留的既有姿态。

/** 令牌探针(GET /api/admin/signals)的结果。 */
export type Probe =
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "denied"; status: number }
  | { kind: "error"; message: string };

export type GateState = "verifying" | "locked" | "unlocked";

/**
 * **fail closed**:只有服务端明确认可(`ok`)才解锁。
 *
 * `error`(网络断了 / 500 / JSON 解析失败)必须锁着 —— 「探针挂了就当通过」
 * 是这类门最经典的失效模式:攻击者只要让那一个请求失败,整页就全开了。
 * 探针没结果时也一律不解锁,顺带避免水合期闪出一屏运营数据再收回去。
 */
export function gateState(probe: Probe): GateState {
  if (probe.kind === "ok") return "unlocked";
  if (probe.kind === "pending") return "verifying";
  return "locked";
}

/**
 * 锁定态下给运营者看的一行解释。必须能区分「令牌错了」和「服务端有毛病」——
 * 两者的下一步动作完全不同(改令牌 vs 看服务器日志),混成一句话会让人
 * 对着一个好令牌反复重输。
 */
export function gateMessage(probe: Probe, hasToken: boolean): string | null {
  switch (probe.kind) {
    case "ok":
      return null;
    case "pending":
      return "正在验证令牌…";
    case "denied":
      if (probe.status === 403) {
        return "服务端未配置 ADMIN_TOKEN —— 远程管理已整体关闭(在服务器 .env 设置后重启即可启用)";
      }
      return hasToken
        ? "管理令牌无效 —— 请核对服务器 .env 的 ADMIN_TOKEN"
        : "请填入管理令牌以解锁运营数据";
    case "error":
      // 措辞刻意不写「令牌无效」:探针失败与令牌无关,把人往错误方向引
      // 就是让他去改一个本来没问题的令牌。
      return `无法验证令牌(${probe.message})—— 服务端异常,页面保持锁定`;
  }
}

/** 把一次 fetch 的结果收敛成 Probe。响应体带 error 字段也算失败。 */
export function probeFromResponse(
  status: number,
  body: { error?: string } | null,
): Probe {
  if (status === 401 || status === 403) return { kind: "denied", status };
  if (status < 200 || status >= 300) {
    return { kind: "error", message: body?.error ?? `HTTP ${status}` };
  }
  if (body?.error) return { kind: "error", message: body.error };
  return { kind: "ok" };
}
