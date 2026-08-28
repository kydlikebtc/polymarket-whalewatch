# 聪明钱自测 —— 访客钱包判决书（第三轮脑暴 #9）

> 日期：2026-08-28
> 来源：[第三轮脑暴](2026-08-28-iteration-brainstorm-round3.md) §C #9，成本评估表列为「③ 带预算闸上线」。
> 性质：设计文档（口径裁决 + 成本闸设计 + 被否决方案）。

## 问题陈述

全站现有叙事是「看我们的记分卡」：池子是我们挑的、战绩是我们算的、判决是我们下的。
访客唯一缺的参与方式是**把自己放进同一把尺子下**——粘贴自己的钱包地址，用与池准入
完全相同的口径拿一份判决书：过没过门槛、在池成员里排第几、一张可分享的战绩卡。

这是全清单最便宜的出圈钩子，唯一代价是扇出放大：每个**新**地址的战绩查询是
~42 次上游调用（/closed-positions ≤20 页 + /positions ≤20 页 + /traded + user-pnl），
病毒式成功 = 预算失血。所以成本闸是上线前置，不是可选项。

## 判决口径（红线：严格复用，不另立尺子）

**过没过门槛 = `evaluateAdmission(stats)`（lib/admissionGate.ts），一字不改。**
自测不复制阈值逻辑，直接调用同一个函数；展示层只引用它导出的常量
（`ADMIT_MIN_WIN_RATE` 等）来陈述口径。两条路：

- 战绩路：已结算 ≥10 市场、胜率 ≥55%、**且净盈亏为正**（P0.4：高胜率亏钱账本不算数）；
- 效率路：净盈亏为正、ROI ≥5%、已结算 ≥5 市场。

**复发广度那条（30 天 ≥3 个不同市场证据）不适用于自测**——它是发现渠道的候选资格闸
（回答「谁值得被评估」），不是战绩质量闸（回答「战绩够不够格」）。池内钱包续期时也只
考战绩闸（lib/admission.ts「Standing members re-qualify on their track record ALONE」），
自测者与续期成员同权。判决文案要把这一条写明白，防止「我过了自测为什么没进池」的误读
——进池还需要被发现渠道观察到复发证据，自测不是入池申请。

### 判决分层（表现层，权威判定始终是 evaluateAdmission）

```
stats 为 null（上游取数失败）      → no_data   数据不可得
gate = reject_bot                  → bot       高频做市/机器人，胜率口径不适用
gate = admit                       → pass      过门槛
gate = hold ∧ truncated            → unjudged  样本不可判（战绩翻页撞帽，胜率/ROI 均为 null）
gate = hold ∧ settledCount < 5     → unjudged  已结算样本不足（两条路的最低样本线都没到）
gate = hold ∧ netPnl = null        → unjudged  净盈亏不可得（闸门拒绝凭信仰判定，自测同样拒绝）
gate = hold（其余）                → fail      样本够、判得出、没过
```

truncated 纪律沿用 lib/walletStats.ts 头注的完整论证：截断样本是按盈亏降序的赢家切片，
胜率/ROI 显示「—」，判决降级为「样本不可判」，绝不显示错数。`unjudged` 与 `fail`
必须是两个不同的字：「你没过」和「我判不了」混为一谈是本站最不能犯的那类错。

### 池内百分位

样本 = 当前 smart_wallets 全体成员（读本地表，零上游）。三个轴各给一个分位：

- **胜率**：访客 winRate vs 池成员 win_rate（双方都取非 null 者；访客 null 则该轴不出）；
- **净盈亏**：访客 netPnl vs 池成员 realized_pnl 列（物理列名，存的是 netPnl）；
- **评分**：访客按 `computeScore({pnl, vol: 0, winRate, roi, truncated})` 现算——与
  lib/admission.ts 给发现钱包评分的**同一构造**（无榜单 vol，效率轴走 settled roi，
  诚实偏保守）；做市商不给评分（其胜率/ROI 无意义，评分失去可比性）。

分位取 midrank（严格小于者 + 同值一半，除以该轴非 null 样本数）。每个轴各自声明
样本数（池成员该列可为 null），响应携带 poolSize 与计算时间。访客已在池内时如实
标注（分位含自己，属标准口径）。

### 文案红线

判决是「按本站准入口径的战绩体检」——不是资质认证，不是投资建议，也不是入池申请。
页面与分享卡都带口径声明与样本声明，风格对齐 /calibration 的选择偏差声明：
样本 = Polymarket 公开接口可见的已结算持仓（≤~1000 仓，超出即截断降级）；
分位样本 = 本站当前池成员（本站按自家口径挑的，非全体交易者）；口径 = 本站准入闸。

## 成本闸（上线前置）

三层，由外到内：

1. **限流与预算共享**：`guardExpensive(req, "wallet-profile", {perIp: 120, global: 400,
cost: 3})`——与 `/api/wallet/[address]` **同一个桶**。自测触发的就是同一个
   getWalletStats 扇出，单独开桶等于给枚举者一条绕开钱包档案预算的新路
   （该路由头注里防的正是这件事）。
2. **24 小时判决缓存**：路由级 `createBoundedCache`（24h TTL、上限 2000——判决体
   很小，病毒场景地址数多于档案页的 500）。同地址重测直接回缓存判决。底下还有
   getWalletStats 自己的 24h SQLite 缓存（跨进程重启仍在），双保险：即使内存缓存
   被逐出，重算也只花本地 SQLite 读。**降级/失败判决不入缓存**（一次限流不能把
   地址钉在旧数据上 24 小时——与 loadHoldings「do NOT cache the failure」同纪律）。
3. **降级路径**：被限流/上游故障时回**本地缓存判决**而不是报错——getWalletStats 用
   抛错 fetcher + 超长 TTL 实现「只读缓存、绝不回源」（localOnlyDossier 同款），
   池分位本来就是本地读。响应带 degraded 标记与 retryAfterSec，前端倒计时重试。

### 嵌入卡的零上游红线

`/embed/selftest?address=…` 是病毒分发面：贴进论坛/X 的 iframe，每次展示都是一次
请求。**嵌入卡严禁触发上游**（与 SEO 层同一条红线）：只读 wallet_stats 现存行
（不限龄，卡上标「数据截至」日期）+ smart_wallets 池分位。地址从未被测过 → 出
「尚未体检」卡引导去 /selftest，而不是替围观者花 42 次上游调用。正常分享流程里
判决刚出、SQLite 行必然存在，此红线不牺牲任何真实场景。

## 形态与入口

- **落地页 `/selftest`**（新公开页，进 NAV「聪明钱」组与 sitemap）：地址输入 →
  判决卡（判决 + 三轴分位 + 口径表）→ 全档案链接 + 分享区（嵌入 iframe 代码 +
  直链）。`?address=` 直达自动跑（分享链接可复现）。
- **钱包档案页判决块**：/wallet/[address] 加一块**点击加载**的判决卡（时光机
  「fetched only when a user clicks」先例）——档案页每次浏览不为判决多花预算，
  点了才取；取的时候 walletStats 大概率已被档案本身焐热（共享 in-flight 去重 +
  SQLite 缓存），边际上游成本≈0。
- **分享卡 `/embed/selftest`**：Route Handler 直出自包含 HTML（outlet-trio #2
  先例）：零 JS、内联样式、60s 缓存、noindex、英文文案、带署名回链（回链指
  /selftest，闭合「看到卡 → 自己来测」的循环）。

## 被否决的方案

- **独立结果页 `/selftest/[address]`**：与 /wallet/[address] 职责重叠（那里已是
  地址的 SEO 落地页），多一条公开动态路由多一个爬虫面。分享靠 ?address= 直达 +
  嵌入卡即可。
- **嵌入卡带实时取数（走 guard）**：iframe 展示次数不受控，guard 只能把失血限速
  而不能归零；「围观者看到的卡」与「本人刚测的判决」允许存在缓存时差，换零上游。
- **自测单独开限流桶**：见成本闸 §1——同扇出必须同预算，否则桶形同虚设。
- **判决块在档案页自动加载**：每次档案浏览多一次 cost 3 计费（全局桶消耗翻倍），
  对绝大多数只看档案的访客是纯浪费。
- **percentile 用插值/正态拟合**：池只有几百个成员，midrank 已是诚实上限，拟合是
  假精度。

## 实施拆解（TDD，每任务一提交）

1. 本设计文档 + docs/README.md 索引与四处计数同步（docsPlansIndexParity 守卫）。
2. `lib/selfTest.ts` 纯函数层 + 同名测试：判决分层（pass 两条路 / bot / unjudged
   三因 / fail / no_data）、midrank 分位（含同值、null 轴、空池）、readPool /
   本地缓存读（openDb(":memory:") + 注入 fakes）。
3. `/api/selftest/[address]` 路由：地址校验 → 判决缓存 → guard（共享桶）→ 取数
   → 判决 → 缓存；限流/故障走本地降级判决。日志按调试者视角记 HIT/MISS/降级。
4. `/embed/selftest`：lib/embedCards.ts 加 `renderSelfTestEmbed`（纯渲染 + 测试），
   路由零上游取数 + boundedCache（60s，键含地址故不用无界 promiseCache）。
5. `/selftest` 落地页 + 档案页点击加载判决块 + 共享判决卡组件 + NAV/sitemap +
   i18n 分片 `dict/selftest.ts`（coverage/dict 双闸，新键先 grep 防跨分片撞车）。
6. CHANGELOG 批次条目（Batches 区最上方 + Scope 行刷新）+ README 双语 roadmap。

不动的东西：docs/api-access.md（/api/selftest 是站内页面接口，非订阅方端点——
先例：/api/wallet 同样不在）；/manage（无新增可配项，限流参数与档案页同为代码
常量）；admissionGate / walletStats / smartWallets（只调用，零改动）。
