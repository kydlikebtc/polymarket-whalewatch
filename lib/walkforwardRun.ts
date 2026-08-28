// /manage「▶ 跑重推」的子进程运行管理器(2026-08-28,walk-forward 批次增补)。
//
// 为什么是子进程而不是请求内直算:runWalkforward 是纯同步 CPU 活,生产数据
// 量级下要跑几秒到几十秒 —— 塞进 Node 事件循环会把 4s 告警循环、TG 发送、
// 全部 API 一起冻住(心跳漂移监控会当场报警)。spawn 独立进程 = 与运维手工
// `npx tsx scripts/walkforward.ts` 逐字节同一条路径,页面按钮只是省掉 SSH。
//
// spawn 注入:lib 零 node 依赖(child_process 的真接线在 route 层),假子
// 进程可直测。单进程互斥锁是模块级内存态 —— 部署形态是单容器单进程
// (docker compose 一个 app),多副本不成立;dev HMR 重置锁无害(顶多允许
// 一次并行,报告表多一行)。

export interface WfRunChild {
  on(event: "exit" | "error", cb: (arg?: unknown) => void): void;
  stdout: { on(event: "data", cb: (chunk: unknown) => void): void } | null;
  stderr: { on(event: "data", cb: (chunk: unknown) => void): void } | null;
}

export interface WfLastRun {
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  /** 进程退出码;error 事件(如 ENOENT)时为 null。 */
  exitCode: number | null;
  /** stdout+stderr 合流末尾(结论与报错都在最后)。 */
  tail: string;
}

export interface WfRunState {
  running: boolean;
  startedAt: number | null;
  lastRun: WfLastRun | null;
}

/** tail 上限:报告人读版全文 ~10KB,末 8KB 足够含结论段与任何报错。 */
const TAIL_CAP = 8_000;

export function createWalkforwardRunner(
  spawnFn: (dbPath: string) => WfRunChild,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
) {
  let running = false;
  let startedAt: number | null = null;
  let lastRun: WfLastRun | null = null;

  return {
    start(dbPath: string): { ok: true } | { ok: false; reason: string } {
      if (running) {
        return { ok: false, reason: "已在跑 —— 等本次完成(状态会自动刷新)" };
      }
      let child: WfRunChild;
      try {
        child = spawnFn(dbPath);
      } catch (e) {
        return {
          ok: false,
          reason: `无法启动:${e instanceof Error ? e.message : String(e)}`,
        };
      }
      running = true;
      const began = nowFn();
      startedAt = began;
      let tail = "";
      let finished = false;
      const append = (chunk: unknown) => {
        tail = (tail + String(chunk)).slice(-TAIL_CAP);
      };
      const finish = (ok: boolean, exitCode: number | null) => {
        if (finished) return; // error 后迟到的 exit 不得翻案
        finished = true;
        running = false;
        startedAt = null;
        lastRun = { startedAt: began, finishedAt: nowFn(), ok, exitCode, tail };
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("exit", (code) => {
        const c = typeof code === "number" ? code : null;
        finish(c === 0, c);
      });
      child.on("error", (e) => {
        append(`\n${e instanceof Error ? e.message : String(e)}`);
        finish(false, null);
      });
      return { ok: true };
    },
    state(): WfRunState {
      return { running, startedAt, lastRun };
    },
  };
}
