// 通道级故障熔断。
//
// 为什么必须有:X 掉登录时,每一条帖都会走到「找不到编辑器」。如果按单帖
// 失败处理,一次掉登录会把队列里**每一条依次标死**,而且这些帖再也不会重发。
// 熔断把「这一条有问题」和「整条路有问题」分开:后者停下来、报警、等人处理。
//
// 阈值不是 1 而是 3:偶发的标签页超时、X 的临时 5xx 都会产生一次
// channel_error,为一次抖动就停掉整条通道太脆。持续三次才是真故障。

/** 连续多少次通道故障跳闸。 */
export const CHANNEL_ERROR_THRESHOLD = 3;
/** 跳闸后多久放行一次探活。10 分钟:够运营者看到通知并去重新登录 X。 */
export const PROBE_INTERVAL_MS = 10 * 60_000;

export class CircuitBreaker {
  private consecutive = 0;
  private openedAt: number | null = null;
  private reason: string | null = null;

  /** 本轮能不能消费。跳闸后只在探活窗口放行。 */
  canRun(nowMs: number): boolean {
    if (this.openedAt === null) return true;
    return nowMs - this.openedAt >= PROBE_INTERVAL_MS;
  }

  isOpen(): boolean {
    return this.openedAt !== null;
  }

  lastError(): string | null {
    return this.reason;
  }

  recordChannelError(nowMs: number, reason?: string): void {
    this.consecutive++;
    if (reason) this.reason = reason;
    if (this.consecutive >= CHANNEL_ERROR_THRESHOLD) {
      // 已跳闸时重新计时:否则探活失败后下一轮又会被放行,变成每轮都试,
      // 等于没熔断。
      this.openedAt = nowMs;
    }
  }

  /** 任何一次成功发帖都完全复位。 */
  recordSuccess(): void {
    this.consecutive = 0;
    this.openedAt = null;
    this.reason = null;
  }

  /** 供 popup 展示。 */
  snapshot(): { open: boolean; consecutive: number; reason: string | null } {
    return {
      open: this.isOpen(),
      consecutive: this.consecutive,
      reason: this.reason,
    };
  }
}
