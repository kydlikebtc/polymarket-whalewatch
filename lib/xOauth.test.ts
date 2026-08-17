import { describe, it, expect } from "vitest";
import { completeAuth, startAuth } from "./xOauth";

const APP = { apiKey: "ck", apiSecret: "cs" };

describe("startAuth", () => {
  it("把 callback 传给 X 并透出授权 URL 与 request token 对", async () => {
    let seenCallback = "";
    const link = await startAuth(APP, "https://site/api/x-callback", () => ({
      async generateAuthLink(cb: string) {
        seenCallback = cb;
        return {
          url: "https://api.x.com/oauth/authorize?oauth_token=rt",
          oauth_token: "rt",
          oauth_token_secret: "rts",
        };
      },
    }));
    expect(seenCallback).toBe("https://site/api/x-callback");
    expect(link).toEqual({
      url: "https://api.x.com/oauth/authorize?oauth_token=rt",
      oauthToken: "rt",
      oauthTokenSecret: "rts",
    });
  });
});

describe("completeAuth", () => {
  it("用 request token 对 + verifier 换到账号自己的 access token", async () => {
    const seen: Record<string, string> = {};
    const acc = await completeAuth(
      APP,
      "rt",
      "rts",
      "verif",
      (app, token, secret) => {
        seen.token = token;
        seen.secret = secret;
        seen.appKey = app.apiKey;
        return {
          async login(v: string) {
            seen.verifier = v;
            return {
              accessToken: "at",
              accessSecret: "as",
              userId: "42",
              screenName: "PolyWhaleWatch",
            };
          },
        };
      },
    );
    // 换 token 这一步用的是 request token 对,不是 App 的 access token
    expect(seen).toMatchObject({
      token: "rt",
      secret: "rts",
      appKey: "ck",
      verifier: "verif",
    });
    expect(acc).toEqual({
      accessToken: "at",
      accessSecret: "as",
      userId: "42",
      screenName: "PolyWhaleWatch",
    });
  });
});
