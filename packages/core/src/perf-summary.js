// Summarizes the perf log (perf-log.js) for `orkestr doctor perf` and
// GET /api/system/perf: per-route latency percentiles and error counts,
// the slowest requests, host and server health over the window, and plain
// findings that point at the likely cause of slowness.
import fs from "node:fs";
import readline from "node:readline";
import { perfLogFile, perfRetentionDays } from "./perf-log.js";

const MAX_WINDOW_MS = 7 * 86400000;
const ROUTE_LIMIT = 15;
const SLOWEST_LIMIT = 10;

export function parsePerfWindow(value = "1h") {
  const match = /^(\d+)\s*(m|h|d)$/i.exec(String(value || "").trim());
  if (!match) return 3600000;
  const unit = { m: 60000, h: 3600000, d: 86400000 }[match[2].toLowerCase()];
  return Math.min(MAX_WINDOW_MS, Math.max(60000, Number(match[1]) * unit));
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function stats(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    avg: Math.round((sum / sorted.length) * 10) / 10,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

async function* readEntries(kind, sinceMs, untilMs, env) {
  const files = [];
  for (let at = sinceMs - (sinceMs % 86400000); at <= untilMs; at += 86400000) files.push(perfLogFile(kind, new Date(at), env));
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = Date.parse(entry.ts);
      if (ts >= sinceMs && ts <= untilMs) yield entry;
    }
  }
}

async function summarizeRequests(sinceMs, untilMs, env) {
  const routes = new Map();
  const all = [];
  const slowest = [];
  let errors = 0;
  let dropped = 0;
  for await (const entry of readEntries("requests", sinceMs, untilMs, env)) {
    if (entry.dropped) {
      dropped += Number(entry.dropped) || 0;
      continue;
    }
    const key = `${entry.method} ${entry.route}`;
    const row = routes.get(key) || { route: key, count: 0, durations: [], errors: 0, aborted: 0, totalMs: 0 };
    row.count += 1;
    row.durations.push(entry.ms);
    row.totalMs += Number(entry.ms) || 0;
    if (entry.status >= 500) row.errors += 1;
    if (entry.aborted) row.aborted += 1;
    routes.set(key, row);
    all.push(entry.ms);
    if (entry.status >= 500) errors += 1;
    slowest.push({ ts: entry.ts, route: key, status: entry.status, ms: entry.ms, inflight: entry.inflight });
    if (slowest.length > SLOWEST_LIMIT * 4) slowest.sort((left, right) => right.ms - left.ms).splice(SLOWEST_LIMIT);
  }
  const rows = [...routes.values()].map(({ durations, ...row }) => ({ ...row, totalMs: Math.round(row.totalMs), ...stats(durations) }));
  return {
    total: all.length,
    errors,
    dropped,
    latency: stats(all),
    routesByTotalTime: rows.sort((left, right) => right.totalMs - left.totalMs).slice(0, ROUTE_LIMIT),
    slowest: slowest.sort((left, right) => right.ms - left.ms).slice(0, SLOWEST_LIMIT),
  };
}

async function summarizeHealth(sinceMs, untilMs, env) {
  const series = { load1: [], cpuPct: [], memAvailableMb: [], swapUsedMb: [], diskUsedPct: [], loopLagP99Ms: [], loopLagMaxMs: [], orkestrCpuPct: [], rssMb: [], inflight: [] };
  const processCpu = new Map();
  let samples = 0;
  let last = null;
  for await (const entry of readEntries("health", sinceMs, untilMs, env)) {
    samples += 1;
    last = entry;
    const host = entry.host || {};
    const server = entry.orkestr || {};
    for (const key of ["load1", "cpuPct", "memAvailableMb", "swapUsedMb", "diskUsedPct"]) series[key].push(host[key]);
    series.loopLagP99Ms.push(server.loopLagP99Ms);
    series.loopLagMaxMs.push(server.loopLagMaxMs);
    series.orkestrCpuPct.push(server.cpuPct);
    series.rssMb.push(server.rssMb);
    series.inflight.push(server.inflight);
    for (const row of host.top || []) {
      const total = processCpu.get(row.name) || { name: row.name, cpuSum: 0, samples: 0, maxCount: 0, maxRssMb: 0 };
      total.cpuSum += row.cpu || 0;
      total.samples += 1;
      total.maxCount = Math.max(total.maxCount, row.count || 0);
      total.maxRssMb = Math.max(total.maxRssMb, row.rssMb || 0);
      processCpu.set(row.name, total);
    }
  }
  const summary = Object.fromEntries(Object.entries(series).map(([key, values]) => [key, stats(values)]));
  const topProcesses = [...processCpu.values()]
    .map(({ cpuSum, ...row }) => ({ ...row, avgCpu: samples ? Math.round((cpuSum / samples) * 10) / 10 : 0 }))
    .sort((left, right) => right.avgCpu - left.avgCpu)
    .slice(0, 8);
  return { samples, latest: last, ...summary, topProcesses };
}

// Plain-language hints, ordered by severity. Thresholds are deliberately
// coarse; they flag where to look, not a diagnosis.
export function perfFindings({ requests, health }) {
  const findings = [];
  const cpus = health.latest?.host?.cpus || 1;
  const swapTotal = health.latest?.host?.swapTotalMb || 0;
  if ((health.loopLagP99Ms?.p95 || 0) >= 200) {
    findings.push({ severity: "high", code: "event_loop_blocked", detail: `server event loop p99 delay ${health.loopLagP99Ms.p95} ms (p95 of samples); synchronous work in the Orkestr process is delaying every request` });
  }
  if ((health.load1?.avg || 0) > cpus) {
    findings.push({ severity: "high", code: "cpu_saturated", detail: `average load ${health.load1.avg} on ${cpus} CPUs` });
  }
  if (swapTotal && (health.swapUsedMb?.max || 0) > swapTotal * 0.25) {
    findings.push({ severity: "medium", code: "swap_pressure", detail: `up to ${health.swapUsedMb.max} MB swap in use of ${swapTotal} MB` });
  }
  if ((health.diskUsedPct?.max || 0) >= 85) {
    findings.push({ severity: "medium", code: "disk_filling", detail: `disk ${health.diskUsedPct.max}% used` });
  }
  if ((health.orkestrCpuPct?.avg || 0) >= 50) {
    findings.push({ severity: "medium", code: "server_cpu_busy", detail: `Orkestr server averages ${health.orkestrCpuPct.avg}% of one core` });
  }
  for (const row of requests.routesByTotalTime) {
    if (row.count >= 5 && (row.p95 || 0) >= 2000) {
      findings.push({ severity: "medium", code: "slow_route", detail: `${row.route}: p95 ${row.p95} ms over ${row.count} requests` });
    }
    if (row.count >= 5 && row.errors / row.count >= 0.1) {
      findings.push({ severity: "medium", code: "failing_route", detail: `${row.route}: ${row.errors} of ${row.count} requests returned 5xx` });
    }
  }
  const heavy = health.topProcesses?.[0];
  if (heavy && heavy.avgCpu >= 100) {
    findings.push({ severity: "info", code: "busy_process", detail: `${heavy.name} averages ${heavy.avgCpu}% CPU (${heavy.maxCount} processes)` });
  }
  return findings;
}

export async function perfSummary(env = process.env, { window = "1h", now = Date.now() } = {}) {
  const windowMs = parsePerfWindow(window);
  const sinceMs = now - windowMs;
  const [requests, health] = await Promise.all([summarizeRequests(sinceMs, now, env), summarizeHealth(sinceMs, now, env)]);
  return {
    ok: true,
    window: { since: new Date(sinceMs).toISOString(), until: new Date(now).toISOString(), minutes: Math.round(windowMs / 60000) },
    retentionDays: perfRetentionDays(env),
    requests,
    health,
    findings: perfFindings({ requests, health }),
  };
}
