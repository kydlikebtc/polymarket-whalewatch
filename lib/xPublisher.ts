// X API 客户端封装 —— twitter-api-v2 的全部触点收在这一个文件。
//
// 库版本事实(v1.29,装包时核实):`client.v2.tweet(text, payload?)` 发帖;
// `client.v2.uploadMedia(buf, { media_type })` 走 v2 分块媒体上传并返回
// media id(按量付费新应用只有 v2 媒体端点可用,v1.1 已对其关闭)。
// 换库/升级坏了只改这里 —— 消费方(xBroadcast/xWeekly)只见 XClient 接口。
import { TwitterApi } from "twitter-api-v2";

export interface XClient {
  /** 发纯文本帖,返回 X post id。 */
  postText(text: string): Promise<string>;
  /** 上传 PNG 后带图发帖(周报成绩单),返回 X post id。 */
  postWithPng(text: string, png: Buffer): Promise<string>;
  /**
   * 回复自己的某条帖(结算战报),返回新帖 id。
   *
   * 只用于 self-reply:回自己发过的信号帖,形成"信号 → 结果"的 thread。
   * 绝不用于回复他人 —— X 的自动化规则明令禁止「自动化 @/回复以触达
   * 未主动请求的用户」,违者帖子被移出搜索甚至封号,而且 @ 别人根本
   * 不会把帖子推进对方的粉丝流,违规且无效。
   */
  replyText(text: string, inReplyToPostId: string): Promise<string>;
}

/**
 * 永久/瞬态错误分类,对齐 lib/telegram isPermanentSendError 的语义:
 * 4xx(除 429)= 请求本身有问题,重试永不会成功 → 标 failed 保 claim,
 * 毒帖不能堵队列;429/5xx/网络异常 = 瞬态 → 回滚 claim 下轮重试。
 * ApiResponseError 用 `.code`(HTTP 状态)鸭子判型 —— 网络层错误
 * (ApiRequestError)没有 code,自然落在瞬态侧。
 */
export function isPermanentXError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "number") return false;
  return code >= 400 && code < 500 && code !== 429;
}

export interface XCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

export function createXClient(c: XCreds): XClient {
  // OAuth 1.0a user context —— 单账号 bot 最简单也是 v2 写端点要求的授权形态。
  const api = new TwitterApi({
    appKey: c.apiKey,
    appSecret: c.apiSecret,
    accessToken: c.accessToken,
    accessSecret: c.accessSecret,
  });
  return {
    async postText(text: string): Promise<string> {
      const r = await api.v2.tweet(text);
      return r.data.id;
    },
    async postWithPng(text: string, png: Buffer): Promise<string> {
      const mediaId = await api.v2.uploadMedia(png, {
        media_type: "image/png",
      });
      const r = await api.v2.tweet(text, { media: { media_ids: [mediaId] } });
      return r.data.id;
    },
    async replyText(text: string, inReplyToPostId: string): Promise<string> {
      const r = await api.v2.tweet(text, {
        reply: { in_reply_to_tweet_id: inReplyToPostId },
      });
      return r.data.id;
    },
  };
}
