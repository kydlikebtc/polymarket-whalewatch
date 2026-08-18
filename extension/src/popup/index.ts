// popup:一屏看清「连上没有 / 通道好不好 / 最近发了什么」。
//
// 原生 DOM,不引框架:整个面板只有一屏、状态来自一次 sendMessage,
// 引 React 会让依赖树和产物大出一个量级,而这个插件的价值全在 background。
//
// 全部用 textContent 构建节点,不用 innerHTML —— 服务端返回的 detail 是
// 任意字符串(含 X 的报错文案),拼进 HTML 就是一个注入面。
import type { RecentEntry, Settings } from "../background/storage";

interface Status {
  connected: boolean;
  baseUrl: string | null;
  settings: Settings;
  breaker: { open: boolean; consecutive: number; reason: string | null };
  recent: RecentEntry[];
  version: string;
}

const RESULT_LABEL: Record<string, { text: string; color: string }> = {
  posted: { text: "已发布", color: "var(--ok)" },
  unconfirmed: { text: "待核对", color: "var(--warn)" },
  failed: { text: "失败", color: "var(--bad)" },
  channel_error: { text: "通道故障", color: "var(--bad)" },
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function send<T>(msg: unknown): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function el(tag: string, text?: string, cls?: string): HTMLElement {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function row(label: string, value: Node | string): HTMLElement {
  const r = el("div", undefined, "row");
  r.append(el("span", label));
  r.append(typeof value === "string" ? el("span", value, "muted") : value);
  return r;
}

function toggle(
  label: string,
  on: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const wrap = el("label");
  wrap.style.cursor = "pointer";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = on;
  cb.addEventListener("change", () => onChange(cb.checked));
  wrap.append(cb, document.createTextNode(` ${label}`));
  return wrap;
}

async function render(): Promise<void> {
  const s = await send<Status>({ type: "ww:status" });
  $("ver").textContent = `v${s.version}`;

  const banner = $("banner");
  banner.replaceChildren();
  if (!s.connected) {
    const b = el(
      "div",
      "尚未连接。到 whalewatch 的 /manage → 𝕏 播报账号 → 「推送配置到插件」。",
      "banner info",
    );
    banner.append(b);
  } else if (s.breaker.open) {
    const b = el("div", undefined, "banner bad");
    b.append(el("div", "⚠️ 𝕏 通道故障，已暂停发帖"));
    if (s.breaker.reason) b.append(el("div", s.breaker.reason, "muted"));
    b.append(el("div", "10 分钟后自动重试。多半是 x.com 掉登录了。", "muted"));
    banner.append(b);
  }

  const body = $("body");
  body.replaceChildren();

  const dot = el("span");
  const d = el("span", undefined, "dot");
  d.style.background = s.connected
    ? s.breaker.open
      ? "var(--bad)"
      : "var(--ok)"
    : "var(--muted)";
  dot.append(d, document.createTextNode(s.connected ? "已连接" : "未连接"));
  body.append(row("状态", dot));

  if (s.baseUrl) {
    const code = el("code", s.baseUrl.replace(/^https?:\/\//, ""));
    body.append(row("服务器", code));
  }

  body.append(
    row(
      "自动发帖",
      toggle("启用", s.settings.enabled, async (v) => {
        await send({ type: "ww:settings", patch: { enabled: v } });
        void render();
      }),
    ),
  );
  body.append(
    row(
      "演练模式",
      toggle("只填不发", s.settings.dryRun, async (v) => {
        await send({ type: "ww:settings", patch: { dryRun: v } });
        void render();
      }),
    ),
  );
  if (s.settings.dryRun) {
    body.append(
      el(
        "div",
        "演练模式：帖文会填进 X 编辑器但不点发送，用来验证 X 改版后 DOM 还认不认得。",
        "muted",
      ),
    );
  }

  const list = $("recent");
  list.replaceChildren();
  if (s.recent.length === 0) {
    list.append(el("li", "还没有记录", "muted"));
  }
  for (const r of s.recent) {
    const li = el("li");
    const meta = RESULT_LABEL[r.result] ?? {
      text: r.result,
      color: "var(--muted)",
    };
    const tag = el("span", meta.text);
    tag.style.color = meta.color;
    tag.style.minWidth = "52px";
    const time = el(
      "span",
      new Date(r.at).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      "muted",
    );
    const kind = el("span", `#${r.id} ${r.kind}`, "muted");
    li.append(tag, time, kind);
    if (r.detail) {
      li.title = r.detail; // 详情放 tooltip,不占行宽
    }
    list.append(li);
  }
}

$("run").addEventListener("click", async () => {
  const btn = $("run") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "拉取中…";
  await send({ type: "ww:run-now" });
  btn.disabled = false;
  btn.textContent = "立即拉取";
  void render();
});

$("disconnect").addEventListener("click", async () => {
  if (!window.confirm("断开后插件将停止发帖，需要重新从 /manage 推送配置。")) {
    return;
  }
  await send({ type: "ww:disconnect" });
  void render();
});

void render();
