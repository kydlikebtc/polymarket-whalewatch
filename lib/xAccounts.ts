// 𝕏 多账号凭据仓储 —— 3-legged OAuth 授权到的 access token 落库与选用。
//
// 语义(设计文档 2026-08-17-x-multi-account-design.md,用户已裁决):
//  · 「主账号发、其余备用」:全表至多一行 is_active=1,切换即时生效(引擎
//    每轮解析一次凭据,≤60s 换号,无需重启);
//  · access token 属于**账号**不属于 App,所以它进库;consumer key/secret
//    属于 App,只从 .env 读,永不落库;
//  · 明文存储(与既有 webhook_endpoints.secret / api_keys 同量级),库文件
//    在自有服务器上。
import type { DB } from "./db";

// 3-legged 中途态的存活时长:授权页开着不动超过这个时间就得重来。
export const PENDING_TTL_SEC = 15 * 60;

export interface XAccount {
  id: number;
  userId: string;
  screenName: string;
  isActive: boolean;
  createdAt: number;
  lastPostAt: number | null;
}

interface AccountRow {
  id: number;
  user_id: string;
  screen_name: string;
  access_token: string;
  access_secret: string;
  is_active: number;
  created_at: number;
  last_post_at: number | null;
}

function toAccount(r: AccountRow): XAccount {
  return {
    id: r.id,
    userId: r.user_id,
    screenName: r.screen_name,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    lastPostAt: r.last_post_at,
  };
}

/** 授权时间升序(先授权的在上,列表顺序稳定)。不含 token —— 调用方是 UI。 */
export function listAccounts(db: DB): XAccount[] {
  return (
    db
      .prepare("SELECT * FROM x_accounts ORDER BY created_at ASC, id ASC")
      .all() as AccountRow[]
  ).map(toAccount);
}

export interface UpsertInput {
  userId: string;
  screenName: string;
  accessToken: string;
  accessSecret: string;
  nowSec: number;
}

/**
 * 授权回调落库。同一 user_id 重复授权 = **换 token 不新增行**(token 轮换
 * 或改名后重新授权都走这条),并刷新 screen_name(handle 可以改)。
 * 表里还没有 active 时,新账号自动顶上 —— 否则运营者授权完还要多点一步
 * 才会真的发帖,是个纯粹的坑。
 */
export function upsertAccount(db: DB, i: UpsertInput): void {
  const tx = db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM x_accounts WHERE user_id = ?")
      .get(i.userId) as { id: number } | undefined;
    if (existing) {
      db.prepare(
        "UPDATE x_accounts SET screen_name = ?, access_token = ?, access_secret = ? WHERE id = ?",
      ).run(i.screenName, i.accessToken, i.accessSecret, existing.id);
    } else {
      db.prepare(
        `INSERT INTO x_accounts (user_id, screen_name, access_token, access_secret, is_active, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      ).run(i.userId, i.screenName, i.accessToken, i.accessSecret, i.nowSec);
    }
    const active = db
      .prepare("SELECT COUNT(*) AS n FROM x_accounts WHERE is_active = 1")
      .get() as { n: number };
    if (active.n === 0) {
      db.prepare("UPDATE x_accounts SET is_active = 1 WHERE user_id = ?").run(
        i.userId,
      );
    }
  });
  tx();
}

/** 切换使用中的账号(排他:同一事务里先清后置)。id 不存在 → false。 */
export function activateAccount(db: DB, id: number): boolean {
  const tx = db.transaction(() => {
    const hit = db
      .prepare("SELECT 1 FROM x_accounts WHERE id = ?")
      .get(id) as unknown;
    if (!hit) return false;
    db.prepare("UPDATE x_accounts SET is_active = 0 WHERE is_active = 1").run();
    db.prepare("UPDATE x_accounts SET is_active = 1 WHERE id = ?").run(id);
    return true;
  });
  return tx() as boolean;
}

/**
 * 删除账号。删掉的若是使用中那个,**剩下最早授权的自动顶上** —— 不留
 * 「有账号却没有 active」的空窗(那会让播报静默停摆,是最贵的故障形态)。
 */
export function deleteAccount(db: DB, id: number): boolean {
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT is_active FROM x_accounts WHERE id = ?")
      .get(id) as { is_active: number } | undefined;
    if (!row) return false;
    db.prepare("DELETE FROM x_accounts WHERE id = ?").run(id);
    if (row.is_active === 1) {
      const next = db
        .prepare(
          "SELECT id FROM x_accounts ORDER BY created_at ASC, id ASC LIMIT 1",
        )
        .get() as { id: number } | undefined;
      if (next) {
        db.prepare("UPDATE x_accounts SET is_active = 1 WHERE id = ?").run(
          next.id,
        );
      }
    }
    return true;
  });
  return tx() as boolean;
}

/** 发帖成功后打点,运营页据此看账号是否还在工作。 */
export function markPosted(db: DB, userId: string, nowSec: number): void {
  db.prepare("UPDATE x_accounts SET last_post_at = ? WHERE user_id = ?").run(
    nowSec,
    userId,
  );
}

// --- 3-legged 中途态 --------------------------------------------------------

/** 第一步换到 request token 后存住 secret,回调那一刻才用得上。 */
export function savePending(
  db: DB,
  oauthToken: string,
  oauthTokenSecret: string,
  nowSec: number,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO x_oauth_pending (oauth_token, oauth_token_secret, created_at) VALUES (?, ?, ?)",
  ).run(oauthToken, oauthTokenSecret, nowSec);
  // 顺手清过期行(量极小,不值得单开清理循环)。
  db.prepare("DELETE FROM x_oauth_pending WHERE created_at < ?").run(
    nowSec - PENDING_TTL_SEC,
  );
}

/**
 * 取出并**立即删除** —— 一次性消费是回调路由的安全支点:该路由不能要求
 * ADMIN_TOKEN(X 直接把浏览器跳过来,带不上自定义头),防重放全靠这里。
 * 未知 token / 过期 token 一律 null,伪造的回调无法落库。
 */
export function consumePending(
  db: DB,
  oauthToken: string,
  nowSec: number,
): string | null {
  const row = db
    .prepare(
      "SELECT oauth_token_secret, created_at FROM x_oauth_pending WHERE oauth_token = ?",
    )
    .get(oauthToken) as
    { oauth_token_secret: string; created_at: number } | undefined;
  db.prepare("DELETE FROM x_oauth_pending WHERE oauth_token = ?").run(
    oauthToken,
  );
  if (!row) return null;
  if (nowSec - row.created_at > PENDING_TTL_SEC) return null;
  return row.oauth_token_secret;
}

// --- 凭据选用 ---------------------------------------------------------------

export interface ResolvedCreds {
  accessToken: string;
  accessSecret: string;
  /** db = 授权账号;env = .env 里的首版单账号配置(向后兼容)。 */
  source: "db" | "env";
  userId: string | null;
  screenName: string | null;
}

/**
 * 发帖凭据的单一入口。优先级:
 *   1. x_accounts 里 is_active=1 的账号;
 *   2. .env 的 X_ACCESS_TOKEN/X_ACCESS_SECRET(首版配好的部署不被破坏);
 *   3. 都没有 → null,X 循环整体不启动(fail-closed)。
 * 引擎每轮调用一次(不缓存),所以 /manage 换号后下一轮自动生效。
 */
export function resolveXCreds(
  db: DB,
  cfg: { xAccessToken?: string; xAccessSecret?: string },
): ResolvedCreds | null {
  const row = db
    .prepare("SELECT * FROM x_accounts WHERE is_active = 1 LIMIT 1")
    .get() as AccountRow | undefined;
  if (row) {
    return {
      accessToken: row.access_token,
      accessSecret: row.access_secret,
      source: "db",
      userId: row.user_id,
      screenName: row.screen_name,
    };
  }
  if (cfg.xAccessToken && cfg.xAccessSecret) {
    return {
      accessToken: cfg.xAccessToken,
      accessSecret: cfg.xAccessSecret,
      source: "env",
      userId: null,
      screenName: null,
    };
  }
  return null;
}
