import { requestJson } from "./api-client.js";

// `orkestr doctor perf [--window 1h|6h|1d] [--json]`: request latency and
// host/server health from the perf log (docs/observability.md).
export async function doctorPerfCommand(argv, ctx) {
  const index = argv.indexOf("--window");
  const window = index >= 0 ? argv[index + 1] || "1h" : "1h";
  const payload = await requestJson(`/api/system/perf?window=${encodeURIComponent(window)}`, ctx);
  if (argv.includes("--json")) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatPerfDoctor(payload));
  return payload.ok ? 0 : 1;
}

const ms = (value) => (value == null ? "-" : `${Math.round(value)}ms`);
const range = (entry, unit = "") => (entry ? `avg ${entry.avg}${unit} max ${entry.max}${unit}` : "-");

export function formatPerfDoctor(payload = {}) {
  const requests = payload.requests || {};
  const health = payload.health || {};
  const latency = requests.latency || {};
  const latest = health.latest || {};
  const lines = [
    `Perf, last ${payload.window?.minutes || "?"} min: ${requests.total || 0} requests, ${requests.errors || 0} 5xx${requests.dropped ? `, ${requests.dropped} not logged (buffer full)` : ""}`,
    `  latency p50 ${ms(latency.p50)} · p95 ${ms(latency.p95)} · p99 ${ms(latency.p99)} · max ${ms(latency.max)}`,
    `  host (${health.samples || 0} samples, ${latest.host?.cpus || "?"} CPUs): load ${range(health.load1)} · cpu ${range(health.cpuPct, "%")} · mem available min ${health.memAvailableMb?.min ?? "-"}MB · swap max ${health.swapUsedMb?.max ?? "-"}MB · disk ${latest.host?.diskUsedPct ?? "-"}%`,
    `  orkestr: cpu ${range(health.orkestrCpuPct, "%")} · rss max ${health.rssMb?.max ?? "-"}MB · event-loop p99 ${range(health.loopLagP99Ms, "ms")}`,
  ];
  if ((requests.routesByTotalTime || []).length) {
    lines.push("  routes by total time:");
    for (const row of requests.routesByTotalTime.slice(0, 10)) {
      lines.push(`    ${row.route}  ×${row.count}  p50 ${ms(row.p50)} p95 ${ms(row.p95)} max ${ms(row.max)}${row.errors ? `  ${row.errors} 5xx` : ""}`);
    }
  }
  if ((health.topProcesses || []).length) {
    lines.push(`  busiest processes: ${health.topProcesses.slice(0, 5).map((row) => `${row.name} ${row.avgCpu}% (×${row.maxCount})`).join(", ")}`);
  }
  for (const finding of payload.findings || []) lines.push(`  ${finding.severity === "info" ? "·" : "!"} ${finding.detail}`);
  return `${lines.join("\n")}\n`;
}
