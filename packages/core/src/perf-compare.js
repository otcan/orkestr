// Window resolution and before/after comparison for the perf summary:
// `--window`, `--since/--until` pick the current range; `--compare` picks a
// baseline (`prev`, a shift such as `1d`, `deploy`, or an ISO end time) and
// the summary reports deltas for latency, server CPU, event-loop lag, loops
// and the top routes.
const MAX_WINDOW_MS = 7 * 86400000;
const UNITS = { m: 60000, h: 3600000, d: 86400000 };
const ROUTE_LIMIT = 10;

export function parseDurationMs(value) {
  const match = /^(\d+)\s*(m|h|d)$/i.exec(String(value || "").trim());
  return match ? Number(match[1]) * UNITS[match[2].toLowerCase()] : null;
}

export function parsePerfWindow(value = "1h") {
  const parsed = parseDurationMs(value);
  return parsed == null ? 3600000 : Math.min(MAX_WINDOW_MS, Math.max(60000, parsed));
}

const parseTime = (value) => {
  const parsed = value ? Date.parse(String(value)) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export function resolvePerfRange({ window = "1h", since, until, now = Date.now() } = {}) {
  const windowMs = parsePerfWindow(window);
  const untilMs = Math.min(now, parseTime(until) ?? now);
  const sinceMs = parseTime(since) ?? untilMs - windowMs;
  return { sinceMs: Math.max(untilMs - MAX_WINDOW_MS, Math.min(sinceMs, untilMs - 60000)), untilMs };
}

// Returns { current, baseline } ranges or { error }.
export function resolveCompareRanges(spec, range, deploy) {
  const value = String(spec || "").trim();
  const length = range.untilMs - range.sinceMs;
  const shifted = (shiftMs) => ({ current: range, baseline: { sinceMs: range.sinceMs - shiftMs, untilMs: range.untilMs - shiftMs } });
  if (/^prev(ious)?$/i.test(value)) return shifted(length);
  const shift = parseDurationMs(value);
  if (shift) return shift <= 90 * 86400000 ? shifted(shift) : { error: "invalid_compare" };
  if (/^deploy$/i.test(value)) {
    const at = parseTime(deploy?.at);
    if (at == null || at >= range.untilMs) return { error: "no_deploy_marker" };
    const current = { sinceMs: Math.max(range.sinceMs, at), untilMs: range.untilMs };
    return { current, baseline: { sinceMs: at - (current.untilMs - current.sinceMs), untilMs: at } };
  }
  const end = parseTime(value);
  if (end != null && end <= range.sinceMs) return { current: range, baseline: { sinceMs: end - length, untilMs: end } };
  return { error: "invalid_compare" };
}

const round = (value) => Math.round(value * 10) / 10;

function delta(current, baseline) {
  const cur = Number.isFinite(current) ? current : null;
  const base = Number.isFinite(baseline) ? baseline : null;
  return {
    current: cur,
    baseline: base,
    delta: cur != null && base != null ? round(cur - base) : null,
    pct: cur != null && base ? round(((cur - base) / base) * 100) : null,
  };
}

export function perfDeltas(current, baseline) {
  const baseRoutes = new Map((baseline.requests.routesByTotalTime || []).map((row) => [row.route, row]));
  const baseLoops = new Map((baseline.health.loops || []).map((row) => [row.loop, row]));
  return {
    requests: delta(current.requests.total, baseline.requests.total),
    errors: delta(current.requests.errors, baseline.requests.errors),
    latencyP95: delta(current.requests.latency?.p95, baseline.requests.latency?.p95),
    latencyP99: delta(current.requests.latency?.p99, baseline.requests.latency?.p99),
    serverCpuPct: delta(current.health.orkestrCpuPct?.avg, baseline.health.orkestrCpuPct?.avg),
    loopLagP99Ms: delta(current.health.loopLagP99Ms?.p95, baseline.health.loopLagP99Ms?.p95),
    routes: current.requests.routesByTotalTime.slice(0, ROUTE_LIMIT).map((row) => ({
      route: row.route,
      count: delta(row.count, baseRoutes.get(row.route)?.count ?? 0),
      p95: delta(row.p95, baseRoutes.get(row.route)?.p95),
      totalMs: delta(row.totalMs, baseRoutes.get(row.route)?.totalMs ?? 0),
    })),
    loops: (current.health.loops || []).map((row) => ({ loop: row.loop, totalMs: delta(row.totalMs, baseLoops.get(row.loop)?.totalMs ?? 0) })),
  };
}
