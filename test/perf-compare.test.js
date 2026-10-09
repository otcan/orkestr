import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPerfLogWriter, perfLogFile, prunePerfLogs } from "../packages/core/src/perf-log.js";
import { createHealthSampler } from "../packages/core/src/perf-health-sampler.js";
import { takeBackgroundLoopTotals, timeBackgroundRun, timedBackgroundLoop } from "../packages/core/src/perf-loop-timing.js";
import { latestPerfDeploy, perfDeployMarker } from "../packages/core/src/perf-deploy-marker.js";
import { resolveCompareRanges, resolvePerfRange } from "../packages/core/src/perf-compare.js";
import { perfSummary } from "../packages/core/src/perf-summary.js";
import { formatPerfDoctor } from "../apps/cli/src/doctor-perf-command.js";

async function home(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-perf-cmp-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { ORKESTR_HOME: dir };
}

const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

test("background loop timing counts runs, failures and drains totals", async () => {
  takeBackgroundLoopTotals();
  const sync = timedBackgroundLoop("runtime_sync", async (value) => value * 2);
  assert.equal(await sync(21), 42);
  await timeBackgroundRun("runtime_sync", () => new Promise((resolve) => setTimeout(resolve, 15)));
  await assert.rejects(timeBackgroundRun("timer_loop", async () => { throw new Error("boom"); }));
  assert.throws(() => timeBackgroundRun("timer_loop", () => { throw new Error("sync boom"); }));
  const totals = takeBackgroundLoopTotals();
  assert.equal(totals.runtime_sync.count, 2);
  assert.equal(totals.runtime_sync.failed, 0);
  assert.ok(totals.runtime_sync.ms >= 10 && totals.runtime_sync.maxMs >= 10);
  assert.deepEqual([totals.timer_loop.count, totals.timer_loop.failed], [2, 2]);
  assert.deepEqual(takeBackgroundLoopTotals(), {});
});

test("health samples carry per-loop totals", async (t) => {
  const env = await home(t);
  const sampler = createHealthSampler(env, { loops: () => ({ timer_loop: { count: 3, ms: 120, maxMs: 80, failed: 0 } }) });
  t.after(() => sampler.stop());
  const entry = await sampler.sample();
  assert.deepEqual(entry.orkestr.loops, { timer_loop: { count: 3, ms: 120, maxMs: 80, failed: 0 } });
});

test("deploy marker uses the release manifest and strips unsafe characters", async (t) => {
  const env = await home(t);
  const cwd = env.ORKESTR_HOME;
  await fs.writeFile(path.join(cwd, "release-manifest.json"), JSON.stringify({ releaseId: "rel-2026.10.09 /etc/x?token=y", git: { commit: "0123456789abcdef0123" }, version: "1.2.3" }));
  const at = new Date("2026-10-09T10:00:00Z");
  const marker = await perfDeployMarker({}, { cwd, now: at });
  assert.deepEqual(marker, { ts: at.toISOString(), event: "start", releaseId: "rel-2026.10.09etcxtokeny", commit: "0123456789ab", version: "1.2.3" });
  const fallback = await perfDeployMarker({}, { cwd: path.join(cwd, "missing"), now: at });
  assert.equal(fallback.releaseId, "unknown");
  const writer = createPerfLogWriter(env, { now: () => at });
  writer.append("events", marker);
  await writer.close();
  assert.match(await fs.readFile(perfLogFile("events", at, env), "utf8"), /"event":"start"/);
  await prunePerfLogs(env, new Date("2026-11-30T00:00:00Z"));
  assert.deepEqual(await fs.readdir(path.join(env.ORKESTR_HOME, "observability")), []);
});

test("restarts of the same release do not count as a new deploy", () => {
  const deploy = latestPerfDeploy([
    { ts: "2026-10-08T09:00:00Z", event: "start", releaseId: "r1" },
    { ts: "2026-10-09T09:00:00Z", event: "start", releaseId: "r2" },
    { ts: "2026-10-09T09:30:00Z", event: "start", releaseId: "r2" },
  ]);
  assert.deepEqual(deploy, { releaseId: "r2", commit: null, at: "2026-10-09T09:00:00Z", previousReleaseId: "r1", restarts: 1, lastStartAt: "2026-10-09T09:30:00Z" });
  assert.equal(latestPerfDeploy([]), null);
});

test("perf ranges honour since/until and compare specs", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const range = resolvePerfRange({ window: "1h", now });
  assert.equal(range.untilMs - range.sinceMs, 3600000);
  const explicit = resolvePerfRange({ since: "2026-10-09T08:00:00Z", until: "2026-10-09T09:00:00Z", now });
  assert.deepEqual(explicit, { sinceMs: Date.parse("2026-10-09T08:00:00Z"), untilMs: Date.parse("2026-10-09T09:00:00Z") });
  assert.equal(resolveCompareRanges("prev", range).baseline.untilMs, range.sinceMs);
  assert.equal(resolveCompareRanges("1d", range).baseline.sinceMs, range.sinceMs - 86400000);
  const before = resolveCompareRanges("2026-10-08T12:00:00Z", range);
  assert.equal(before.baseline.untilMs, Date.parse("2026-10-08T12:00:00Z"));
  const deploy = resolveCompareRanges("deploy", range, { at: "2026-10-09T11:40:00Z" });
  assert.equal(deploy.current.sinceMs, Date.parse("2026-10-09T11:40:00Z"));
  assert.equal(deploy.baseline.sinceMs, Date.parse("2026-10-09T11:20:00Z"));
  assert.equal(resolveCompareRanges("deploy", range, null).error, "no_deploy_marker");
  assert.equal(resolveCompareRanges("bogus", range).error, "invalid_compare");
});

test("perf summary shows since-deploy, loop attribution and deltas vs the previous hour", async (t) => {
  const env = await home(t);
  const dir = path.join(env.ORKESTR_HOME, "observability");
  await fs.mkdir(dir, { recursive: true });
  const now = Date.parse("2026-10-09T12:00:00Z");
  const request = (ts, route, ms) => ({ ts, method: "GET", route, status: 200, ms, bytes: 1, auth: "user", inflight: 1 });
  const rows = [];
  for (let index = 0; index < 10; index += 1) {
    rows.push(request("2026-10-09T10:30:00.000Z", "/api/threads", 100), request("2026-10-09T10:30:00.000Z", "/api/rare", 5));
    rows.push(request("2026-10-09T11:30:00.000Z", "/api/threads", 400));
  }
  await fs.writeFile(path.join(dir, "requests-2026-10-09.jsonl"), jsonl(rows));
  const health = (ts, cpuPct, lag, loopMs) => ({ ts, host: { cpus: 2 }, orkestr: { cpuPct, loopLagP99Ms: lag, loops: { timer_loop: { count: 2, ms: loopMs, maxMs: loopMs, failed: 0 }, pane_progress: { count: 1, ms: 10, maxMs: 10, failed: 1 } } } });
  await fs.writeFile(path.join(dir, "health-2026-10-09.jsonl"), jsonl([health("2026-10-09T10:30:00.000Z", 10, 20, 100), health("2026-10-09T11:30:00.000Z", 40, 80, 900)]));
  await fs.writeFile(path.join(dir, "events-2026-10-09.jsonl"), jsonl([{ ts: "2026-10-09T11:00:00.000Z", event: "start", releaseId: "rel-b" }]));
  await fs.writeFile(path.join(dir, "events-2026-10-08.jsonl"), jsonl([{ ts: "2026-10-08T09:00:00.000Z", event: "start", releaseId: "rel-a" }]));

  const summary = await perfSummary(env, { window: "1h", compare: "prev", now });
  assert.equal(summary.deploy.releaseId, "rel-b");
  assert.equal(summary.deploy.previousReleaseId, "rel-a");
  assert.deepEqual(summary.health.loops.map((row) => [row.loop, row.totalMs, row.count, row.failed]), [["timer_loop", 900, 2, 0], ["pane_progress", 10, 1, 1]]);
  assert.equal(summary.health.loops[0].wallPct, 0);
  const { deltas } = summary.compare;
  assert.deepEqual([deltas.latencyP95.baseline, deltas.latencyP95.current, deltas.latencyP95.delta], [100, 400, 300]);
  assert.equal(deltas.serverCpuPct.delta, 30);
  assert.equal(deltas.loopLagP99Ms.delta, 60);
  assert.deepEqual(deltas.routes.map((row) => [row.route, row.p95.pct]), [["GET /api/threads", 300]]);
  assert.equal(deltas.loops.find((row) => row.loop === "timer_loop").totalMs.delta, 800);

  const text = formatPerfDoctor(summary);
  assert.match(text, /since deploy rel-b at 2026-10-09T11:00:00.000Z, 60 min ago/);
  assert.match(text, /background loops \(wall time\): timer_loop 900ms\/2/);
  assert.match(text, /latency p95 100ms → 400ms \(\+300ms, \+300%\)/);

  const sinceDeploy = await perfSummary(env, { window: "6h", compare: "deploy", now });
  assert.equal(sinceDeploy.window.since, "2026-10-09T11:00:00.000Z");
  assert.equal(sinceDeploy.compare.baseline.until, "2026-10-09T11:00:00.000Z");
  const invalid = await perfSummary(env, { compare: "nope", now });
  assert.match(formatPerfDoctor(invalid), /compare nope: invalid_compare/);
});
