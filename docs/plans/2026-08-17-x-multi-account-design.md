# 𝕏 多账号授权与管理（3-legged OAuth）设计

日期：2026-08-17
状态：用户已委托开发（路线 B + /manage 管理）

## 1. 背景与选型

X 播报 bot 首版从 `.env` 直接读一对 access token 发帖，绑定的是「建 App 的那个账号」。
用户要让 bot 用**独立账号**发帖、且要能在 `/manage` 里管理多个账号，因此走
**3-legged OAuth 1.0a**：一个 App（主账号所有）服务多个授权账号。

用户已裁决两项：

- **发帖语义 = 主账号发、其余备用**：同时只有一个账号 `is_active=1`，其余已授权
  账号待命，一键切换（封号 / 换品牌 / 测试号转正式号时零停机）。预算口径不变。
- **凭据存储 = 明文 SQLite**：与既有 `webhook_endpoints.secret` / `api_keys` 同一
  量级的做法，库文件在自有服务器上，每日备份的加密边界不变。

## 2. 数据模型

```sql
-- 已授权账号（access token 属于账号，不属于 App）
CREATE TABLE x_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,     -- X 数字 id，重复授权即更新（换 token 不新增行）
  screen_name TEXT NOT NULL,        -- @handle，可能改名，每次授权刷新
  access_token TEXT NOT NULL,
  access_secret TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,  -- 全表至多一行为 1
  created_at INTEGER NOT NULL,
  last_post_at INTEGER
);

-- 3-legged 中途态：第一步的 request token secret 必须留到回调那一刻
CREATE TABLE x_oauth_pending (
  oauth_token TEXT PRIMARY KEY,
  oauth_token_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

`x_oauth_pending` 是一次性凭证：回调消费后立即删除，超过 15 分钟的行按过期清理。

## 3. 流程

1. `/manage` 点「授权新账号」→ `POST /api/admin/x-accounts`（`action:"start"`，
   ADMIN_TOKEN）→ 服务端用 App 的 consumer key 换 request token，存 pending，
   返回 `https://api.x.com/oauth/authorize?oauth_token=…`。
2. 运营者在新标签用**目标 bot 账号**登录并点同意。
3. X 跳回 `GET /api/x-callback?oauth_token=&oauth_verifier=` →
   取出并**删除** pending → 换 access token → 读回 screen_name/user_id →
   upsert 进 `x_accounts`（**首个账号自动设为 active**）→ 302 回 `/manage`。
4. `/manage` 列表可切换 active / 删除。

**回调路由不能要求 ADMIN_TOKEN**（X 直接把浏览器跳过来，带不上自定义头）。
安全性由三点保证：pending 一次性消费 + 15 分钟 TTL + `oauth_token` 是我们
自己刚生成、未存过的值一律拒绝（攻击者无法伪造一条能落库的回调）。

## 4. 发帖侧改造

`resolveXCreds(db, cfg)` 单一入口，优先级：

1. `x_accounts` 里 `is_active=1` 的账号 → 用它的 token；
2. 否则回退 `.env` 的 `X_ACCESS_TOKEN/X_ACCESS_SECRET`（**向后兼容**，已按首版
   配好的部署不受影响）；
3. 两者皆无 → X 循环整体不启动（沿用 fail-closed）。

consumer key/secret 仍只来自 `.env`（`X_API_KEY/X_API_SECRET`）——它属于 App
不属于账号，不进库。engine 每轮解析一次（不缓存），所以在 `/manage` 切换账号
后**下一轮（≤60s）自动生效，无需重启**。

## 5. /manage 新区块「𝕏 播报账号」

列表列：@handle · 状态（🟢 使用中 / 待命）· 授权时间 · 最近发帖 · 操作（设为使用中 / 删除）。
顶部一个「授权新账号」按钮。删除使用中的账号需确认（与既有危险操作一致）。
文案走双语 `t()`（本页其余存量文案的双语化另计，见 §7）。

## 6. 测试

- `lib/xAccounts.ts` 纯 DB 层单测：upsert 幂等（同 user_id 换 token 不新增行）、
  active 唯一性（切换即清旧）、pending 一次性消费与过期、首账号自动激活。
- `lib/xOauth.ts` 以注入的 fake client 测流程编排（不打真网络）。
- `resolveXCreds` 三条优先级路径。

## 7. 非目标（本批不做）

- 每账号独立预算 / 多账号同时发（用户已裁决「主账号发」）。
- `/manage` 与 `/record` 存量页面的双语化（合并 main 带来的新页面，尚是纯中文）——
  独立小批次处理，不阻塞本功能。
- token 加密存储（用户已裁决明文）。
