// /status 公开状态页字典分片 —— 键=中文原文,值=英文译文。
// 循环名与「挂了会怎样」的影响描述也在这里:状态页的读者一半是英文订阅方,
// 让他们看到 "outcome_backfill" 这种内部标识符等于没写。
export const DICT_STATUS: Record<string, string> = {
  系统状态: "System Status",
  "监控引擎各循环的实时心跳。信号 feed 的 healthy 位与本页同源。":
    "Live heartbeats for every engine loop. The signal feed's `healthy` flag comes from this same source.",

  "正在获取状态…": "Fetching status…",
  全部系统正常运行: "All Systems Operational",
  "{n} 个组件异常": "{n} component(s) degraded",
  引擎未在运行: "Engine is not running",
  "无法获取状态（{err}）—— 下方为最后一次成功读取的结果。":
    "Could not fetch status ({err}) — showing the last successful read below.",
  "停跳组件：{list}": "Stalled components: {list}",

  // 三格 KPI(运行时长 / 数据连续性 / 今日断档)
  运行时长: "Uptime",
  "{d} 天": "{d} days",
  本次进程连续运行: "Current process, uninterrupted",
  数据连续性: "Data continuity",
  "{n} / {g} 天": "{n} / {g} days",
  连续性数据未就绪: "Continuity data not loaded yet",
  今日断档: "Interruptions today",
  "0 次": "0 so far",
  已出现断档: "Interrupted",
  "相邻两轮间隔超过 {t} 即记断档":
    "A gap over {t} between consecutive cycles counts as an interruption",
  // 副行只说「还差几天」;起算日退到同一格的 title 里。
  "还差 {n} 天可重推阈值": "{n} more day(s) before thresholds are re-derived",
  "连续覆盖起算日 {d}（UTC）": "Unbroken run started {d} (UTC)",

  循环: "Loop",
  状态: "Status",
  最近心跳: "Last heartbeat",
  今日轮次: "Cycles today",
  今日最长停顿: "Longest stall today",
  "阈值 {n}": "threshold {n}",

  正常: "Operational",
  停跳: "Stalled",
  从未启动: "Never started",
  "加载中…": "Loading…",
  无循环心跳记录: "No loop heartbeats recorded",
  "引擎还没写过心跳 —— 若它刚重启，等一个循环周期再看。":
    "The engine has never written a heartbeat — if it just restarted, check back after one cycle.",
  "表内的 — 是「判不了」不是零：当日无可用计数。":
    'A "—" in this table means "cannot tell", not zero: no counter for that loop today.',

  更新于: "Updated at",
  "每 30 秒自动刷新": "auto-refreshes every 30s",
  // 卡底说明条拆成三段:第二段是本页唯一一处 600 字重。
  "心跳表只留当日计数，跨日历史由上方连续性区重建。":
    "Heartbeats keep same-day counters only; cross-day history is rebuilt in the continuity section above.",
  "每一格都有原始行背书，不做推测式 uptime。":
    "Every cell is backed by raw rows — never inferred uptime.",

  // 数据连续性(30 天起算时钟)
  "30 天起算时钟 · 按 UTC 日历日": "The 30-day clock · UTC calendar days",
  连续性数据尚未就绪: "Continuity data not ready yet",
  天: "days",
  "尚无循环记录 —— 引擎从未在这个库上跑过共识循环；落下第一轮时间戳后这里会出现第一格。":
    "No cycle records yet — the engine has never run its consensus loop against this database; the first cell appears once it writes its first timestamp.",
  "已达标 · 自 {d} 起连续覆盖":
    "Gate reached · covered without interruption since {d}",
  "连续覆盖尚未形成 —— 从下一个完整 UTC 日重新起算":
    "No unbroken run yet — the clock restarts with the next full UTC day",
  "{d} · 覆盖 · {n} 轮": "{d} · covered · {n} cycles",
  "{d} · 断档 · 最长停顿 {t}": "{d} · interrupted · longest stall {t}",
  "{d} · 记录起点日（从中途开始，不计入）":
    "{d} · first recorded day (started mid-day; not counted)",
  "{d} · 早于记录起点": "{d} · before records began",
  "{d} · 今天 · 进行中": "{d} · today · in progress",
  覆盖: "Covered",
  断档: "Interrupted",
  起点日: "First day",
  无记录: "No records",
  今天: "Today",
  "记录始于 {d}；跨午夜的断档两天都不计入。攒满 {n} 个不间断 UTC 日后重推所有策略阈值。":
    "Records begin {d}; a gap crossing midnight disqualifies both days. After {n} uninterrupted UTC days every strategy threshold gets re-derived.",
  嵌入此徽章: "Embed this badge",
  "嵌入卡 60 秒缓存、无脚本、自带署名回链；加 ?theme=dark 得深色版。":
    "The embed is cached for 60s, script-free, and carries an attribution backlink; append ?theme=dark for the dark variant.",

  // 循环名与停跳影响(app/loopMeta.ts)
  大额成交告警: "Large-fill alerts",
  "每 4 秒": "every 4s",
  大额与聪明钱成交不再推送: "Large and smart-money fills stop being pushed",
  "聪明钱共识 + 策略跟单": "Smart-money consensus + strategy entries",
  "每 5 分钟": "every 5min",
  共识信号与策略买入停止产生:
    "Consensus signals and strategy entries stop being produced",
  "结算回填(战绩验证)": "Settlement backfill (record verification)",
  "每 10 分钟": "every 10min",
  "已结算市场的胜负不再回填,战绩会停在旧数字":
    "Resolved markets stop being graded; the track record freezes at stale numbers",
  对外信号投递: "Outbound signal delivery",
  "每 30 秒": "every 30s",
  "频道与 webhook 收不到新信号": "Channels and webhooks receive no new signals",
};
