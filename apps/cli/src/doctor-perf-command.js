import { requestJson } from "./api-client.js";

// `orkestr doctor perf [--window 1h] [--since <iso>] [--until <iso>]
// [--compare prev|1d|deploy|<iso>] [--json]`: request latency, host/server
// health and background loop time from the perf log (docs/observability.md).
export async function doctorPerfCommand(argv, ctx) {
  const query = new URLSearchParams();
  for (const name of ["window", "since", "until", "compare"]) {
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1]) query.set(name, argv[index + 1]);
  }
  if (!query.has("window")) query.set("window", "1h");
  const payload = await requestJson(`/api/system/perf?${query}`, ctx);
  if (argv.includes("--json")) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatPerfDoctor(payload));
  return payload.ok ? 0 : 1;
}

const ms = (value) => (value == null ? "-" : `${Math.round(value)}ms`);
const range = (entry, unit = "") => (entry ? `avg ${entry.avg}${unit} max ${entry.max}${unit}` : "-");
const signed = (value, unit = "") => (value == null ? "?" : `${value > 0 ? "+" : ""}${value}${unit}`);
const change = (entry, unit = "") => (entry ? `${entry.baseline ?? "-"}${unit} → ${entry.current ?? "-"}${unit} (${signed(entry.delta, unit)}${entry.pct != null ? `, ${signed(entry.pct, "%")}` : ""})` : "-");

function ago(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return minutes < 120 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
}

function formatCompare(compare) {
  if (compare.error) return [`  compare ${compare.spec}: ${compare.error}`];
  const deltas = compare.deltas || {};
  const lines = [
    `  compare vs ${compare.baseline?.since} .. ${compare.baseline?.until}:`,
    `    requests ${change(deltas.requests)} · 5xx ${change(deltas.errors)}`,
    `    latency p95 ${change(deltas.latencyP95, "ms")} · p99 ${change(deltas.latencyP99, "ms")}`,
    `    server cpu ${change(deltas.serverCpuPct, "%")} · event-loop p99 ${change(deltas.loopLagP99Ms, "ms")}`,
  ];
  for (const row of (deltas.routes || []).slice(0, 5)) lines.push(`    ${row.route}  ×${change(row.count)}  p95 ${change(row.p95, "ms")}`);
  const loops = (deltas.loops || []).filter((row) => row.totalMs?.delta).slice(0, 5);
  if (loops.length) lines.push(`    loops: ${loops.map((row) => `${row.loop} ${signed(row.totalMs.delta, "ms")}`).join(", ")}`);
  return lines;
}

export function formatPerfDoctor(payload = {}) {
  const requests = payload.requests || {};
  const health = payload.health || {};
  const latency = requests.latency || {};
  const latest = health.latest || {};
  const deploy = payload.deploy;
  const lines = [
    `Perf, last ${payload.window?.minutes || "?"} min: ${requests.total || 0} requests, ${requests.errors || 0} 5xx${requests.dropped ? `, ${requests.dropped} not logged (buffer full)` : ""}`,
  ];
  if (deploy) {
    const inWindow = payload.window?.since && Date.parse(deploy.at) > Date.parse(payload.window.since) ? " (inside this window)" : "";
    lines.push(`  since deploy ${deploy.releaseId} at ${deploy.at}, ${ago(deploy.at, Date.parse(payload.window?.until) || Date.now())} ago${deploy.restarts ? `, ${deploy.restarts} restarts` : ""}${inWindow}`);
  }
  lines.push(
    `  latency p50 ${ms(latency.p50)} · p95 ${ms(latency.p95)} · p99 ${ms(latency.p99)} · max ${ms(latency.max)}`,
    `  host (${health.samples || 0} samples, ${latest.host?.cpus || "?"} CPUs): load ${range(health.load1)} · cpu ${range(health.cpuPct, "%")} · mem available min ${health.memAvailableMb?.min ?? "-"}MB · swap max ${health.swapUsedMb?.max ?? "-"}MB · disk ${latest.host?.diskUsedPct ?? "-"}%`,
    `  orkestr: cpu ${range(health.orkestrCpuPct, "%")} · rss max ${health.rssMb?.max ?? "-"}MB · event-loop p99 ${range(health.loopLagP99Ms, "ms")}`,
  );
  if ((health.loops || []).length) {
    lines.push(`  background loops (wall time): ${health.loops.slice(0, 8).map((row) => `${row.loop} ${row.totalMs}ms/${row.count} (${row.wallPct}%${row.failed ? `, ${row.failed} failed` : ""})`).join(", ")}`);
  }
  if ((requests.routesByTotalTime || []).length) {
    lines.push("  routes by total time:");
    for (const row of requests.routesByTotalTime.slice(0, 10)) {
      lines.push(`    ${row.route}  ×${row.count}  p50 ${ms(row.p50)} p95 ${ms(row.p95)} max ${ms(row.max)}${row.errors ? `  ${row.errors} 5xx` : ""}`);
    }
  }
  if ((health.topProcesses || []).length) {
    lines.push(`  busiest processes: ${health.topProcesses.slice(0, 5).map((row) => `${row.name} ${row.avgCpu}% (×${row.maxCount})`).join(", ")}`);
  }
  if (payload.compare) lines.push(...formatCompare(payload.compare));
  for (const finding of payload.findings || []) lines.push(`  ${finding.severity === "info" ? "·" : "!"} ${finding.detail}`);
  return `${lines.join("\n")}\n`;
}
