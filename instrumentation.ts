// Next auto-loads this file once per server process. We start the embedded alert
// engine here so it runs automatically with `npm run dev` / `npm run start` —
// no separate worker terminal needed. Guard against the edge runtime (better-sqlite3
// is a native node module) and only start on the nodejs runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAlertEngine } = await import("./worker/embeddedEngine");
  startAlertEngine();
}
