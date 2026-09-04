// 全站默认加载态。
//
// 这不只是"好看一点":没有 loading 边界时,Next 的客户端导航是**阻塞式**的
// —— 点击链接后浏览器停在旧页面不动,直到新路由的服务端 payload 就绪才
// 整屏切换。页面越重、服务器越远,这段"点了没反应"的空窗越长(用户实测
// 「点击顶部 tab 跳转很慢,还不算跳转后的页面加载」说的就是它)。
// 有了这个文件,路由切换立即发生并渲染骨架,真实内容随后填充。
//
// 骨架的形状必须与落地后的页壳一致,否则内容一到就整屏跳动:页头区(小标 /
// 标题 / 描述 + 底边)→ KPI 分格卡(一张白卡 N 等分,格间 1px 竖线)→
// 主表卡(标题条 + 分格行)。灰块只在真正会有文字的位置出现。

const ROW_WIDTHS = ["92%", "74%", "86%", "68%", "90%", "78%"];

const BAR = { borderRadius: "var(--r-sm)" } as const;

export default function Loading() {
  return (
    <main className="ds-main" aria-busy="true">
      {/* 页头区 —— 12px 小标 · 24px 标题 · 14px 描述 */}
      <div className="page-head">
        <div style={{ width: "100%" }}>
          <div
            className="skeleton"
            style={{ ...BAR, height: 12, width: 132 }}
          />
          <div
            className="skeleton"
            style={{
              ...BAR,
              height: 24,
              width: 260,
              maxWidth: "60%",
              marginTop: 10,
            }}
          />
          <div
            className="skeleton"
            style={{ ...BAR, height: 14, width: "38%", marginTop: 12 }}
          />
        </div>
      </div>

      {/* KPI 分格卡 —— 白卡 + 1px 竖线由 .kpi / .kpi-card 提供,骨架只填内容 */}
      <section className="kpi">
        {[0, 1, 2, 3].map((i) => (
          <div className="kpi-card" key={i}>
            <div
              className="skeleton"
              style={{ ...BAR, height: 12, width: "56%" }}
            />
            <div
              className="skeleton"
              style={{ ...BAR, height: 18, width: "40%", marginTop: 10 }}
            />
            <div
              className="skeleton"
              style={{ ...BAR, height: 12, width: "72%", marginTop: 10 }}
            />
          </div>
        ))}
      </section>

      {/* 主表卡 —— 圆角 12 / 1px 描边 / 散淡阴影,与 .ds-table-wrap 同框 */}
      <div
        className="ds-card"
        style={{ marginTop: "var(--s-5)", overflow: "hidden" }}
      >
        <div
          style={{
            padding: "var(--s-3) var(--s-4)",
            borderBottom: "1px solid var(--ww-border)",
          }}
        >
          <div
            className="skeleton"
            style={{ ...BAR, height: 14, width: 200, maxWidth: "50%" }}
          />
        </div>
        {ROW_WIDTHS.map((w, i) => (
          <div
            key={w}
            style={{
              padding: "var(--s-3) var(--s-4)",
              borderBottom:
                i === ROW_WIDTHS.length - 1
                  ? "none"
                  : "1px solid var(--ww-border)",
            }}
          >
            <div
              className="skeleton"
              style={{ ...BAR, height: 14, width: w }}
            />
          </div>
        ))}
      </div>
    </main>
  );
}
