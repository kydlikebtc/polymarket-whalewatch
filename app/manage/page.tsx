"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminSignalOverview } from "../../lib/adminOverview";
import { Tag } from "../ui";
import AlertRulesSection from "./AlertRulesSection";
import EventsSection from "./EventsSection";
import ViewsSection from "./ViewsSection";
import HealthSection, { type HealthReport } from "./HealthSection";
import KeysSection from "./KeysSection";
import TgTargetsSection from "./TgTargetsSection";
import XAccountsSection from "./XAccountsSection";
import SignalsSection from "./SignalsSection";
import MarketCardSection from "./MarketCardSection";
import WalkforwardSection from "./WalkforwardSection";
import StatusStrip from "./StatusStrip";
import {
  PipelinesOverview,
  RoutingMatrix,
  SignalLinesOverview,
  type RoutingState,
} from "./TaxonomyOverview";
import {
  gateMessage,
  gateState,
  probeFromResponse,
  type Probe,
} from "./authGate";
import { authHeaders } from "./shared";
import type { BusDefLike } from "./routing";

// /manage — 运营管理页。
//
// 2026-08-18:整页改为**令牌门后**才渲染。此前页面结构是公开的,无令牌者
// 虽然拿不到 /api/admin/* 的数据,却照样看得到引擎心跳表、告警阈值明文,
// 以及一整套 tab 与 KPI 标签 —— 后者本身就是情报:它把这套系统的运营结构
// (有哪些循环、哪些投递通道、多少档策略、存证链、备份日、有几个 API key)
// 白送给任何知道路径的人。服务端那道 ADMIN_TOKEN 闸一直都在、也一直有效,
// 这次补的是**信息暴露**那一面。
//
// 门的判据只有一个:服务端认不认(GET /api/admin/signals 的响应码,见
// ./authGate.ts)。前端不做任何本地令牌判断,探针失败一律锁死。
// 本地开发(非公开部署)下 checkWriteAccess 恒放行,探针直接 200,零摩擦。
//
// 唯独引擎健康度**不**藏在这道门后:它搬去了公开状态页 /status。
// 「引擎还活着吗」是每个订阅方都有权随时知道的事实(信号 feed 的 healthy
// 位、频道沉默、webhook 停投都指向它),藏起来只会让订阅方靠猜;而「哪些
// 档位放开了推送、TG 连败几次、有几个 key」才是运营内部事。
//
// 数据刷新模型:解锁后统一拉 /api/health + /api/admin/signals,手动刷新
// 按钮 + 60s 自动刷新 —— 运营页通常开着不关,数据不能停在打开那一刻。

const AUTO_REFRESH_MS = 60_000;
// 令牌输入是逐字符 onChange。不防抖的话,手打一个 40 字符的令牌会打出 40 次
// /api/admin/signals —— 该路由 perIp 限流 60 次/分钟,而现在整页都吊在这个
// 探针上:一旦 429,运营者会被自己锁在门外,且提示还是「服务端异常」。
const TOKEN_DEBOUNCE_MS = 400;

// 信息架构(2026-08-19 重排):两步模型 —— 第一步「产什么信号」(三条线,
// 与接入文档 §6.1 同一套分类),第二步「投给谁」(下游管线)。此前五个 tab
// 把两层揉在一起,策略开关/总线开关/TG 告警条件同住一个 tab,而 TG 目标、
// API key、𝕏 又各占一个 —— 没有一张图回答「这条信号最终到谁手里」。
// 标签前的 01–04 是**顺序**不是分类(分类用 ①②/🅐🅑🅒):四个分区有先后 ——
// 先看产出什么,再看投给谁,再体检参数,最后看引擎活没活。设计稿 19 的分区
// 条就是这么编号的。
const TABS = [
  { id: "lines", label: "01 🧭 对外产出" },
  { id: "pipes", label: "02 🚚 下游管线" },
  // 🧪 阈值重推独立成 tab(2026-08-28):它既不是信号线也不是管线,是月度
  // 参数体检 —— 有自己的动作(跑/下载)与整页报告,挤在 ② 底部会被 19 档
  // 大表推到三屏之外。
  { id: "wf", label: "03 🧪 阈值重推" },
  { id: "health", label: "04 🩺 健康度" },
] as const;
type TabId = (typeof TABS)[number]["id"];

// StatusStrip 发出的是**区块** id(它不该知道 tab 怎么分组),这里把它映射
// 到承载该区块的 tab —— 契约不变,StatusStrip 零改动。
const SECTION_TAB: Record<string, TabId> = {
  events: "lines",
  signals: "lines",
  views: "lines",
  // 旧区块 id 的兼容映射(StatusStrip 仍发 "signals" 等)。
  bus: "lines",
  moves: "lines",
  // rules(告警触发条件)住在 🅐 Telegram 子模块。
  rules: "pipes",
  tg: "pipes",
  keys: "pipes",
  x: "pipes",
  // 🎯 按需查询自成一类(非信号、无管线),但它的旋钮住在下游管线 tab ——
  // 分类在总览表里说清楚,操作放在够得着的地方,与 rules 同一处理。
  card: "pipes",
  health: "health",
};

// 两个大 tab 内部各一层子 tab:每次只挂载一个子模块(此前三个区块纵向罗列,
// 一页三张大表,找东西靠滚)。总览表留在子 tab 之上当地图 —— 点行即切子 tab。
// 信号线只有两条(事件才是信号);「视图」是事件的折叠层,非信号、无管线,
// 单独一个子 tab 讲清楚 —— 2026-08-19 概念重排,见 EventsSection 文件头。
const LINE_SUBS = [
  { id: "events", label: "① 原始事件信号" },
  { id: "signals", label: "② 策略信号" },
  { id: "views", label: "👁 视图(非信号)" },
] as const;
const PIPE_SUBS = [
  { id: "tg", label: "🅐 Telegram" },
  { id: "keys", label: "🅑 API key + webhook" },
  { id: "x", label: "🅒 𝕏 播报" },
  // 深度卡是管线而非信号线:它不产出事件,它是一条**按需**对外供数的通道,
  // 而且是全站唯一会打上游的那条 —— 预算与背压的旋钮该和其它对外通道放一起。
  { id: "card", label: "🎯 市场深度卡" },
] as const;
type LineSub = (typeof LINE_SUBS)[number]["id"];
type PipeSub = (typeof PIPE_SUBS)[number]["id"];
const SUB_STORAGE_KEY = "manageSubTabs";

const TAB_STORAGE_KEY = "manageTab";

export default function ManagePage() {
  const [token, setToken] = useState("");
  // 防抖后的令牌 —— 只有它变化才发探针。
  const [probeToken, setProbeToken] = useState("");
  const [probe, setProbe] = useState<Probe>({ kind: "pending" });
  const [overview, setOverview] = useState<AdminSignalOverview | null>(null);
  // 路由矩阵数据(与 overview 同一次 GET,只是额外键)。
  const [routing, setRouting] = useState<RoutingState | null>(null);
  // 信号定义 = 事件类型开关的唯一真相(路由矩阵据此判「通不通」)。
  // 曾经这里存的是 legacy busSettings,而它已不参与任何判定 —— 见 ./routing.ts。
  const [busDefs, setBusDefs] = useState<BusDefLike[] | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 初次挂载先读 localStorage 再发请求,避免「无令牌请求 → 锁定 → 令牌
  // 水合后又解锁」的闪烁。
  const hydrated = useRef(false);

  const [tab, setTab] = useState<TabId>("lines");
  const [lineSub, setLineSub] = useState<LineSub>("events");
  const [pipeSub, setPipeSub] = useState<PipeSub>("tg");
  // 解锁后令牌框收起 —— 此时它唯一的用途是「换令牌」,却占着首屏一整张卡。
  // 锁定态不受这个开关影响(那时它是页面主角)。
  const [tokenOpen, setTokenOpen] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("adminToken") ?? "";
    setToken(saved);
    // 存过的令牌不必再等防抖:它不是刚敲进来的。
    setProbeToken(saved);
    const savedTab = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (savedTab && TABS.some((x) => x.id === savedTab)) {
      setTab(savedTab as TabId);
    }
    // 子 tab 同样跨刷新记忆(运营页常开不关,回到上次看的子模块)。
    try {
      const subs = JSON.parse(
        window.localStorage.getItem(SUB_STORAGE_KEY) ?? "{}",
      ) as { line?: string; pipe?: string };
      if (LINE_SUBS.some((x) => x.id === subs.line)) {
        setLineSub(subs.line as LineSub);
      }
      if (PIPE_SUBS.some((x) => x.id === subs.pipe)) {
        setPipeSub(subs.pipe as PipeSub);
      }
    } catch {
      // 坏存储:保持默认,不抛。
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setProbeToken(token), TOKEN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [token]);

  const selectTab = (id: TabId) => {
    setTab(id);
    window.localStorage.setItem(TAB_STORAGE_KEY, id);
  };

  const saveToken = (v: string) => {
    setToken(v);
    window.localStorage.setItem("adminToken", v);
  };

  const loadAll = useCallback(async () => {
    if (!hydrated.current) return;
    setRefreshing(true);
    try {
      const ovRes = await fetch("/api/admin/signals", {
        headers: authHeaders(probeToken),
      }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as AdminSignalOverview & {
          error?: string;
          routing?: RoutingState;
          busDefs?: BusDefLike[];
        },
      }));
      const next = probeFromResponse(ovRes.status, ovRes.body);
      setProbe(next);
      if (next.kind !== "ok") {
        // 锁定时清空既有数据:留着上一把有效令牌的运营数据在内存里、
        // 只是不渲染,是在赌「不渲染」永远不出 bug。
        setOverview(null);
        setRouting(null);
        setBusDefs(null);
        setHealth(null);
        return;
      }
      setOverview(ovRes.body);
      setRouting(ovRes.body.routing ?? null);
      setBusDefs(ovRes.body.busDefs ?? null);
      // 健康度只在解锁后才拉 —— 锁定态一个请求都不该发出去。
      // 公开状态页 /status 才是这份数据对外的正门。
      try {
        setHealth((await (await fetch("/api/health")).json()) as HealthReport);
      } catch {
        // 健康度拿不到不该影响已解锁的运营数据。
        setHealth(null);
      }
      setRefreshedAt(Math.floor(Date.now() / 1000));
    } catch (e) {
      setProbe({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      setOverview(null);
      setHealth(null);
    } finally {
      setRefreshing(false);
    }
  }, [probeToken]);

  useEffect(() => {
    void loadAll();
    const timer = setInterval(() => void loadAll(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadAll]);

  const state = gateState(probe);
  const message = gateMessage(probe, probeToken !== "");

  // 状态条上的 chip 点击:切到承载该区块的 tab(切完区块就在首屏,不必再滚动)。
  const persistSubs = (next: { line?: LineSub; pipe?: PipeSub }) => {
    try {
      const cur = JSON.parse(
        window.localStorage.getItem(SUB_STORAGE_KEY) ?? "{}",
      ) as Record<string, string>;
      window.localStorage.setItem(
        SUB_STORAGE_KEY,
        JSON.stringify({ ...cur, ...next }),
      );
    } catch {
      window.localStorage.setItem(SUB_STORAGE_KEY, JSON.stringify(next));
    }
  };
  const selectLineSub = (id: LineSub) => {
    setLineSub(id);
    persistSubs({ line: id });
  };
  const selectPipeSub = (id: PipeSub) => {
    setPipeSub(id);
    persistSubs({ pipe: id });
  };

  // 区块 id → 大 tab + 子 tab。每次只挂载一个子模块,切完即在首屏,无需滚动。
  const jump = (id: string) => {
    selectTab(SECTION_TAB[id] ?? "lines");
    if (LINE_SUBS.some((x) => x.id === id)) selectLineSub(id as LineSub);
    if (PIPE_SUBS.some((x) => x.id === id)) selectPipeSub(id as PipeSub);
    if (id === "rules") selectPipeSub("tg"); // 告警条件住在 🅐 里
    if (id === "bus" || id === "moves") selectLineSub("events"); // 旧 id 兼容
  };

  const tokenField = (
    <div style={{ flex: "1 1 320px", maxWidth: 480 }}>
      <div
        className="ds-label"
        style={{
          marginBottom: "var(--s-2)",
          display: "flex",
          gap: "var(--s-2)",
          alignItems: "center",
        }}
      >
        管理令牌(x-admin-token)
        {state === "unlocked" && <Tag variant="up">✅ 已验证</Tag>}
        {state === "locked" && <Tag variant="warn">🔒 已锁定</Tag>}
      </div>
      <input
        id="manage-token"
        className="ds-input ds-input--mono"
        type="password"
        placeholder="x-admin-token"
        value={token}
        onChange={(e) => saveToken(e.target.value)}
        autoComplete="off"
        style={{ width: "100%" }}
      />
      {message && (
        <div className="ds-hint" style={{ marginTop: "var(--s-2)" }}>
          {message}
        </div>
      )}
    </div>
  );

  // 页尾出口:/status 与 /guide 都是「公开但不进导航」的页面,/manage 是它们
  // 的常规入口。锁定态也放同一条 —— 说明书与引擎心跳没有秘密。
  // 描边白底,不加 emoji(emoji 只住在灰底标签/KPI 图标位/12px 小标前缀)。
  const exits = (
    <div
      style={{
        display: "flex",
        gap: "var(--s-2)",
        flexWrap: "wrap",
        marginTop: "var(--s-5)",
      }}
    >
      {/* 「引擎活没活不需要令牌」这句原本占着锁定态一整条琥珀口径条 ——
          它不改变任何读数,收进这枚出口钮的 title 里。 */}
      <Link
        className="ds-btn"
        href="/status"
        title="引擎是否在跑是公开的,不需要管理令牌"
      >
        系统状态页 →
      </Link>
      <Link className="ds-btn" href="/guide">
        功能说明书 →
      </Link>
    </div>
  );

  // 锁定/验证中:只有标题、令牌框、以及一条去公开状态页的出口。
  // 没有 tab、没有 KPI、没有区块骨架 —— 这些标签本身就是运营结构的情报。
  if (state !== "unlocked") {
    return (
      <main className="ds-main" style={{ maxWidth: 620 }}>
        <div className="page-head">
          <div style={{ minWidth: 0 }}>
            <div className="page-head__eyebrow">🔒 运营内部 · 不在导航栏</div>
            <h1 className="page-head__title">运营管理</h1>
            <p className="page-head__desc">
              本页需要管理令牌;令牌只存本浏览器。
            </p>
          </div>
        </div>
        {/* 「门后是运营结构本身,所以未验证时整页不渲染」是设计理由,不是读数
            告诫 —— 那条琥珀口径条已删,去处见下方出口钮的 title。 */}
        <div className="ds-card" style={{ padding: "var(--s-5)" }}>
          {tokenField}
        </div>
        {exits}
      </main>
    );
  }

  // 分区导航卡:主分区 tab → 地图(可折的总览条)→ 子分区 tab → 挂载说明。
  // 四个分区是「同一个对象的多个侧面」,所以用 TabRow(蓝底胶囊)而不是
  // Segmented —— Segmented 是互斥选择,TabRow 是换一面看。
  const hasSub = tab === "lines" || tab === "pipes";

  return (
    <main className="ds-main">
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="page-head__eyebrow">🛠 运营内部 · 不在导航栏</div>
          <h1 className="page-head__title">运营管理</h1>
          {/* 描述只留一句身份说明。刷新节奏不写在这里 —— 右侧动作区已经有
              「时间 · 每分钟自动」,导航卡底的说明条又讲了「切分区即重拉」,
              同一件事说三遍会把页头撑成两行。 */}
          <p className="page-head__desc">
            令牌只存本浏览器,与 /alerts 配置面板共用。
          </p>
        </div>
        <div className="page-head__actions">
          {/* 令牌已验证时只留一枚可点的绿徽章 —— 要换令牌再展开那张卡。
              徽章是状态,不是按钮,所以借 .ds-tag 的皮而不是 .ds-btn。 */}
          <button
            type="button"
            className="ds-tag ds-tag--up"
            aria-expanded={tokenOpen}
            title="令牌已验证。需要更换时点开"
            onClick={() => setTokenOpen((v) => !v)}
            style={{ cursor: "pointer" }}
          >
            🔑 令牌已验证 {tokenOpen ? "▾" : "▸"}
          </button>
          {/* 全页唯一的主按钮。 */}
          <button
            className="ds-btn ds-btn--primary"
            disabled={refreshing}
            onClick={() => void loadAll()}
          >
            {refreshing ? "刷新中…" : "刷新"}
          </button>
          {refreshedAt != null && (
            <span className="ds-hint">
              {new Date(refreshedAt * 1000).toLocaleTimeString("zh-CN")} ·
              每分钟自动
            </span>
          )}
        </div>
      </div>

      <StatusStrip health={health} overview={overview} onJump={jump} />

      {tokenOpen && (
        <div
          className="ds-card"
          style={{
            marginBottom: "var(--s-5)",
            padding: "var(--s-4)",
            display: "flex",
            gap: "var(--s-4)",
            flexWrap: "wrap",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          {tokenField}
        </div>
      )}

      {/* 分区导航卡 —— 一张白卡装下「主分区 → 地图 → 子分区 → 挂载说明」,
          四段之间靠 1px 分格线分层。此前它们是三块并列的独立元素(分段控件
          + 一张总览卡 + 又一个分段控件),读起来像三件事,其实是一件。 */}
      <section
        className="ds-card"
        style={{ overflow: "hidden", marginBottom: "var(--s-5)" }}
      >
        <div
          className="ds-tabrow"
          role="group"
          aria-label="运营分区"
          style={hasSub ? undefined : { borderBottom: "none" }}
        >
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-pressed={tab === x.id}
              onClick={() => selectTab(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
        {tab === "lines" && (
          <>
            <SignalLinesOverview
              overview={overview}
              onJump={jump}
              active={lineSub}
            />
            <div
              className="ds-tabrow"
              role="group"
              aria-label="信号线子模块"
              style={{ borderBottom: "none" }}
            >
              {LINE_SUBS.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  aria-pressed={lineSub === x.id}
                  onClick={() => selectLineSub(x.id)}
                >
                  {x.label}
                </button>
              ))}
            </div>
          </>
        )}
        {tab === "pipes" && (
          <>
            <PipelinesOverview
              overview={overview}
              onJump={jump}
              active={pipeSub}
            />
            <RoutingMatrix
              routing={routing}
              busDefs={busDefs}
              channels={overview?.ops.channels ?? null}
              onJump={jump}
            />
            <div
              className="ds-tabrow"
              role="group"
              aria-label="下游管线子模块"
              style={{ borderBottom: "none" }}
            >
              {PIPE_SUBS.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  aria-pressed={pipeSub === x.id}
                  onClick={() => selectPipeSub(x.id)}
                >
                  {x.label}
                </button>
              ))}
            </div>
          </>
        )}
        {/* 中文长句写成字符串表达式:JSX 折行会渲染成一个空格,在汉字中间
            夹出一道缝。 */}
        <div className="note-strip">
          {"每次只挂载一个子模块 · 分区记在本浏览器 · 切换即重新拉数。"}
        </div>
      </section>

      {/* 每个 tab 只挂载自己的区块:各 Section 在挂载时拉取自己的数据,
          切走即卸载,回来重新拉 —— 运营页的数据本来就要求新鲜,重挂载
          顺带成了「切 tab 即刷新」。 */}
      {tab === "lines" && (
        <>
          {lineSub === "events" && <EventsSection token={token} />}
          {lineSub === "signals" && (
            <SignalsSection
              token={token}
              overview={overview}
              reload={loadAll}
            />
          )}
          {lineSub === "views" && <ViewsSection />}
        </>
      )}
      {tab === "pipes" && (
        <>
          {pipeSub === "card" && <MarketCardSection token={token} />}
          {pipeSub === "tg" && (
            <>
              <TgTargetsSection token={token} />
              {/* 告警频道的触发条件归位于 TG 管线(2026-08-19):这套表单管的
                  是「哪些成交进 alerts 台账并推 TG 告警」—— 它是 ① 的进料闸,
                  但旋钮语义(推送总开关/冷却)是 TG 频道的,放在 ① 里会让人
                  误以为在改 ① 的判据(那是固定规则)。 */}
              <AlertRulesSection token={token} />
            </>
          )}
          {pipeSub === "keys" && <KeysSection token={token} />}
          {pipeSub === "x" && <XAccountsSection token={token} />}
        </>
      )}
      {tab === "wf" && <WalkforwardSection token={token} />}
      {tab === "health" && (
        <HealthSection health={health} ops={overview?.ops ?? null} />
      )}

      {exits}
    </main>
  );
}
