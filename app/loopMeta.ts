// 引擎循环的展示元数据 —— 公开状态页 /status 与运营页 /manage 共用。
//
// 抽出来的理由很具体:这两处各自维护过一份 LOOP_LABEL,一旦引擎加了循环
// (delivery 就是后加的),漏改的那一处会把新循环显示成裸 key「delivery」,
// 而恰恰是公开状态页最不该出现内部标识符。阈值不在这里 —— 它是引擎事实,
// 归 lib/health.ts 的 LOOP_STALE_AFTER_SEC,这里只管怎么念给人听。

export interface LoopMeta {
  /** 人话名字。 */
  label: string;
  /** 正常节奏,让读者能自己判断「多久没心跳算不对」。 */
  cadence: string;
  /** 这个循环挂了,用户会看不到什么 —— 状态页要答的是这个,不是内部架构。 */
  impact: string;
}

export const LOOP_META: Record<string, LoopMeta> = {
  alert: {
    label: "大额成交告警",
    cadence: "每 4 秒",
    impact: "大额与聪明钱成交不再推送",
  },
  consensus: {
    label: "聪明钱共识 + 策略跟单",
    cadence: "每 5 分钟",
    impact: "共识信号与策略买入停止产生",
  },
  outcome_backfill: {
    label: "结算回填(战绩验证)",
    cadence: "每 10 分钟",
    impact: "已结算市场的胜负不再回填,战绩会停在旧数字",
  },
  delivery: {
    label: "对外信号投递",
    cadence: "每 30 秒",
    impact: "频道与 webhook 收不到新信号",
  },
};

/** 未登记的循环回退成 key 本身 —— 宁可难看,不可漏显示一个真在跑的循环。 */
export function loopMeta(loop: string): LoopMeta {
  return (
    LOOP_META[loop] ?? {
      label: loop,
      cadence: "—",
      impact: "—",
    }
  );
}
