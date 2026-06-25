import "dotenv/config";
import { startAlertEngine } from "./embeddedEngine";

// Standalone worker: runs the SAME conditional, Telegram-optional engine that the
// Next app embeds via instrumentation.ts. This is the no-Next alternative — e.g.
// running the engine on its own box. It is a thin wrapper that starts the engine
// and then keeps the process alive.

// 7x24 resilience: never let a stray rejection or blip kill the worker.
process.on("unhandledRejection", (e) =>
  console.error("[worker] unhandledRejection", e),
);
process.on("uncaughtException", (e) =>
  console.error("[worker] uncaughtException", e),
);

console.log("[worker] starting embedded alert engine");
startAlertEngine();

// startAlertEngine's poll loop schedules itself via setTimeout, which keeps the
// event loop alive; this interval is a belt-and-suspenders keepalive so the
// process never exits even if the loop is ever torn down.
setInterval(() => {}, 1 << 30);
