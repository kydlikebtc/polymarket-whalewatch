// Service worker:60s 一轮,拉队列 → 在后台标签页发帖 → 回报结果。
//
// 插件在整个系统里是"哑但有记忆"的手:不判断金额、不选模板、不算配额 ——
// 那些都在服务端。它只做两件事:把服务端给的字符串发到 X 上,以及记得自己
// 发过什么(那是跨网络幂等唯一无法由服务端承担的一半,见 queue.client)。
//
// MV3 的 service worker 随时会被浏览器回收,所以:
//   · 调度用 chrome.alarms 而不是 setInterval(后者随 worker 一起死);
//   · 所有状态落 chrome.storage,内存里只留熔断器这种可重建的东西。
import { CircuitBreaker } from "./breaker";
import { QueueClient } from "./queue.client";
import { postXCompose } from "./x.poster";
import {
  chromeQueueStore,
  clearConfig,
  getConfig,
  getRecent,
  getSettings,
  pushRecent,
  setConfig,
  setSettings,
} from "./storage";
import {
  WW_EXTENSION_MESSAGE,
  type WwExtensionAck,
  type WwExtensionConfig,
} from "../shared/protocol";

const ALARM = "ww:poll";
const POLL_PERIOD_MIN = 1; // chrome.alarms 的最小周期就是 1 分钟
/** 一轮最多拉几条:少量多次比大批量抖动小(见 lib/xQueueRoute 的同款论证)。 */
const BATCH = 3;

const VERSION = chrome.runtime.getManifest().version;
const breaker = new CircuitBreaker();
const client = new QueueClient({ store: chromeQueueStore });

/** 同一时刻只允许一轮 —— alarm 与「立即拉取」按钮可能撞车。 */
let running = false;

async function notify(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title,
      message,
    });
  } catch (e) {
    // 没有图标资源等原因失败时不能拖累主流程。
    console.warn("[whalewatch] 通知发送失败", e);
  }
}

async function runCycle(trigger: "alarm" | "manual"): Promise<void> {
  if (running) {
    console.log("[whalewatch] 上一轮还没结束,跳过");
    return;
  }
  running = true;
  try {
    const cfg = await getConfig();
    if (!cfg) return; // 还没配置,静默待命

    const settings = await getSettings();
    if (!settings.enabled) return;

    const now = Date.now();
    if (!breaker.canRun(now)) {
      console.log(
        `[whalewatch] 通道熔断中（${breaker.lastError() ?? "未知原因"}），等待探活窗口`,
      );
      return;
    }

    // 先补上轮没送达的 ack,再拉新的 —— 否则服务端那边的租约会一直超时
    // 退回,同一条帖来回打转。
    await client.flushPending(cfg);

    const batch = await client.fetchBatch(cfg, BATCH);
    if (batch.kind === "unauthorized") {
      // key 被吊销 / 没有发帖能力:重试永远不会成功,清掉配置并告诉运营者,
      // 而不是带着一把废 key 每分钟静默失败一次。
      await clearConfig();
      await notify(
        "WhaleWatch：连接已失效",
        `${batch.error}\n请到 /manage 重新签发并推送配置。`,
      );
      console.error("[whalewatch] 鉴权失败，已清空本地配置:", batch.error);
      return;
    }
    if (batch.kind === "error") {
      console.warn(`[whalewatch] 拉取队列失败（下轮重试）: ${batch.error}`);
      return;
    }
    if (batch.posts.length === 0) {
      if (trigger === "manual") console.log("[whalewatch] 队列为空");
      return;
    }

    console.log(`[whalewatch] 领到 ${batch.posts.length} 条待发`);
    for (const post of batch.posts) {
      const outcome = await client.processOne(cfg, post, (p) =>
        postXCompose({
          text: p.text,
          imageUrl: p.imageUrl,
          autoSubmit: !settings.dryRun,
        }),
      );
      await pushRecent({
        id: post.id,
        kind: post.kind,
        result: outcome.result,
        at: Date.now(),
        detail: outcome.error,
      });

      if (outcome.result === "channel_error") {
        breaker.recordChannelError(Date.now(), outcome.error);
        if (breaker.isOpen()) {
          await notify(
            "WhaleWatch：𝕏 通道故障",
            `${outcome.error ?? "未知原因"}\n已暂停发帖，10 分钟后自动重试。请检查 x.com 是否还登录着。`,
          );
        }
        // 通道坏了就别继续拿后面的帖去撞墙 —— 它们已经被 ack 退回队列了。
        break;
      }
      breaker.recordSuccess();
    }
  } catch (e) {
    console.error("[whalewatch] 轮次异常", e);
  } finally {
    running = false;
  }
}

// --- 事件接线 --------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: POLL_PERIOD_MIN });
  console.log(`[whalewatch] 已安装 v${VERSION}`);
});

// service worker 被回收后重新唤醒时 onInstalled 不会再触发,alarm 却还在 ——
// 但如果浏览器重启过,这里补建一次更保险(create 同名 alarm 是幂等覆盖)。
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: POLL_PERIOD_MIN });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void runCycle("alarm");
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  void (async () => {
    try {
      switch (msg?.type) {
        case "ww:configure": {
          // 来自 /manage 的配置桥。校验已在 content script 做过三重来源检查。
          await setConfig(msg.config as WwExtensionConfig);
          chrome.alarms.create(ALARM, { periodInMinutes: POLL_PERIOD_MIN });
          void runCycle("manual"); // 配好立刻跑一轮,不用等到下一分钟
          sendResponse({ ok: true, version: VERSION } satisfies WwExtensionAck);
          return;
        }
        case "ww:status": {
          sendResponse({
            connected: (await getConfig()) !== null,
            baseUrl: (await getConfig())?.baseUrl ?? null,
            settings: await getSettings(),
            breaker: breaker.snapshot(),
            recent: await getRecent(),
            version: VERSION,
          });
          return;
        }
        case "ww:settings": {
          sendResponse({ settings: await setSettings(msg.patch) });
          return;
        }
        case "ww:run-now": {
          await runCycle("manual");
          sendResponse({ ok: true });
          return;
        }
        case "ww:disconnect": {
          await clearConfig();
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: `未知消息: ${msg?.type}` });
      }
    } catch (e) {
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
  return true; // 保持消息通道开放以便异步 sendResponse
});

console.log(
  `[whalewatch] service worker 就绪 v${VERSION}（协议 ${WW_EXTENSION_MESSAGE.source}）`,
);
