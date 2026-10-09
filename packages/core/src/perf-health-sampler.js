// Periodic health sample of this box and the Orkestr server process, appended
// to the perf log (perf-log.js). Host: load, CPU, memory, swap, disk and the
// busiest process names (by CPU since the previous sample). Orkestr:
// event-loop delay, CPU, heap/RSS, in-flight requests, sqlite store sizes and
// wall time per background loop since the previous sample.
// Process names only — never command lines, arguments or environment.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { appHome } from "../../storage/src/paths.js";
import { takeBackgroundLoopTotals } from "./perf-loop-timing.js";

const DEFAULT_INTERVAL_MS = 30000;
const TOP_PROCESSES = 8;
const CLOCK_TICKS = 100;

export function perfSampleIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_PERF_SAMPLE_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(parsed) ? Math.max(5000, Math.floor(parsed)) : DEFAULT_INTERVAL_MS;
}

const round = (value, digits = 1) => Math.round(Number(value || 0) * 10 ** digits) / 10 ** digits;
const mb = (bytes) => Math.round(Number(bytes || 0) / 1048576);

export function parseProcStat(text = "") {
  const line = String(text).split("\n").find((entry) => entry.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] || 0) + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + (value || 0), 0);
  return { idle, total };
}

export function parseMeminfo(text = "") {
  const fields = {};
  for (const line of String(text).split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (match) fields[match[1]] = Number(match[2]) * 1024;
  }
  return fields;
}

// /proc/<pid>/stat: "pid (comm) state ... utime(14) stime(15) ... rss(24)".
export function parseProcessStat(text = "") {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(" ");
  return {
    name: text.slice(open + 1, close).slice(0, 32),
    ticks: Number(rest[11] || 0) + Number(rest[12] || 0),
    rssPages: Number(rest[21] || 0),
  };
}

async function readProcesses(procRoot) {
  const entries = await fs.readdir(procRoot).catch(() => []);
  const processes = new Map();
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (pid) => {
    const text = await fs.readFile(path.join(procRoot, pid, "stat"), "utf8").catch(() => "");
    const parsed = parseProcessStat(text);
    if (parsed) processes.set(pid, parsed);
  }));
  return processes;
}

// Aggregates per process name: CPU% over the interval (100 = one core),
// process count and resident memory.
export function topProcessesByName(previous, current, elapsedMs, pageSize = 4096) {
  const byName = new Map();
  for (const [pid, entry] of current) {
    const before = previous?.get(pid);
    const ticks = before && before.name === entry.name ? Math.max(0, entry.ticks - before.ticks) : 0;
    const row = byName.get(entry.name) || { name: entry.name, cpu: 0, count: 0, rssMb: 0 };
    row.cpu += elapsedMs > 0 ? (ticks / CLOCK_TICKS) * (100000 / elapsedMs) : 0;
    row.count += 1;
    row.rssMb += (entry.rssPages * pageSize) / 1048576;
    byName.set(entry.name, row);
  }
  return [...byName.values()]
    .sort((left, right) => right.cpu - left.cpu || right.rssMb - left.rssMb)
    .slice(0, TOP_PROCESSES)
    .map((row) => ({ name: row.name, cpu: round(row.cpu), count: row.count, rssMb: Math.round(row.rssMb) }));
}

async function sqliteSizes(home) {
  const names = await fs.readdir(home).catch(() => []);
  const sizes = {};
  await Promise.all(names.filter((name) => /\.sqlite(-wal)?$/.test(name)).map(async (name) => {
    const stat = await fs.stat(path.join(home, name)).catch(() => null);
    if (stat && stat.size >= 1048576) sizes[name] = mb(stat.size);
  }));
  return sizes;
}

export function createHealthSampler(env = process.env, { writer, inflight = () => 0, procRoot = "/proc", now = () => new Date(), loops = takeBackgroundLoopTotals } = {}) {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let previousCpu = null;
  let previousProcesses = null;
  let previousAt = Date.now();
  let previousUsage = process.cpuUsage();
  let timer = null;

  async function sample() {
    const at = now();
    const elapsedMs = Math.max(1, Date.now() - previousAt);
    previousAt = Date.now();
    const usage = process.cpuUsage(previousUsage);
    previousUsage = process.cpuUsage();
    const cpuStat = parseProcStat(await fs.readFile(path.join(procRoot, "stat"), "utf8").catch(() => ""));
    const memory = parseMeminfo(await fs.readFile(path.join(procRoot, "meminfo"), "utf8").catch(() => ""));
    const processes = await readProcesses(procRoot);
    const home = appHome(env);
    const disk = await fs.statfs(home).catch(() => null);
    const heap = process.memoryUsage();
    const hostCpu = cpuStat && previousCpu && cpuStat.total > previousCpu.total
      ? round(100 * (1 - (cpuStat.idle - previousCpu.idle) / (cpuStat.total - previousCpu.total)))
      : null;
    const entry = {
      ts: at.toISOString(),
      host: {
        cpus: os.cpus().length,
        load1: round(os.loadavg()[0], 2),
        load5: round(os.loadavg()[1], 2),
        cpuPct: hostCpu,
        memTotalMb: mb(memory.MemTotal || os.totalmem()),
        memAvailableMb: mb(memory.MemAvailable ?? os.freemem()),
        swapUsedMb: memory.SwapTotal ? mb(memory.SwapTotal - (memory.SwapFree || 0)) : 0,
        swapTotalMb: mb(memory.SwapTotal || 0),
        diskUsedPct: disk ? round(100 * (1 - disk.bavail / Math.max(1, disk.blocks))) : null,
        diskFreeGb: disk ? round((disk.bavail * disk.bsize) / 1073741824) : null,
        processes: processes.size,
        top: previousProcesses ? topProcessesByName(previousProcesses, processes, elapsedMs) : [],
      },
      orkestr: {
        pid: process.pid,
        uptimeS: Math.round(process.uptime()),
        cpuPct: round(((usage.user + usage.system) / 1000 / elapsedMs) * 100),
        rssMb: mb(heap.rss),
        heapUsedMb: mb(heap.heapUsed),
        externalMb: mb(heap.external),
        loopLagMeanMs: round(loopDelay.mean / 1e6),
        loopLagP99Ms: round(loopDelay.percentile(99) / 1e6),
        loopLagMaxMs: round(loopDelay.max / 1e6),
        inflight: inflight(),
        sqliteMb: await sqliteSizes(home),
        loops: loops(),
      },
    };
    loopDelay.reset();
    previousCpu = cpuStat;
    previousProcesses = processes;
    writer?.append("health", entry);
    return entry;
  }

  function start() {
    if (timer) return;
    void sample().catch(() => {});
    timer = setInterval(() => void sample().catch(() => {}), perfSampleIntervalMs(env));
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    loopDelay.disable();
  }

  return { start, stop, sample };
}
