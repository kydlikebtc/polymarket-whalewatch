// 服务端队列的客户端 + **本地已发记忆**。
//
// 这个文件存在的全部理由是一条裂缝:at-least-once 下,「发帖成功但 ack 没
// 送达」与「插件死了没发出去」在服务端看起来一模一样(都是租约超时)。服务端
// 只能选择退回队列重试,于是同一条帖会被再次租借出来。
//
// 唯一能区分这两种情况的信息 —— 「我到底发出去没有」—— 只在插件这一侧。
// 所以插件必须"哑但有记忆":不含任何业务逻辑,但必须记得自己做过什么。
//
// 顺序不能反:**先记本地,再 ack**。反过来的话,ack 发出后进程被杀,本地
// 没留痕,下轮就会重发。多一次冗余 ack 的代价是零(服务端返回 duplicate),
// 重发一条帖的代价是账号上多一条重复推文。
import type {
  AckBody,
  AckResult,
  QueueResponse,
  QueuedPost,
  WwExtensionConfig,
} from "../shared/protocol";

/**
 * 我们实际用到的 fetch 子集。刻意不写 typeof fetch:那个重载签名(URL |
 * RequestInfo | Request …)在测试里没法用一个简单的 mock 满足,而我们只用
 * 「字符串 URL + RequestInit」这一种形态。类型窄到真实用法,mock 就自然合法。
 */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** 一次发帖尝试的结局(由 x.poster 观察页面后给出)。 */
export interface PostOutcome {
  result: AckResult;
  xPostId?: string;
  error?: string;
}

/**
 * 本地已发记忆。值是 x post id;空串表示「发过但没抓到 id」(unconfirmed)——
 * 用空串而不是删掉记录,是因为这两种状态的重发风险完全一样。
 */
export interface QueueStore {
  getPosted(id: number): Promise<string | null>;
  rememberPosted(id: number, xPostId: string): Promise<void>;
  forgetPosted(id: number): Promise<void>;
  listPending(): Promise<{ id: number; xPostId: string }[]>;
}

export type FetchResult =
  | { kind: "ok"; posts: QueuedPost[]; serverTime: number }
  /** key 无效或没有发帖能力 —— 要人去改配置,重试没有意义。 */
  | { kind: "unauthorized"; error: string }
  /** 网络/5xx —— 下一轮自然重试。 */
  | { kind: "error"; error: string };

export class QueueClient {
  private readonly store: QueueStore;
  private readonly fetchImpl: FetchLike;

  constructor(deps: { store: QueueStore; fetchImpl?: FetchLike }) {
    this.store = deps.store;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async fetchBatch(
    cfg: WwExtensionConfig,
    limit: number,
  ): Promise<FetchResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${cfg.baseUrl}/api/x-queue?limit=${limit}`, {
        headers: { "x-feed-token": cfg.apiKey },
      });
    } catch (e) {
      return { kind: "error", error: msg(e) };
    }
    if (res.status === 401 || res.status === 403) {
      return { kind: "unauthorized", error: await errorText(res) };
    }
    if (!res.ok) {
      return { kind: "error", error: `HTTP ${res.status}` };
    }
    try {
      const body = (await res.json()) as QueueResponse;
      return {
        kind: "ok",
        posts: Array.isArray(body.posts) ? body.posts : [],
        serverTime: body.serverTime ?? 0,
      };
    } catch (e) {
      return { kind: "error", error: `响应不是合法 JSON: ${msg(e)}` };
    }
  }

  /**
   * 处理一条:先查本地记忆决定要不要真发,发完先记本地再 ack。
   * `publish` 由调用方注入(x.poster 的 postXCompose),便于单测。
   */
  async processOne(
    cfg: WwExtensionConfig,
    post: QueuedPost,
    publish: (post: QueuedPost) => Promise<PostOutcome>,
  ): Promise<PostOutcome> {
    const already = await this.store.getPosted(post.id);
    if (already !== null) {
      // 上一轮发过了,只是 ack 没送到。补 ack,绝不重发。
      // 空串 = 当时是 unconfirmed,补 ack 时必须仍然报 unconfirmed ——
      // 谎报 posted 会让 /manage 上少一条待人工核对的记录。
      const outcome: PostOutcome =
        already === ""
          ? { result: "unconfirmed" }
          : { result: "posted", xPostId: already };
      console.log(
        `[whalewatch] post ${post.id} 已发过（${already || "无 id"}），只补 ack`,
      );
      if (await this.ack(cfg, ackBodyFor(post.id, outcome))) {
        await this.store.forgetPosted(post.id);
      }
      return outcome;
    }

    let outcome: PostOutcome;
    try {
      outcome = await publish(post);
    } catch (e) {
      // 未知异常按**通道级**故障处理:它会触发熔断停下来等人看,而按单帖
      // 失败处理会一条条把队列烧光。停下来可恢复,烧光不可。
      outcome = { result: "channel_error", error: msg(e) };
    }

    if (outcome.result === "posted" || outcome.result === "unconfirmed") {
      // 先记本地再 ack —— 顺序反了就等于给重发留了窗口。
      await this.store.rememberPosted(post.id, outcome.xPostId ?? "");
    }
    if (await this.ack(cfg, ackBodyFor(post.id, outcome))) {
      if (outcome.result === "posted" || outcome.result === "unconfirmed") {
        await this.store.forgetPosted(post.id);
      }
    }
    return outcome;
  }

  /** 把积压的本地记录逐条补 ack。返回补成功的条数。 */
  async flushPending(cfg: WwExtensionConfig): Promise<number> {
    const pending = await this.store.listPending();
    let done = 0;
    for (const p of pending) {
      const body: AckBody =
        p.xPostId === ""
          ? { id: p.id, result: "unconfirmed" }
          : { id: p.id, result: "posted", xPostId: p.xPostId };
      if (await this.ack(cfg, body)) {
        await this.store.forgetPosted(p.id);
        done++;
      }
    }
    if (done > 0) {
      console.log(`[whalewatch] 补投 ${done} 条积压 ack`);
    }
    return done;
  }

  /** 返回 true = 服务端确认收到(含 duplicate,那也是"已经知道了")。 */
  private async ack(cfg: WwExtensionConfig, body: AckBody): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${cfg.baseUrl}/api/x-queue/ack`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-feed-token": cfg.apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn(`[whalewatch] ack ${body.id} 失败 HTTP ${res.status}`);
      }
      return res.ok;
    } catch (e) {
      console.warn(`[whalewatch] ack ${body.id} 失败:`, msg(e));
      return false;
    }
  }
}

/** 只带上真正有值的可选字段 —— 服务端的 zod schema 拒绝 undefined。 */
function ackBodyFor(id: number, o: PostOutcome): AckBody {
  const body: AckBody = { id, result: o.result };
  if (o.xPostId !== undefined) body.xPostId = o.xPostId;
  if (o.error !== undefined) body.error = o.error;
  return body;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
