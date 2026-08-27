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
  "本次进程已连续运行 {d} 天": "Current process up for {d} days",
  "无法获取状态（{err}）—— 下方为最后一次成功读取的结果。":
    "Could not fetch status ({err}) — showing the last successful read below.",

  组件: "Component",
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

  更新于: "Updated at",
  "每 30 秒自动刷新": "auto-refreshes every 30s",
  "心跳表按循环只留存当日计数；跨日历史由共识循环逐轮落库的实测时间戳重建（上方连续性区）——每一格都有原始行背书，不做推测式 uptime。":
    "Heartbeats keep same-day counters only; cross-day history is rebuilt from the consensus loop's per-cycle measured timestamps (the continuity section above) — every cell is backed by raw rows, never inferred uptime.",

  // 数据连续性(30 天起算时钟)
  "数据连续性 · 30 天起算时钟": "Data continuity · the 30-day clock",
  "攒满 {n} 个不间断 UTC 日后重推所有策略阈值 —— 这是全站 edge 数字的前置闸门。":
    "After {n} uninterrupted UTC days every strategy threshold gets re-derived — the gate in front of every edge figure on this site.",
  天: "days",
  "尚无循环记录 —— 引擎从未在这个库上跑过共识循环。":
    "No cycle records yet — the engine has never run its consensus loop against this database.",
  "已达标 · 自 {d} 起连续覆盖":
    "Gate reached · covered without interruption since {d}",
  "起算日 {d}（UTC）· 距 30 天闸门还差 {n} 天":
    "Clock started {d} (UTC) · {n} day(s) to the 30-day gate",
  "连续覆盖尚未形成 —— 从下一个完整 UTC 日重新起算":
    "No unbroken run yet — the clock restarts with the next full UTC day",
  "今天进行中 · 暂无断档": "Today in progress · no interruption so far",
  "今天进行中 · 已出现断档，今天将不计入":
    "Today in progress · already interrupted; today will not count",
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
  "判定：共识循环每 5 分钟落一轮实测时间戳，相邻两轮间隔超过 {t} 即记断档 —— 与下表判停跳同一把尺；跨午夜的断档两天都不计入；按 UTC 日历日。记录始于 {d}。":
    "Verdict rule: the consensus loop writes one measured timestamp every 5 minutes; any inter-cycle gap over {t} counts as an interruption — the same yardstick the table below uses for stalls. A gap crossing midnight disqualifies both days; days are UTC calendar days. Records begin {d}.",
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
