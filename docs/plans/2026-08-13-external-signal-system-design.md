# 对外信号系统（Signal Out）— 完整规划设计与工程量分析

> 状态：2026-08-13 设计稿，待用户批准后实施。
> 需求：基于当前项目开发一套对外输出的信号系统，包括但不限于策略中心里触发买入的信号；
> 要求完整规划设计 + 完整工程量/工作量分析。

---

## 1. 现状盘点：三套信号系统，只有两套半有出口

代码实证（2026-08-13 全仓调研）：

| 信号系统                     | 产生点                                                     | 周期 | 落库                  | 对外出口                              |
| ---------------------------- | ---------------------------------------------------------- | ---- | --------------------- | ------------------------------------- |
| ① 大额/聪明钱告警            | `lib/alertEngine.ts:404 recordAlert`                       | 4s   | `alerts` 表           | TG 频道推送 ✅                        |
| ② 共识/分歧/巨鲸 feed        | `lib/consensus.ts:560` + `lib/signalFeed.ts:380`           | 5min | `alerts` 表           | TG 推送 ✅ + `GET /api/signals` ✅    |
| ③ **策略中心 13 档买入触发** | `lib/follow.ts:578`（detector）→ `:771-793`（开仓 INSERT） | 5min | `follow_positions` 表 | **零出口** —— 只有 `/follow` 页面自读 |

关键事实：

- `runFollowCycle` 的 `FollowCycleDeps`（`lib/follow.ts:272-308`）**没有 `send` 字段**，从不写
  `alerts` 表。13 档策略候选被 6 个 detector（`lib/followCandidate.ts:177-184` 注册表）产出、
  经六道闸门开成纸面仓后，就地沉淀 —— 含金量最高的信号（带策略归因、聪明钱成本基准
  `referencePrice`、模拟执行 `exec_price`、每档可算的 30d 战绩）目前对外完全不可见。
- `GET /api/signals`（`app/api/signals/route.ts` + `docs/signals-api.md`）已经是「对外卖信号」
  的 80% 雏形：独立只读令牌 `SIGNAL_FEED_TOKEN`（fail-closed、可独立吊销）、30s 缓存、
  零上游调用、折叠/战绩口径已定稿。但它是**单 token 单消费者**（mm-mobile 后端），
  且只覆盖 ②，不含 ③。
- 全仓 grep 确认：webhook / RSS / 邮件 / SSE / Discord 出口**全部不存在**；
  出站 HTTP 仅 Telegram 两个端点 + 健康 ping。
- 多租户基础设施**完全缺失**：无用户表、无 per-key 限流（`lib/apiGuard.ts` 是
  per-IP + per-route 全局两层内存 Map）、无投递记录（alerts 只记「产生过」不记「推给了谁」）、
  bot 无订阅态（唯一持久状态是 `config.bot_updates_offset`）。

### 1.1 可直接复用的资产（决定了工程量下限）

| 资产                                                          | 位置                                        | 复用方式                            |
| ------------------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| TG 发送（429/5xx 退避、毒消息降级、permanent/transient 分类） | `lib/telegram.ts:73 sendMessage`            | 新通道直接调用，零改动              |
| claim-then-send 跨进程幂等（UNIQUE + INSERT OR IGNORE）       | `alerts` 表模式（`lib/consensus.ts:578`）   | 投递表照抄同一形状                  |
| 常量时间 token 比较 + 两层限流                                | `lib/apiGuard.ts:35 tokenMatches`           | api_keys 校验直接用                 |
| 折叠/分类/战绩口径（implied/excess/±2σ 铁律）                 | `lib/signalFeed.ts` + `lib/signalRecord.ts` | 所有新通道共用同一实现              |
| 消息格式化纯函数                                              | `lib/tgFormat.ts` + `formatRecordLine`      | webhook payload/TG 共用措辞         |
| 循环模板（setTimeout 自调度 + try/catch + beat 心跳）         | `worker/embeddedEngine.ts` 六个循环         | 新投递循环 = 第七个循环，照抄三件套 |
| 每日自检/死人开关/健康体系                                    | `lib/heartbeat.ts` / `lib/health.ts`        | 新循环注册一行阈值即纳入            |

### 1.2 部署硬约束（决定了架构选型）

1. **单容器单进程 + SQLite 文件锁（WAL）**：新的常驻投递逻辑必须做成
   `startAlertEngine()` 里的第七个循环，而不是新 container / 新进程。
2. 限流是进程内 Map —— 计费/配额不能建在它上面（重启清零），只能建在 SQLite 表上。
3. 一个 bot token 只能有一个 `getUpdates` 消费者（409 冲突）。
4. server bundle 内 Node 内置模块必须用裸名（`crypto` 而非 `node:crypto`，
   `next.config.mjs:22-38` 约定）。
5. compose 只暴露一个端口，新接口一律走 Next 路由。

---

## 2. 需求假设与商业约束（非交互会话，显式列出）

来自 2026-07-24 竞品深度调研（PolyPick 核查 + 170+ 工具扫描）的五条铁律，
本设计把它们当作**约束条件**而非参考意见：

| #   | 约束                                                           | 对设计的直接影响                                        |
| --- | -------------------------------------------------------------- | ------------------------------------------------------- |
| C1  | 信息层订阅天花板极低，纯告警已商品化到零价                     | 不建重账户体系 SaaS；轻量 key/频道成员制                |
| C2  | 散户只为两样付费：**延迟差**（免费 5-30min vs 付费实时）与执行 | 免费=延迟版（建可验证记录），付费=实时版                |
| C3  | 只读/非托管是全赛道信任卖点（Polycule 被盗后）                 | 不做执行层、不碰资金；对外文案强调 read-only            |
| C4  | 验证闭环（implied/excess/±2σ）是全赛道唯一无人拥有的信任资产   | 战绩披露是产品核心而非附属；先发布后结算的存证机制      |
| C5  | 支付习惯：USDC on Polygon 无 KYC 或 Whop                       | 首版手工授予，Whop 类工具（可售卖 TG 频道成员资格）后接 |

需求假设（用户未逐条确认，按项目既有裁决 §10-1 推定）：

- **A1 目标用户**：付费个人交易者（小额订阅）+ 免费公开受众（引流与可信度建设）；
  机构 API 客户不是首版目标（mm-mobile 是合作方而非付费客户，契约保持兼容）。
- **A2 信号范围**：③ 策略中心 13 档买入触发（核心新增）+ 结算事件；② 已有 feed 维持现状；
  ① 原始大额不进对外系统（69% notional < $25k 是噪音基线，`lib/signalFeed.ts:6`）。
- **A3 通道优先级**：TG（已有工业级底座）→ 拉取 API（已有雏形）→ webhook → 邮件/RSS 不做。
- **A4 首版只有 entry + settle 两类事件**：`exitRule` 目前是死字段（全部 settlement），
  没有中途卖出信号可发。
- **A5 实施仓库**：TS 主仓（生产在跑、982 测试）；Rust 重写仓（mm-whalewatch）是消费方不是宿主。

---

## 3. 方案对比

### 方案 A：最小寄生式（1 周量级）

策略开仓直接写 `alerts` 表（新 type='strategy'），复用现有推送循环发到私有频道；
`/api/signals` 加一段；token 用逗号分隔的 env 变量管理。

- ✅ 最快见效，几乎零新架构
- ❌ 无投递记录（谁收到过什么不可查）、延迟分层要在推送循环里硬塞、env 管 token
  不可吊销单个订户、`alerts` 表语义被污染（它是"告警产生"账本，不是"对外发布"账本）
- ❌ 关键缺陷：跳过了 2026-07-08 信号台账设计已经识别的要害 ——
  信号仍不是持久化一等公民，skipped/missed 不可审计

### 方案 B：信号台账 + 投递总线（推荐）

落地 2026-07-08 信号台账设计的泛化版：新增 `strategy_signals` 事实表（检测/执行解耦、
状态机、结算回填）作为唯一信号源，新增第七个循环 `deliveryLoop` 做多通道扇出
（TG 付费实时 / TG 公开延迟 / webhook / API 分层视图），投递状态独立成表
（claim-then-send 同款幂等）。订阅管理用轻量 `api_keys` 表 + 管理接口，不建用户体系。

- ✅ 与既有蓝图（信号台账 S2）一石二鸟；信号可审计、可回放、可存证
- ✅ 通道与信号解耦：加 Discord/邮件 = 加一个 delivery adapter，信号侧零改动
  （与 detector 注册表同一哲学：新增信号源 = 写纯函数 + 注册一行）
- ✅ 全部在单进程约束内，零新容器
- ⚠️ 工程量中等（2.5-3.5 周人日口径），但可按批次独立上线

### 方案 C：独立网关服务 / 完整 SaaS

独立 repo + 容器、用户注册登录、Stripe 计费、多租户 dashboard、SLA。

- ❌ 与 C1（信息层天花板极低）正面冲突；运营负担（客服/退款/合规）远超个人项目承受
- ❌ 工程量 2-3 个月起，且 SQLite/单机架构要推倒
- 仅当付费订户 > 50 或决定进军执行层（Builders Program 返佣）时才值得重估

**推荐：方案 B。** 理由：它是唯一同时满足「补齐 13 档出口」「落地已有台账蓝图」
「守住单进程约束」「按批次可独立验证」四项的路线；方案 A 省下的 1-2 周
会在第一次「要吊销某个订户」「要审计漏发」时加倍还回去。

---

## 4. 推荐方案完整设计

### 4.0 总体架构

```
                    ┌─ ① alertEngine（4s，现状不动）──────────→ TG 告警频道（现有）
polymarket APIs ──→ ┤
                    └─ ② consensusLoop（5min）
                         ├─ runConsensusCycle（现状不动）─────→ TG 告警频道 + /api/signals
                         └─ runFollowCycle（改动点 1）
                              └─ 开仓成功 ──→ strategy_signals 表（新·事实台账）
                                                    │
              ┌─────────────────────────────────────┤
              │  ⑦ deliveryLoop（新·第七个循环，30s）│
              │  扫未投递 → claim（signal_deliveries UNIQUE）→ 扇出
              └──┬──────────────┬──────────────┬────┘
                 ▼              ▼              ▼
        TG 付费频道(实时)  TG 公开频道(延迟30min)  webhook(HMAC签名+重试)
                                                    │
        GET /api/signals v2 ←── api_keys 表（新·分层：realtime / delayed）
        （strategies 段 + free tier 延迟视图）
```

设计原则（与仓库既有纪律对齐）：

1. **信号与投递解耦**：`strategy_signals` 只记事实（不可变事件），`deliveryLoop`
   只做消费（幂等、可重试、可补发）。检测器永不知道通道存在。
2. **fail-closed**：未配置频道/token → 该通道静默关闭；`healthy:false`（引擎循环停跳）
   → 投递循环暂停发新信号（宁可安静，不可误导 —— 扩展 `docs/signals-api.md` 既有铁律）。
3. **战绩口径唯一实现**：所有通道的战绩行都走 `gradeRows`/`formatRecordLine`
   （`lib/signalRecord.ts`），implied 必印、excess 不脱离 ±2σ、禁单日胜率。
4. **归因红线延续**：对外发布的 `entryPrice/exec_*` 是纸面口径，消息里明示
   「模拟信号 · 真实数据」，与策略中心页面口径一字不差。

### 4.1 信号事件契约 `SignalEvent v1`（对外 schema，zod 定义）

```jsonc
{
  "v": 1,
  "id": 1234, // strategy_signals.id，稳定引用
  "event": "entry", // "entry" | "settle"
  "emittedAt": 1789300000, // 发布时刻（先发布后结算的存证锚点）
  "strategy": {
    "id": 6,
    "name": "巨鲸",
    "source": "heavy", // 13 档之一 + 六源之一
  },
  "market": {
    "conditionId": "0x…",
    "title": "…",
    "slug": "…",
    "eventSlug": "…",
    "category": "Sports",
    "subcategory": "NBA", // event_category 表补齐，可 null
    "outcome": "Yes",
    "outcomeIndex": 0,
    "asset": "7201325…", // CLOB token id —— 仅实时层下发（见 4.4 分层）
  },
  "signal": {
    "formationTs": 1789299400, // 信号成立时刻（detector 语义，非发布时刻）
    "referencePrice": 0.61, // 聪明钱成本基准
    "walletCount": 3,
    "totalNetUsd": 169830,
  },
  "paper": {
    // 纸面执行归因（诚实披露检测+执行成本）
    "entryPrice": 0.63,
    "sizeUsd": 500,
    "chaseCents": 2.0, // entry − reference，追价成本
    "latencySec": 47, // emittedAt − formationTs
  },
  "record": {
    // 该档 30d 价格调整战绩（gradeRows 同源）
    "settled": 41,
    "wins": 26,
    "implied": 22.9,
    "excess": 3.1,
    "sd": 3.4,
  },
  "notice": "研究用途模拟信号，非投资建议", // 每条必带
}
```

- `settle` 事件复用同 id：`{event:"settle", won, exitPrice, realizedPnl}` —— 认账闭环。
- schema 版本 `v` 从第一天就有：mm-mobile 的教训（`record30d` 口径修订不可比）说明
  契约演进必须显式。

### 4.2 数据库新表（4 张，全部 `CREATE TABLE IF NOT EXISTS`，进现有备份）

```sql
-- ① 事实台账：策略触发买入的不可变事件（2026-07-08 台账设计的泛化落地）
CREATE TABLE IF NOT EXISTS strategy_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  position_id INTEGER,             -- follow_positions.id，因果链
  condition_id TEXT NOT NULL, outcome TEXT NOT NULL,
  outcome_index INTEGER, asset TEXT, title TEXT, slug TEXT, event_slug TEXT,
  formation_ts INTEGER NOT NULL, reference_price REAL,
  wallet_count INTEGER, total_net_usd REAL,
  entry_price REAL, size_usd REAL,
  emitted_at INTEGER NOT NULL,     -- 发布时刻（存证锚点）
  -- 结算回填（settle 事件的数据源）
  settled INTEGER DEFAULT 0, exit_price REAL, won INTEGER, realized_pnl REAL,
  UNIQUE(strategy_id, condition_id, outcome)   -- 与 follow_positions 同粒度
);

-- ② 投递账本：谁、什么通道、什么时候、成功否（claim-then-send 同款幂等）
CREATE TABLE IF NOT EXISTS signal_deliveries (
  signal_id INTEGER NOT NULL,
  event TEXT NOT NULL,             -- 'entry' | 'settle'
  channel TEXT NOT NULL,           -- 'tg_paid' | 'tg_public' | 'webhook:<endpoint_id>'
  delivered_at INTEGER,
  status TEXT NOT NULL,            -- 'sent' | 'failed_permanent'
  PRIMARY KEY (signal_id, event, channel)
);

-- ③ 订阅密钥：多租户只读令牌（替代单一 SIGNAL_FEED_TOKEN，后者保留兼容）
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,   -- sha256，明文只在签发时展示一次
  label TEXT NOT NULL,             -- 'mm-mobile' / '订户备注'
  tier TEXT NOT NULL DEFAULT 'delayed',  -- 'realtime' | 'delayed'
  created_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER
);

-- ④ webhook 端点（批次 3）
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  url TEXT NOT NULL, secret TEXT NOT NULL,      -- HMAC-SHA256 签名密钥
  active INTEGER DEFAULT 1, consecutive_failures INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

另：`follow_strategies` 加一列 `push_enabled INTEGER DEFAULT 0`（ALTER + try/catch
吞 duplicate column，仓库既有迁移模式）—— **默认不推**，逐档按战绩放开（见 4.6 噪音控制）。

### 4.3 数据流与改动点

**改动点 1 · 信号产生（`lib/follow.ts`，~20 行）**：开仓 INSERT 成功
（`:771-793`，`res.changes === 1`）后，同一连接顺手写 `strategy_signals`
（INSERT OR IGNORE，UNIQUE 兜底幂等）。不加 `emit` 依赖注入 —— 写表本身就是出口，
消费端解耦由 deliveryLoop 承担。结算处（`:798-825` `UPDATE status='settled'`）
同步回填台账 `settled/exit_price/won/realized_pnl`。

**改动点 2 · 投递循环（`worker/embeddedEngine.ts`，第七个循环，~40 行）**：

```
每 30s：runDeliveryCycle(db, { send, fetchFn, nowSec })
  1. healthy 检查：evaluateHealth 有 stale 循环 → 本轮跳过（宁静默不误导）
  2. entry 扫描：strategy_signals JOIN follow_strategies WHERE push_enabled=1
     LEFT JOIN signal_deliveries 找缺口
  3. 每通道 claim：INSERT OR IGNORE INTO signal_deliveries → changes=1 才发
     - tg_paid：立即发（formatStrategySignalTg + 战绩行 + 免责）
     - tg_public：emitted_at <= now − SIGNAL_PUBLIC_DELAY_MIN×60 才发
     - webhook：POST SignalEvent JSON + X-Signature（批次 3）
  4. transient 失败 → DELETE claim 回滚（下轮重试）；permanent → 保留 claim
     标 failed_permanent（毒消息不卡队头 —— 照抄 alertEngine:385-401 语义）
  5. settle 扫描：settled=1 且 settle 事件无投递记录 → 同上扇出（认账推送）
  6. beat(db, 'delivery')；每轮推送上限 + 超额折叠为汇总条（照抄 MAX_PUSHES_PER_CYCLE 模式）
```

**改动点 3 · API v2（`app/api/signals/route.ts`）**：鉴权升级为
env token（兼容 mm-mobile）∪ `api_keys` 查表（`tokenMatches` 常量时间比较不变）；
响应新增 `strategies` 段（active = 未结算台账行，settled = 近 3 天，
recordByStrategy = 各档 gradeRows）；`tier='delayed'` 的 key 只看到
`emitted_at <= now − delay` 的行。现有字段**只增不改**，mm-mobile 零感知。

### 4.4 通道矩阵与分层

| 通道              | 时效         | 内容                               | 受众/商业角色                        | 批次 |
| ----------------- | ------------ | ---------------------------------- | ------------------------------------ | ---- |
| TG 付费私有频道   | 实时（<60s） | 全字段 + asset + 深链              | 付费订户；Whop 类工具管成员资格      | 1    |
| TG 公开频道       | 延迟 30min   | 全字段（可验证性优先）+「实时版→」 | 免费；公开可验证记录 = 护城河 + 引流 | 1    |
| `/api/signals` v2 | 按 key tier  | JSON 结构化                        | mm-mobile（兼容）+ 付费 API 订户     | 2    |
| webhook           | 实时         | SignalEvent + HMAC 签名            | 高级订户（自动化接收）               | 3    |

分层唯一杠杆是**延迟**（约束 C2）：免费版不阉割字段（公开记录必须完整才可验证，
这是对着 PolyPick 假社会证明的反面做），只晚 30 分钟 ——
信号价值半衰期短于转发传播时间，延迟本身就是付费墙，不做 DRM（YAGNI）。

### 4.5 订阅与授权（刻意轻量）

- 签发/吊销：`app/api/admin/keys`（`x-admin-token` 鉴权 + `guardExpensive`），
  或 `scripts/issue-key.ts` CLI。明文 key 只在签发响应里出现一次，库里只存 sha256。
- 付费流程首版**手工**：用户付款（USDC/Whop）→ 手工签发 key / 拉进 TG 频道。
  Whop 自动开通（webhook → 自动签发）列批次 4，等订户数证明需要再做。
- 不做：用户注册、密码、邮箱验证、自助面板 —— 约束 C1 的直接推论。

### 4.6 噪音控制（信号系统成败的产品关键）

- `push_enabled` 默认全关。批次 0 上线后**先静默跑 ≥1 周**，用台账实测各档
  followed/日 与 30d 战绩，只放开 3-5 个样本充分且 excess>0 的档位。
- 13 档同市场共振（一个市场同时命中共识+巨鲸+精英是常态，§9.1 已知重叠）：
  同轮同 `(conditionId, outcome)` 多档触发 → **合并为一条消息**列出命中档位
  （「巨鲸 + 精英共识 双档触发」），信息量更高且省限速额度。
- 每轮推送上限 + 汇总折叠，沿用 alertEngine 成熟模式。

### 4.7 可信度产品化（批次 3，护城河的正面工程）

1. **公开战绩页 `/record`**：每档已推送信号的 30d 校准（implied/excess/±2σ）、
   结算明细、equity curve —— 大量复用 `/follow` 现有组件，加口径三声明
   （纸面口径 / 已结算口径 / 各档独立不可相加）。
2. **每日存证 digest**：每 UTC 日把昨日全部对外信号的
   `sha256(id|strategy|market|outcome|emitted_at|entry_price)` 链式摘要
   发到公开 TG 频道 —— 频道消息带 TG 官方时间戳且不可编辑历史，
   等于零成本的第三方 timestamping：任何人可事后验证「信号是事前发布的，
   没有删帖也没有改单」。这是全赛道没人做的信任工程，成本 ~80 行代码。

### 4.8 安全与合规红线

- 每条消息/每个 payload 必带「研究用途模拟信号 · 非投资建议 · 只读非托管」。
- 不接下单、不碰私钥资金；`asset`（token id）只是数据引用，执行永远是用户自己的事。
- webhook 只 POST 到订户自己登记的 URL；签名防伪造；不在 URL 放任何敏感参数。
- 引擎不健康时冻结投递（4.3 步骤 1）；投递滞后进每日 🩺 自检报文。
- key 泄漏处置：单 key 吊销（`revoked_at`），不影响他人 —— 这正是放弃
  env 单 token 的原因。

### 4.9 错误处理汇总

| 故障                    | 行为                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| TG transient（429/5xx） | 退避重试（telegram.ts 现成）；仍失败 → 回滚 claim 下轮再试             |
| TG permanent（4xx）     | 纯文本降级重发一次 → 仍败标 failed_permanent，不卡队头                 |
| webhook 超时/5xx        | 5s 超时，指数退避 ≤3 次；连续 10 次失败自动 `active=0` + TG 通知 admin |
| 引擎循环停跳            | deliveryLoop 整体跳过本轮（不发旧数据）                                |
| DB 忙/锁                | 同进程串行循环，结构性不发生；写全部走短事务                           |
| 台账/投递表膨胀         | 信号长期保留（回测资产，台账设计既有裁决）；deliveries 可 90 天修剪    |

### 4.10 测试计划（TDD，现有 982 测试基线）

| 模块                  | 测试要点                                                                               | 估数    |
| --------------------- | -------------------------------------------------------------------------------------- | ------- |
| strategy_signals 台账 | 写入幂等（UNIQUE）/开仓成功才写/结算回填联动/旧仓无 signal 兼容                        | ~14     |
| SignalEvent 契约      | zod schema 全字段/settle 变体/免责必带/序列化稳定                                      | ~8      |
| runDeliveryCycle      | claim 幂等/transient 回滚/permanent 保留/延迟闸门/健康冻结/同市场多档合并/每轮上限折叠 | ~24     |
| TG 格式化             | 战绩行铁律（implied 必印、±2σ 措辞）/免责/HTML 转义                                    | ~8      |
| api_keys              | 签发只回明文一次/hash 校验/吊销即失效/tier 分层视图/last_used                          | ~12     |
| /api/signals v2       | 向后兼容（现有字段逐字节不变）/strategies 段/delayed 视图                              | ~10     |
| webhook               | HMAC 签名可验证/超时退避/连续失败熔断+通知/URL 校验                                    | ~12     |
| 存证 digest           | 链式 hash 确定性/跨日边界/空日行为                                                     | ~6      |
| 合计                  |                                                                                        | **~94** |

---

## 5. 工程量与工作量分析

### 5.1 分批清单（每批独立上线、独立可验证）

**批次 0 · 台账地基（把「触发买入」变成持久化事实）**

| 改动                                                 | 规模           |
| ---------------------------------------------------- | -------------- |
| `lib/db.ts`：strategy_signals 表 + push_enabled 列   | ~40 行         |
| `lib/strategySignals.ts`（新）：记录/回填/查询纯逻辑 | ~180 行        |
| `lib/follow.ts`：开仓/结算两处接线                   | ~25 行         |
| 测试                                                 | ~20 个         |
| **小计**                                             | **1.5-2 人日** |

产出：静默积累信号事实 ≥1 周 → 实测各档信号量与战绩 → 决定放开哪几档。
**这一批不对外发任何东西，零风险。**

**批次 1 · TG 双频道（MVP 对外闭环）**

| 改动                                                                      | 规模           |
| ------------------------------------------------------------------------- | -------------- |
| `lib/signalPush.ts`（新）：消息格式化（复用 tgFormat/formatRecordLine）   | ~150 行        |
| `lib/signalDelivery.ts`（新）：runDeliveryCycle 全逻辑                    | ~220 行        |
| `lib/db.ts`：signal_deliveries 表                                         | ~15 行         |
| `worker/embeddedEngine.ts`：第七循环 + 依赖注入                           | ~45 行         |
| `lib/health.ts`/`lib/heartbeat.ts`：注册 delivery 阈值 + 自检统计         | ~15 行         |
| `lib/config.ts`/.env：TELEGRAM_SIGNAL_CHANNEL_ID、SIGNAL_PUBLIC_DELAY_MIN | ~15 行         |
| 测试                                                                      | ~32 个         |
| **小计**                                                                  | **2-2.5 人日** |

产出：付费频道实时推送 + 公开频道延迟版跑通 → **可以开始收钱**（手工拉人进频道）。

**批次 2 · API v2 + 多 key**

| 改动                                                             | 规模           |
| ---------------------------------------------------------------- | -------------- |
| `lib/apiKeys.ts`（新）：签发/校验/吊销                           | ~130 行        |
| `lib/db.ts`：api_keys 表                                         | ~15 行         |
| `app/api/signals/route.ts`：鉴权升级 + strategies 段 + tier 视图 | ~90 行         |
| `lib/signalFeed.ts`：buildStrategyFeed                           | ~120 行        |
| `app/api/admin/keys/route.ts`（新）+ `scripts/issue-key.ts`      | ~120 行        |
| `docs/signals-api.md`：v2 契约文档                               | ~80 行         |
| 测试                                                             | ~22 个         |
| **小计**                                                         | **2-2.5 人日** |

**批次 3 · webhook + 存证 + 公开战绩页**

| 改动                                                         | 规模           |
| ------------------------------------------------------------ | -------------- |
| `lib/webhookDelivery.ts`（新）：签名 POST/退避/熔断          | ~180 行        |
| `lib/db.ts`：webhook_endpoints 表 + admin 路由               | ~110 行        |
| `lib/signalDigest.ts`（新）：每日 hash 链存证                | ~80 行         |
| `app/record/page.tsx`（新）：公开战绩页（复用 /follow 组件） | ~220 行        |
| 测试                                                         | ~20 个         |
| **小计**                                                     | **2.5-3 人日** |

**批次 4 · 可选后续（不在本次承诺内）**：Whop webhook 自动开通、订户按档位筛选、
Discord 通道、exit 中途信号（依赖 exitRule 活化）、执行层返佣（战略项，与 C3 冲突需单独裁决）。

### 5.2 汇总

| 口径                 | 批次 0+1（MVP）                                               | 批次 0-3（完整）                                 |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| 传统人日（全职手写） | 3.5-4.5 人日                                                  | 8.5-10.5 人日                                    |
| 本仓库实际迭代节奏¹  | **2-3 个会话日**                                              | **5-7 个会话日（1-1.5 周）**                     |
| 新增生产代码         | ~700 行                                                       | ~1,800 行                                        |
| 新增测试             | ~52 个                                                        | ~94 个（总 →1,076+）                             |
| 新文件               | 3 个                                                          | 8 个                                             |
| 新表                 | 2 张                                                          | 4 张                                             |
| 新环境变量           | 2 个                                                          | 2 个（其余走 DB）                                |
| 现有代码回归面       | 仅 lib/follow.ts 两处接线（~25 行），六道闸门与开仓逻辑零改动 | 同左 + /api/signals 鉴权函数（向后兼容测试兜底） |

¹ 参照系：12 档策略扩充（detector 注册表 + 6 detector + 种子迁移 + 全套测试）
实际用时 1-2 个会话日；本设计复杂度与之相当，且可复用面更大。

### 5.3 关键风险与对策

| #   | 风险                                      | 概率 | 对策                                                            |
| --- | ----------------------------------------- | ---- | --------------------------------------------------------------- |
| R1  | 13 档信号量不明，可能是噪音洪水           | 高   | 批次 0 静默测量 ≥1 周；push_enabled 默认全关；同市场多档合并    |
| R2  | TG 频道 ~20 条/分限速被共振打爆           | 中   | 每轮上限 + 汇总折叠（alertEngine 成熟模式照抄）                 |
| R3  | 免费延迟版蚕食付费意愿                    | 中   | 30min 延迟 = 信号半衰期外；实测转化后可调 15/60min（决策点 D1） |
| R4  | webhook 慢端点拖死投递循环                | 中   | 5s 超时 + 每端点串行 + 连续失败熔断                             |
| R5  | 付费信号被转发（泄漏）                    | 必然 | 不做 DRM；延迟差定价本身是防线；存证 digest 让「原创出处」可证  |
| R6  | mm-mobile 契约被 v2 改坏                  | 低   | 现有字段只增不改 + 逐字节向后兼容测试                           |
| R7  | 战绩不佳时的诚实成本（excess<0 也要公示） | 中   | 这是特性不是风险：口径铁律 + 存证恰恰是与 PolyPick 们的差异化   |
| R8  | 单人运营负担（客服/收款/拉群）            | 中   | 首版手工流程刻意保持轻量；订户 >20 再上 Whop 自动化             |

### 5.4 留给用户的决策点（按推荐默认即可开工）

| #   | 决策                                                     | 推荐默认                                   | 备选                     |
| --- | -------------------------------------------------------- | ------------------------------------------ | ------------------------ |
| D1  | 免费版延迟时长                                           | 30min                                      | 15min / 60min            |
| D2  | 免费版是否阉割字段                                       | 不阉割（可验证性优先）                     | 隐藏 asset/精确价        |
| D3  | 首批放开哪些档位                                         | 批次 0 数据说话（预计 3-5 档）             | 全放 / 只放巨鲸+精英共识 |
| D4  | 台账是否含 skipped/missed 全状态机（2026-07-08 S2 全量） | 首批只记 followed+settled，S2 全量列批次 4 | 一步到位                 |
| D5  | 定价（非工程决策）                                       | 小额起步（竞品带：$5-39/月）               | —                        |
| D6  | 付费收款方式                                             | 手工（USDC/Whop 皆可）                     | Whop 自动化（批次 4）    |

---

## 6. 实施顺序与验收

```
批次 0（台账）→ 静默运行 ≥1 周（测量）→ 档位放开决策（D3）
   → 批次 1（TG 双频道）→ 试运行 + 首批订户 → 批次 2（API v2）→ 批次 3（webhook+存证+战绩页）
```

每批验收：全测试绿 + typecheck 过 + `npx tsx scripts/dry-run.ts` 冒烟 +
（批次 1 起）测试频道实发一条验样式。部署沿用现有 compose 重建流程，
新表自动进每日 SQLite 快照，零额外运维。
