# 反事实退出分析(深度分析第⑦维度)— 设计

> 2026-08-16。回答「如果带止盈/止损/限时退出会怎样」—— 用已结算仓的不可变价格
> 路径离线模拟,零常驻负载、立即覆盖全部 19 档完整历史。

## 0. 否决记录:活体退出档(同日实现后经评审回滚,提交已 reset)

曾实现「参数化退出 + 6 个对照档」并全绿(设计稿见 git 历史 aa1b453),用户质疑后
复盘确认三处硬伤,整体回滚:

1. **系统压力**:退出评估要求每轮(5min)对每个带参数档位的持仓取现价,无封顶且
   随持仓册线性增长 —— 与仓库自己的预算纪律相悖(markout 同为逐仓取价,刻意封顶
   10/轮防请求风暴),挤占与 4s 告警循环共享的上游预算。
2. **机制根基弱**:二元预测市场的价格即概率,近有效市场里按现价止损在期望值上
   近似中性,只重塑分布并放弃恢复期权;不具备趋势资产上"截断亏损"的统计基础。
3. **观测失效**:价源是 ~10min 蜡烛 + 5min 轮询,in-play 秒级崩盘(Osaka 64¢→13¢
   一类)恰好拦不住 —— 止损在唯一有价值的场景里最失效。

结论:先用反事实回答「退出规则有没有用」,而不是先造活体机制去等答案。唯一在
反事实中若被证实有效、且天然无负载问题的候选是**限时退出**(触发判定纯时间),
届时再单独评估上线。

## 1. 数据获取:一次性路径回填(骑 10min 验证载波,自排空)

- 新函数 `fetchPriceSeries(tokenId, startTs, endTs)`(lib/priceHistory.ts):同一
  prices-history 端点,fidelity=10,返回区间内全部有效点。**价格不可变 ⇒ 每仓
  终生只取一次。**
- 回填循环 `runExitSimBackfill`:挂在 outcome backfill 的 10 分钟载波上(与
  dbBackup 同一搭车模式),**每轮封顶 5 仓**(= 5 次上游请求/10min,markout 同级
  纪律)。候选 = `status='settled'` ∧ `realized_pnl IS NOT NULL` ∧
  `exit_ts > entry_ts` ∧ 无 path_stats 行,`ORDER BY exit_ts DESC`(新仓优先,
  取不到价的老仓自然沉底)。
- 失败语义:请求抛错 → 本轮跳过留队(下轮重试);**返回空路径 → 写
  `points=0` 的 stats 行永久出队**(过期 token,markout 的死仓截止同款,防止
  永久占坑空烧请求)。
- 负载画像:存量 ~几百已结算仓 ≈ 1-2 天排空;此后稳态 = 每天新结算的几仓,
  **常驻增量 ≈ 0**。

## 2. 模拟与存储:固定规则网格,回填时算完,只存结论

不存原始路径(体积大且可重取),存**每仓 × 每规则的模拟结果** + 路径摘要:

```sql
CREATE TABLE IF NOT EXISTS position_exit_sims (
  position_id INTEGER NOT NULL,
  rule TEXT NOT NULL,          -- 'sl10'|'sl20'|'sl30'|'tp10'|'tp20'|'tp30'|'t24'|'t72'|'t168'
  exited INTEGER NOT NULL,     -- 0 = 规则未触发(持有到结算,pnl=实际值)
  exit_offset_sec INTEGER,     -- 触发时刻 − entry_ts
  exit_price REAL,
  pnl REAL NOT NULL,           -- 该规则下的假想已实现盈亏(shares × (exit−entry))
  PRIMARY KEY (position_id, rule)
);
CREATE TABLE IF NOT EXISTS position_path_stats (
  position_id INTEGER PRIMARY KEY,
  points INTEGER NOT NULL,     -- 路径点数(0 = 不可回填;保真度自证,面板披露)
  mae_cents REAL,              -- 最大不利偏移(min(p)−entry,≤0,¢)
  mfe_cents REAL,              -- 最大有利偏移(max(p)−entry,≥0,¢)
  fetched_at INTEGER NOT NULL
);
```

**模拟语义(lib/exitCounterfactual.ts 纯函数,TDD 全覆盖):**

- 路径 = `[entry_ts, exit_ts]` 内按 t 升序的观测点;
- SL X:首个 `p ≤ entry − X/100` 的点即触发,**按该观测价成交**(保守口径:
  蜡烛间隙里真实止损会成交在线上或更好,用越线观测价不高估退出质量);TP 同理
  反向;限时 H:`entry_ts + H×3600 ≥ exit_ts` 则不触发(先结算),否则在首个
  `t ≥ deadline` 的观测点成交(无此点 = 路径太稀,不触发,points 披露兜底);
- 九规则**互相独立**(不做 SL+TP 组合 —— 组合爆炸且首版回答的是单规则有没有用);
- 未触发 → `pnl = 实际 realized_pnl`(与基准同数,Δ 恒 0)。

对照公平性:实际记录与假想退出**同为纸面口径**(进/出都按观测价免费),
paper-vs-paper 对称可比;对真实跟单的推论仍须叠加退出侧盘口与费用,面板声明。

## 3. 面板:深度分析第⑦块「反事实退出」

服务端聚合(纯函数 `analyzeExitCounterfactual(settledRows, simsById, statsById)`),
随 `FollowStrategyView` 下发,DeepAnalysis 渲染:

- **覆盖率头行**:已回填 n / settled m(路径点中位数);n<m 时明示"回填中";
- **规则表**:九行 ×(触发率 · 假想合计 · Δ vs 实际 · 触发仓均 Δ)——
  Δ>0 = 该规则本会多赚/少亏;触发仓均 Δ 回答"触发的那些仓里它是救还是害";
- **口径三声明**:①保守成交口径(首个越线观测价);②~10min 蜡烛盲区 ——
  快盘中 SL 触发被系统性低估,读数是下界而非精确值;③纸面对纸面,实盘推论
  需另计退出侧成本。

MAE/MFE 存而暂不展示(未来选阈值用),避免首版面板过载(YAGNI)。

## 4. 测试

模拟纯函数:SL/TP 首越线与保守成交价、限时先于/晚于结算、稀疏路径不触发、
未触发回退实际 pnl、MAE/MFE、九规则完整性;回填:封顶、claim 幂等、空路径
出队、抛错留队;聚合:Δ 口径、覆盖率、零覆盖省略;视图接线与 UI 冒烟。
