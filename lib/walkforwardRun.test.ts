import { describe, expect, it } from "vitest";
import { createWalkforwardRunner, type WfRunChild } from "./walkforwardRun";

// /manage「▶ 跑重推」按钮背后的子进程运行管理器。spawn 注入(测试用假子进程),
// 真接线在 route 层 —— lib 保持零 node 依赖可直测(walkforward.ts 同一纪律)。

/** 假子进程:测试手动触发 data/exit/error。 */
function fakeChild() {
  const handlers = new Map<string, ((arg?: unknown) => void)[]>();
  const on =
    (bucket: string) => (event: string, cb: (arg?: unknown) => void) => {
      const key = `${bucket}:${event}`;
      handlers.set(key, [...(handlers.get(key) ?? []), cb]);
    };
  const emit = (key: string, arg?: unknown) => {
    for (const cb of handlers.get(key) ?? []) cb(arg);
  };
  const child: WfRunChild = {
    on: on("child") as WfRunChild["on"],
    stdout: {
      on: on("stdout") as (e: "data", cb: (c: unknown) => void) => void,
    },
    stderr: {
      on: on("stderr") as (e: "data", cb: (c: unknown) => void) => void,
    },
  };
  return {
    child,
    out: (s: string) => emit("stdout:data", Buffer.from(s)),
    err: (s: string) => emit("stderr:data", Buffer.from(s)),
    exit: (code: number | null) => emit("child:exit", code),
    fail: (e: Error) => emit("child:error", e),
  };
}

describe("walk-forward 运行管理器", () => {
  it("start 置 running 并记 dbPath;运行中再 start 被拒(单进程互斥锁)", () => {
    const f = fakeChild();
    const paths: string[] = [];
    const r = createWalkforwardRunner(
      (p) => {
        paths.push(p);
        return f.child;
      },
      () => 1_000,
    );
    expect(r.start("/data/prod.sqlite")).toEqual({ ok: true });
    expect(paths).toEqual(["/data/prod.sqlite"]);
    expect(r.state().running).toBe(true);
    expect(r.state().startedAt).toBe(1_000);
    const again = r.start("/data/prod.sqlite");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain("已在跑");
    expect(paths).toHaveLength(1); // 没有第二次 spawn
  });

  it("exit 0 → 完成态 ok,tail 含 stdout;可再次 start", () => {
    const f = fakeChild();
    let now = 1_000;
    const r = createWalkforwardRunner(
      () => f.child,
      () => now,
    );
    r.start("db");
    f.out("报告已写入 id=3\n");
    now = 1_042;
    f.exit(0);
    const s = r.state();
    expect(s.running).toBe(false);
    expect(s.lastRun?.ok).toBe(true);
    expect(s.lastRun?.exitCode).toBe(0);
    expect(s.lastRun?.startedAt).toBe(1_000);
    expect(s.lastRun?.finishedAt).toBe(1_042);
    expect(s.lastRun?.tail).toContain("报告已写入 id=3");
    expect(r.start("db")).toEqual({ ok: true });
  });

  it("非零退出 → 失败态,tail 含 stderr 原话(诊断靠它)", () => {
    const f = fakeChild();
    const r = createWalkforwardRunner(
      () => f.child,
      () => 1,
    );
    r.start("db");
    f.err("SqliteError: no such table\n");
    f.exit(1);
    const s = r.state();
    expect(s.lastRun?.ok).toBe(false);
    expect(s.lastRun?.exitCode).toBe(1);
    expect(s.lastRun?.tail).toContain("no such table");
  });

  it("tail 只留末尾(报告的结论在最后;上限防内存)", () => {
    const f = fakeChild();
    const r = createWalkforwardRunner(
      () => f.child,
      () => 1,
    );
    r.start("db");
    f.out("A".repeat(9_000));
    f.out("END-MARKER");
    f.exit(0);
    const tail = r.state().lastRun?.tail ?? "";
    expect(tail.length).toBeLessThanOrEqual(8_000);
    expect(tail.endsWith("END-MARKER")).toBe(true);
  });

  it("spawn 同步抛错 → start 返回失败原因,不留 running 僵尸", () => {
    const r = createWalkforwardRunner(
      () => {
        throw new Error("ENOENT: npx not found");
      },
      () => 1,
    );
    const res = r.start("db");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("ENOENT");
    expect(r.state().running).toBe(false);
  });

  it("child error 事件(异步 spawn 失败)→ 失败完成态;其后 exit 不重复记账", () => {
    const f = fakeChild();
    const r = createWalkforwardRunner(
      () => f.child,
      () => 1,
    );
    r.start("db");
    f.fail(new Error("spawn tsx ENOENT"));
    const s1 = r.state();
    expect(s1.running).toBe(false);
    expect(s1.lastRun?.ok).toBe(false);
    expect(s1.lastRun?.tail).toContain("ENOENT");
    f.exit(0); // 迟到的 exit 不得把失败翻成成功
    expect(r.state().lastRun?.ok).toBe(false);
  });
});
