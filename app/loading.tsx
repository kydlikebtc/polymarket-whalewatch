// 全站默认加载态。
//
// 这不只是"好看一点":没有 loading 边界时,Next 的客户端导航是**阻塞式**的
// —— 点击链接后浏览器停在旧页面不动,直到新路由的服务端 payload 就绪才
// 整屏切换。页面越重、服务器越远,这段"点了没反应"的空窗越长(用户实测
// 「点击顶部 tab 跳转很慢,还不算跳转后的页面加载」说的就是它)。
// 有了这个文件,路由切换立即发生并渲染骨架,真实内容随后填充。
export default function Loading() {
  return (
    <main className="ds-main" aria-busy="true">
      <div className="skeleton skeleton--title" />
      <div className="skeleton skeleton--line" style={{ width: "38%" }} />
      <div className="skeleton-grid">
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
      </div>
      <div className="skeleton skeleton--block" />
    </main>
  );
}
