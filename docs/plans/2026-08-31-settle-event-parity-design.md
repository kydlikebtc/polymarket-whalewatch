# 兑现事件对外一等化 —— 拉/推同构的策略动作流(2026-08-31)

## 问题

策略中心「操作历史」把每仓两个动作(买入 entry_ts / 兑现 exit_ts)列为对等
时间线;但对外 API 里「兑现」不是一等动作:

- **推送侧其实早已对称**:投递循环按 `(signal_id, event)` 推 `entry` 与
  `settle` 两种事件(TG `formatStrategySettleTg` / webhook `SignalEventV1`),
  线上 `delivery` 循环心跳健康。主动推送**不缺**。
- **拉取侧不对称**:`/api/signals` 的 `strategies` 段是两个状态视图 ——
  `active[]` 只含未结算买入(结算后行**消失**,轮询方视角是「买入被撤走」
  而不是「收到一条兑现」);`settled[]` 是 3 天窗 + 全局 LIMIT 20 的战绩
  认账视图,字段与 `active[]` 不同构(缺 slug/eventSlug/分类/asset/sizeUsd/
  emittedAt/formationTs)。**只轮询不挂 webhook 的订阅方(如 mm-mobile
  信号 tab)拿不到与买入对等的兑现动作。**
- **名录不声明**:`/api/signals/list` 的 strategy 段只列档位(code+source),
  不声明「每档会发 entry/settle 两种事件」—— 订阅方无从得知有 settle。

一句话:量化信号流的铁律是「告诉订阅方我们刚做了什么」,买入做到了,
兑现只在推送通道做到了,拉取通道没有。

## 方案:`strategies.events[]` —— webhook 载荷的拉取镜像

**同一构造器,按构造同构**:`events[]` 逐条就是 `SignalEventV1`
(`lib/webhookDelivery.buildSignalEvent` 直接产出),与 webhook POST body
同形状、同 `(id, event)` 幂等键。订阅方一套解析器吃推送与轮询两个通道,
轮询↔webhook 迁移零改动。

- **窗口**:entry 按 `emitted_at`、settle 按 `settled_ts`,各取近
  `STRATEGY_ACTIVE_WINDOW_HOURS`(48h)。同一信号可出两条(买入事件 +
  兑现事件)—— 这正是操作历史的时间线语义;entry 事件在结算后**不消失**。
- **排序**:按事件自身时刻倒序;同刻 settle 排 entry 前(对齐 /follow
  操作历史「同刻兑现在上」);再按 id 倒序,全序确定。
- **时移**:整段由 nowSec 参数化,delayed tier 自动拿到「N 分钟前的世界」
  (settled_ts > nowSec 的兑现尚未发生,不出现)。
- **口径**:与 active[] 相同 —— `push_enabled = 1` 的档、台账事实、
  不看投递状态(投递是通道行为;拉取镜像照的是台账,不是某条通道的账)。
  webhook 的「entry 没发过就不发 settle」纪律不适用于拉取:新订阅方第一次
  轮询就能看到完整近 48h 动作流,这是拉取通道的天然优势。
- **`record`/分类**:与 webhook 投递时同源(30d 战绩 = `recordByStrategy`
  同一对象;分类同 `event_category` 查询)。
- **无静默截断**:不设 LIMIT,窗口即上限(与 active[] 同纪律),文档写明。

### 名录同步

`StrategyCatalogEntry` 增 `events: ["entry","settle"]`(additive)——
名录承诺什么,feed 与 webhook 就投什么。

### 不做什么

- `active[]`/`settled[]` 原样保留(只增不改;settled[] 的 3d/20 条截断由
  events[] 取代其触发用途,降级为纯展示视图)。
- 推送通道不动(已对称);`bus[]` 不动(strategy 不进 bus 的并存纪律见
  lib/signalBus.ts 头注)。
- 数据模型不动:兑现仍是台账行上的结果回填,不另立事件表 ——「事件化」
  发生在投影层,与 webhook 现状一致,不引入第二真相。

## 前向兼容:动作词汇表是开放集(卖出 exit 展望)

今天两种动作(entry/settle),将来可能三种(加主动卖出 exit —— 活体退出
档在 2026-08-16 exit-counterfactual 设计里否决过一次,反事实模拟与
/consensus 离场 tab 已是铺垫)。本批为那一天预付的与欠下的:

**白送的**:event 加枚举值 + exit 数据块(模式同 settle 块的「非该事件
时为 null」)是 additive;`signal_deliveries` 主键 (signal_id, event,
channel) 的 event 是文本,零迁移;名录 events 做成**每档字段**正是为了
不同档可以有不同动作词汇表(持有到结算的档永远两种,活体退出档三种),
订阅方 diff 名录即感知新动作 ——「新值先进名录,再进通道」。

**不白送的,记在这里**:

1. 数据模型是主战场:strategy_signals 一行 = 一次买入 + 结算回填,卖出
   塞不进同一行 —— 届时加事件明细表,投影/投递改读它。本批刻意把
   「事件化」放在投影层而非表结构,就是为了让那次内部重构对订阅方零感知。
2. 幂等键 (id, event) 撑得住单次全仓卖出(纸面 $500 固定额、全进全出,
   现实形态即一签一卖);只有分批卖出才需要 (id, event, seq),纸面模型
   大概率永远用不上。
3. 消费方的封闭枚举是唯一能把 additive 变 breaking 的东西:订阅方照抄
   z.enum(["entry","settle"]) 严格校验并回 4xx,新动作对他就是永久静默
   丢失(4xx = 毒消息不重发)。所以 §10 把「未知 event 值必须跳过」写成
   契约义务,与既有「未知档位码忽略别抛错」同一纪律 —— 容错前置,
   不赌消费方懂事。

## 测试

- `lib/strategyFeed.test.ts`:events[] 两种事件/窗口/排序/时移/结算后
  entry 仍在/push_enabled=0 排除/逐条过 `SignalEventV1Schema`/`record`
  与 `recordByStrategy` 同源。
- `app/api/signals/route.test.ts`:降级字面量补 `events: []`(形状对等
  测试从成功响应现算,嵌套字段以显式断言钉住)。
- `lib/signalCatalog.test.ts`:strategy 段条目带 `events`。

## 文档

`docs/api-access.md` 三处纪律:顶层字段归类表、§8(interface + events[]
小节,字段表引用 §10 SignalEventV1,不抄第二份)、§16 变更记录。
