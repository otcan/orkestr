export async function createApp(...args) {
  return (await import("../../../dist/server/apps/server/src/server.js")).createApp(...args);
}

export async function startServer(...args) {
  return (await import("../../../dist/server/apps/server/src/server.js")).startServer(...args);
}

export function runtimeMonitorIntervalMs() {
  const parsed = Number(process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS || 5000);
  return Number.isFinite(parsed) ? Math.max(5000, parsed) : 5000;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  const port = Number(process.env.PORT || process.env.ORKESTR_PORT || 19812);
  const host = process.env.ORKESTR_HOST || "127.0.0.1";
  startServer({ port, host, openBrowser: args.has("--open") }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
