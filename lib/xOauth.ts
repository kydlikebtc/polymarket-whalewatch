// 𝕏 3-legged OAuth 1.0a 流程编排 —— twitter-api-v2 的授权侧触点收在这里
// (发帖侧在 lib/xPublisher.ts)。
//
// 三条腿:
//  1. startAuth: 用 App 的 consumer key 换 request token → 得到授权 URL;
//     **oauthTokenSecret 必须留到回调**(存 x_oauth_pending);
//  2. 运营者在浏览器用目标 bot 账号登录并点同意;
//  3. completeAuth: 用 (request token + secret + verifier) 换 access token,
//     顺带拿回 screen_name / user_id 用于展示与去重。
//
// 依赖注入:两个函数都接受可选的 client 工厂,测试注入假实现,不打真网络。
import { TwitterApi } from "twitter-api-v2";

export interface XAppCreds {
  apiKey: string;
  apiSecret: string;
}

export interface AuthLink {
  url: string;
  oauthToken: string;
  oauthTokenSecret: string;
}

export interface AuthedAccount {
  accessToken: string;
  accessSecret: string;
  userId: string;
  screenName: string;
}

// 测试替身的最小接口(只用到这两个方法)。
export interface AuthClient {
  generateAuthLink(callbackUrl: string): Promise<{
    url: string;
    oauth_token: string;
    oauth_token_secret: string;
  }>;
}

export interface LoginClient {
  login(verifier: string): Promise<{
    accessToken: string;
    accessSecret: string;
    userId: string;
    screenName: string;
  }>;
}

/** 第一步:换 request token,返回让运营者去点同意的授权 URL。 */
export async function startAuth(
  app: XAppCreds,
  callbackUrl: string,
  makeClient: (app: XAppCreds) => AuthClient = (a) =>
    new TwitterApi({
      appKey: a.apiKey,
      appSecret: a.apiSecret,
    }) as unknown as AuthClient,
): Promise<AuthLink> {
  const r = await makeClient(app).generateAuthLink(callbackUrl);
  return {
    url: r.url,
    oauthToken: r.oauth_token,
    oauthTokenSecret: r.oauth_token_secret,
  };
}

/** 第三步:verifier 换 access token(该 token 属于点同意的那个账号)。 */
export async function completeAuth(
  app: XAppCreds,
  oauthToken: string,
  oauthTokenSecret: string,
  verifier: string,
  makeClient: (app: XAppCreds, token: string, secret: string) => LoginClient = (
    a,
    token,
    secret,
  ) =>
    new TwitterApi({
      appKey: a.apiKey,
      appSecret: a.apiSecret,
      accessToken: token,
      accessSecret: secret,
    }) as unknown as LoginClient,
): Promise<AuthedAccount> {
  const r = await makeClient(app, oauthToken, oauthTokenSecret).login(verifier);
  return {
    accessToken: r.accessToken,
    accessSecret: r.accessSecret,
    userId: r.userId,
    screenName: r.screenName,
  };
}
