// Wall-clock time spent in each server background loop (timer loop, runtime
// sync, pane progress, delivery pumps, ...). The health sampler drains the
// totals into every sample so `orkestr doctor perf` can attribute server CPU
// to loops. Wall time includes awaited I/O, so it is an upper bound on the
// CPU a loop used; nested runs (runtime sync inside the timer loop) overlap.
import { performance } from "node:perf_hooks";

let totals = new Map();

function finish(name, started, failed) {
  const row = totals.get(name) || { count: 0, ms: 0, maxMs: 0, failed: 0 };
  const ms = performance.now() - started;
  row.count += 1;
  row.ms += ms;
  row.maxMs = Math.max(row.maxMs, ms);
  if (failed) row.failed += 1;
  totals.set(name, row);
}

export function timeBackgroundRun(name, run) {
  const started = performance.now();
  let result;
  try {
    result = run();
  } catch (error) {
    finish(name, started, true);
    throw error;
  }
  return Promise.resolve(result).then(
    (value) => {
      finish(name, started, false);
      return value;
    },
    (error) => {
      finish(name, started, true);
      throw error;
    },
  );
}

export function timedBackgroundLoop(name, fn) {
  return (...args) => timeBackgroundRun(name, () => fn(...args));
}

// Returns { [loop]: { count, ms, maxMs, failed } } since the previous call.
export function takeBackgroundLoopTotals() {
  const drained = totals;
  totals = new Map();
  const round = (value) => Math.round(value * 10) / 10;
  return Object.fromEntries([...drained].map(([name, row]) => [name, { ...row, ms: round(row.ms), maxMs: round(row.maxMs) }]));
}
