"use client";

import { useEffect } from "react";

// 左栏「当前所在小节」高亮的驱动器 —— 样式早就在 globals.css 里
// (.doc-toc a[aria-current="true"]:蓝字 + 白底 + 2px 蓝轨),缺的只是有人
// 把 aria-current 挂上去。
//
// 为什么单独一个 "use client" 文件:/api-docs/page.tsx 是服务端组件(读
// docs/api-access.md、查库生成实时表),不能整页转客户端;而滚动位置只有
// 浏览器知道。这个组件不渲染任何东西,只在客户端给已经 SSR 出来的 <a>
// 打属性 —— 首屏 HTML 与目录结构完全不变,JS 没跑也只是不高亮。
//
// 用 IntersectionObserver 而不是 :target:后者只在点击目录后生效,直接滚动
// 进某一节时不亮,而读者最常见的动作恰恰是滚动。
export default function DocScrollSpy({ ids }: { ids: string[] }) {
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const nav = document.querySelector(".doc-toc");
    if (!nav) return;

    // 锚点 → 目录里指向它的 <a>。同一个小节可能在「章节」与「端点」两组里
    // 各出现一次(§5/§10/§14 既是章节也是端点),两个都要亮,故存数组。
    // 取 getAttribute("href") 而非 a.hash —— 后者会把中文锚点百分号编码,
    // 与 heading 的 id 对不上。
    const linksById = new Map<string, HTMLAnchorElement[]>();
    for (const a of Array.from(nav.querySelectorAll("a"))) {
      const href = a.getAttribute("href") ?? "";
      if (!href.startsWith("#")) continue;
      const id = href.slice(1);
      const same = linksById.get(id);
      if (same) same.push(a);
      else linksById.set(id, [a]);
    }

    // ids 由服务端按**文档顺序**给出,下面的 pick 依赖这个顺序。
    const order = ids.filter(
      (id) => linksById.has(id) && document.getElementById(id) !== null,
    );
    if (order.length === 0) return;

    let current: string | null = null;
    const apply = (next: string | null) => {
      if (next === current) return;
      for (const a of linksById.get(current ?? "") ?? [])
        a.removeAttribute("aria-current");
      current = next;
      for (const a of linksById.get(next ?? "") ?? [])
        a.setAttribute("aria-current", "true");
    };

    // 判定带:视口顶部往下 BAND 像素起、到 62% 高度处止。带内最靠前的标题
    // 即「当前小节」。
    const BAND = 96;
    const inBand = new Set<string>();
    const pick = (): string | null => {
      const first = order.find((id) => inBand.has(id));
      if (first) return first;
      // 带里一个标题都没有(小节很长、正读到中段):取最后一个已经滚过带顶
      // 的标题 —— 否则高亮会在长小节里整段消失。
      let last: string | null = null;
      for (const id of order) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top > BAND) break;
        last = id;
      }
      return last;
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) inBand.add(e.target.id);
          else inBand.delete(e.target.id);
        }
        apply(pick());
      },
      { rootMargin: `-${BAND}px 0px -62% 0px` },
    );
    for (const id of order) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => {
      io.disconnect();
      apply(null);
    };
  }, [ids]);

  return null;
}
