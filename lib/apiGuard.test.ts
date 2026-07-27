import { beforeEach, describe, expect, it } from "vitest";
import {
  checkWriteAccess,
  clientIp,
  guardExpensive,
  isPublicDeployment,
  rateLimit,
  rateLimiterSize,
  resetRateLimiter,
  tokenMatches,
} from "./apiGuard";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/test", { headers });
}

describe("isPublicDeployment", () => {
  it("defaults to NODE_ENV=production", () => {
    expect(isPublicDeployment({ NODE_ENV: "production" })).toBe(true);
    expect(isPublicDeployment({ NODE_ENV: "development" })).toBe(false);
    expect(isPublicDeployment({})).toBe(false);
  });

  it("PUBLIC_READONLY explicit truthy wins over dev NODE_ENV", () => {
    for (const v of ["1", "true", "YES", " on "]) {
      expect(
        isPublicDeployment({ NODE_ENV: "development", PUBLIC_READONLY: v }),
      ).toBe(true);
    }
  });

  it("PUBLIC_READONLY explicit falsy wins over production NODE_ENV", () => {
    for (const v of ["0", "false", "no", "off"]) {
      expect(
        isPublicDeployment({ NODE_ENV: "production", PUBLIC_READONLY: v }),
      ).toBe(false);
    }
  });

  it("unrecognized PUBLIC_READONLY falls back to NODE_ENV", () => {
    expect(
      isPublicDeployment({ NODE_ENV: "production", PUBLIC_READONLY: "maybe" }),
    ).toBe(true);
    expect(
      isPublicDeployment({ NODE_ENV: "development", PUBLIC_READONLY: "maybe" }),
    ).toBe(false);
  });
});

describe("tokenMatches", () => {
  it("matches equal tokens and rejects different ones", () => {
    expect(tokenMatches("s3cret", "s3cret")).toBe(true);
    expect(tokenMatches("s3cret", "s3cret2")).toBe(false);
    expect(tokenMatches("wrong", "s3cret")).toBe(false);
  });

  it("never matches when either side is empty", () => {
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches("", "s3cret")).toBe(false);
    expect(tokenMatches("s3cret", "")).toBe(false);
  });
});

describe("checkWriteAccess", () => {
  const PROD = { NODE_ENV: "production", ADMIN_TOKEN: "s3cret" };

  it("always allows outside public deployments (local dev unchanged)", () => {
    const a = checkWriteAccess(req(), { NODE_ENV: "development" });
    expect(a.ok).toBe(true);
  });

  it("fails closed with 403 when public and no ADMIN_TOKEN configured", () => {
    const a = checkWriteAccess(req({ "x-admin-token": "anything" }), {
      NODE_ENV: "production",
    });
    expect(a).toMatchObject({ ok: false, status: 403 });
  });

  it("blank ADMIN_TOKEN counts as unconfigured (whitespace never a valid token)", () => {
    const a = checkWriteAccess(req(), {
      NODE_ENV: "production",
      ADMIN_TOKEN: "   ",
    });
    expect(a).toMatchObject({ ok: false, status: 403 });
  });

  it("401 without or with a wrong x-admin-token header", () => {
    expect(checkWriteAccess(req(), PROD)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(
      checkWriteAccess(req({ "x-admin-token": "nope" }), PROD),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("allows with the correct token", () => {
    expect(checkWriteAccess(req({ "x-admin-token": "s3cret" }), PROD)).toEqual({
      ok: true,
    });
  });
});

describe("clientIp", () => {
  it("prefers cf-connecting-ip, then first x-forwarded-for hop", () => {
    expect(clientIp(req({ "cf-connecting-ip": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(req({ "x-forwarded-for": "5.6.7.8, 9.9.9.9" }))).toBe(
      "5.6.7.8",
    );
    expect(clientIp(req())).toBe("unattributed");
  });
});

describe("rateLimit", () => {
  beforeEach(() => resetRateLimiter());

  it("allows up to the limit within a window, then blocks", () => {
    const t0 = 1_000_000;
    expect(rateLimit("k", 3, 60_000, t0)).toBe(true);
    expect(rateLimit("k", 3, 60_000, t0 + 1)).toBe(true);
    expect(rateLimit("k", 3, 60_000, t0 + 2)).toBe(true);
    expect(rateLimit("k", 3, 60_000, t0 + 3)).toBe(false);
  });

  it("resets after the window elapses", () => {
    const t0 = 1_000_000;
    expect(rateLimit("k", 1, 60_000, t0)).toBe(true);
    expect(rateLimit("k", 1, 60_000, t0 + 1)).toBe(false);
    expect(rateLimit("k", 1, 60_000, t0 + 60_000)).toBe(true);
  });

  it("isolates keys", () => {
    const t0 = 1_000_000;
    expect(rateLimit("a", 1, 60_000, t0)).toBe(true);
    expect(rateLimit("a", 1, 60_000, t0 + 1)).toBe(false);
    expect(rateLimit("b", 1, 60_000, t0 + 1)).toBe(true);
  });

  it("charges `cost` against the window, including on the first call", () => {
    const t0 = 1_000_000;
    // A single oversized call can exhaust the budget outright.
    expect(rateLimit("k", 10, 60_000, t0, 11)).toBe(false);
    // And costs accumulate rather than counting one-per-request.
    expect(rateLimit("j", 10, 60_000, t0, 6)).toBe(true);
    expect(rateLimit("j", 10, 60_000, t0 + 1, 4)).toBe(true);
    expect(rateLimit("j", 10, 60_000, t0 + 2, 1)).toBe(false);
  });

  it("enforces a HARD bucket cap under an all-fresh key flood", () => {
    const t0 = 1_000_000;
    // Nothing is expired, so the sweep can free nothing — the map must still
    // stop growing (this is what made MAX_BUCKETS a no-op before).
    for (let i = 0; i < 6000; i++) rateLimit(`ip-${i}`, 5, 60_000, t0 + i);
    expect(rateLimiterSize()).toBeLessThanOrEqual(4096);
  });

  it("reclaims capacity for new keys once the window rolls over", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5000; i++) rateLimit(`ip-${i}`, 5, 60_000, t0);
    // A later call past the window: the sweep frees the expired keys, so a
    // fresh key is tracked again (the cap must not be a permanent lockout).
    expect(rateLimit("newcomer", 1, 60_000, t0 + 61_000)).toBe(true);
    expect(rateLimit("newcomer", 1, 60_000, t0 + 61_001)).toBe(false);
  });
});

describe("guardExpensive", () => {
  beforeEach(() => resetRateLimiter());
  const env = { NODE_ENV: "production" };
  const LIM = { perIp: 2, global: 1000 };

  it("no-op outside public deployments regardless of volume", () => {
    for (let i = 0; i < 100; i++) {
      expect(
        guardExpensive(
          req(),
          "r",
          { perIp: 1, global: 1 },
          { ages: {} },
          { NODE_ENV: "development" },
        ),
      ).toBeNull();
    }
  });

  it("returns a 429 with the route's error envelope once the limit trips", async () => {
    const r = req({ "cf-connecting-ip": "1.2.3.4" });
    expect(
      guardExpensive(r, "wallet-stats", LIM, { stats: {} }, env),
    ).toBeNull();
    expect(
      guardExpensive(r, "wallet-stats", LIM, { stats: {} }, env),
    ).toBeNull();
    const blocked = guardExpensive(r, "wallet-stats", LIM, { stats: {} }, env);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    const body = (await blocked!.json()) as { stats: object; error: string };
    expect(body.stats).toEqual({});
    expect(body.error).toContain("rate limited");
  });

  it("different IPs do not share a bucket; different routes do not share a bucket", () => {
    const one = { perIp: 1, global: 1000 };
    const a = req({ "cf-connecting-ip": "1.1.1.1" });
    const b = req({ "cf-connecting-ip": "2.2.2.2" });
    expect(guardExpensive(a, "r", one, {}, env)).toBeNull();
    expect(guardExpensive(a, "r", one, {}, env)).not.toBeNull();
    expect(guardExpensive(b, "r", one, {}, env)).toBeNull();
    expect(guardExpensive(a, "r2", one, {}, env)).toBeNull();
  });

  it("the global ceiling holds even when every request forges a fresh IP", () => {
    // The whole point of the second tier: cf-connecting-ip / x-forwarded-for
    // are client-settable whenever the origin port is reachable directly, so a
    // per-IP-only limiter mints a new bucket per request and never fires.
    const limits = { perIp: 100, global: 20 };
    let allowed = 0;
    for (let i = 0; i < 200; i++) {
      const spoofed = req({ "cf-connecting-ip": `10.0.0.${i}` });
      if (guardExpensive(spoofed, "wallet-profile", limits, {}, env) === null) {
        allowed += 1;
      }
    }
    expect(allowed).toBe(20);
  });

  it("charges the global tier even for requests the per-IP tier already rejected", () => {
    const limits = { perIp: 1, global: 3 };
    const a = req({ "cf-connecting-ip": "1.1.1.1" });
    expect(guardExpensive(a, "r", limits, {}, env)).toBeNull(); // global 1
    expect(guardExpensive(a, "r", limits, {}, env)).not.toBeNull(); // global 2
    expect(guardExpensive(a, "r", limits, {}, env)).not.toBeNull(); // global 3
    // A different IP now finds the global budget already spent by the
    // rejected calls — no short-circuit means the ceiling can't be probed for
    // free by an IP that is already over its own quota.
    const b = req({ "cf-connecting-ip": "2.2.2.2" });
    expect(guardExpensive(b, "r", limits, {}, env)).not.toBeNull();
  });

  it("batch cost is charged, so one oversized request exhausts the budget", () => {
    const limits = { perIp: 100, global: 1000, cost: 101 };
    const a = req({ "cf-connecting-ip": "1.1.1.1" });
    expect(guardExpensive(a, "wallet-age", limits, {}, env)).not.toBeNull();
  });

  it("routes sharing a budget name share the ceiling", () => {
    // /api/wallet-stats and /api/wallet/[address] both drive getWalletStats,
    // so they pass the same route name — neither can be used to walk around
    // the other's limit.
    const limits = { perIp: 2, global: 1000 };
    const a = req({ "cf-connecting-ip": "1.1.1.1" });
    expect(guardExpensive(a, "wallet-profile", limits, {}, env)).toBeNull();
    expect(guardExpensive(a, "wallet-profile", limits, {}, env)).toBeNull();
    expect(guardExpensive(a, "wallet-profile", limits, {}, env)).not.toBeNull();
  });
});
