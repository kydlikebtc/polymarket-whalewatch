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
  "本页只呈现当前状态：心跳表按循环留存当日计数，没有跨日的历史时间序列，因此不提供 uptime 曲线与事件时间线。":
    "This page shows current state only: heartbeats are stored per loop with same-day counters and no cross-day time series, so no uptime chart or incident timeline is offered.",

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
