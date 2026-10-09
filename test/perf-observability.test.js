import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPerfLogWriter, createPerfRequestLogMiddleware, perfLogFile, perfRouteTemplate, prunePerfLogs } from "../packages/core/src/perf-log.js";
import { createHealthSampler, parseMeminfo, parseProcessStat, topProcessesByName } from "../packages/core/src/perf-health-sampler.js";
import { parsePerfWindow, perfFindings, perfSummary } from "../packages/core/src/perf-summary.js";
import { formatPerfDoctor } from "../apps/cli/src/doctor-perf-command.js";

async function home(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-perf-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { ORKESTR_HOME: dir };
}

function fakeResponse(statusCode = 200, length = 42) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.writableFinished = true;
  response.getHeader = (name) => (name === "content-length" ? String(length) : undefined);
  return response;
}

async function readLines(file) {
  return (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("perf route templates drop ids, tokens, file names and query strings", () => {
  assert.equal(perfRouteTemplate("/api/threads/abc123/messages?token=secret"), "/api/threads/:threadId/messages");
  assert.equal(perfRouteTemplate("/s/Zr8kq0vU2xPl4mN7bQ1wE9yT3aS6dF5g"), "/s/:id");
  assert.equal(perfRouteTemplate("/files/quarterly-report-2026-final-version-for-board.pdf"), "/files/:id");
  assert.equal(perfRouteTemplate("/api/vault/items/a1b2c3d4e5f6a7b8c9d0"), "/api/vault/items/:id");
  assert.equal(perfRouteTemplate("/api/vault/items"), "/api/vault/items");
});

test("request log middleware records route, status, timing and auth kind only", async (t) => {
  const env = await home(t);
  const at = new Date("2026-10-09T10:00:00Z");
  const writer = createPerfLogWriter(env, { now: () => at });
  const middleware = createPerfRequestLogMiddleware(writer);
  const request = { method: "post", originalUrl: "/api/threads/t1/messages?q=private", headers: { authorization: "Bearer x" }, body: { text: "private" } };
  const response = fakeResponse(201);
  middleware(request, response, () => {});
  request.orkestrPrincipal = { userId: "someone" };
  response.emit("finish");
  response.emit("close");
  await writer.close();
  const [entry] = await readLines(perfLogFile("requests", at, env));
  assert.deepEqual(Object.keys(entry).sort(), ["auth", "bytes", "inflight", "method", "ms", "route", "status", "ts"]);
  assert.equal(entry.route, "/api/threads/:threadId/messages");
  assert.equal(entry.method, "POST");
  assert.equal(entry.status, 201);
  assert.equal(entry.auth, "user");
  const raw = await fs.readFile(perfLogFile("requests", at, env), "utf8");
  for (const secret of ["private", "Bearer", "someone"]) assert.equal(raw.includes(secret), false);
  const mode = (await fs.stat(perfLogFile("requests", at, env))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("aborted requests are recorded with status 0", async (t) => {
  const env = await home(t);
  const at = new Date("2026-10-09T10:00:00Z");
  const writer = createPerfLogWriter(env, { now: () => at });
  const response = fakeResponse(200);
  response.writableFinished = false;
  createPerfRequestLogMiddleware(writer)({ method: "GET", url: "/api/vault/items" }, response, () => {});
  response.emit("close");
  await writer.close();
  const [entry] = await readLines(perfLogFile("requests", at, env));
  assert.equal(entry.status, 0);
  assert.equal(entry.aborted, true);
});

test("old perf log days are pruned after the retention window", async (t) => {
  const env = { ...(await home(t)), ORKESTR_PERF_LOG_RETENTION_DAYS: "3" };
  const dir = path.join(env.ORKESTR_HOME, "observability");
  await fs.mkdir(dir, { recursive: true });
  for (const name of ["requests-2026-10-01.jsonl", "health-2026-10-05.jsonl", "requests-2026-10-08.jsonl", "notes.txt"]) {
    await fs.writeFile(path.join(dir, name), "{}\n");
  }
  await prunePerfLogs(env, new Date("2026-10-09T12:00:00Z"));
  assert.deepEqual((await fs.readdir(dir)).sort(), ["requests-2026-10-08.jsonl", "notes.txt"].sort());
});

test("proc parsers read cpu ticks, rss and memory without command lines", () => {
  const stat = parseProcessStat("1234 (chrome (renderer)) S 1 2 3 4 5 6 7 8 9 10 150 50 0 0 20 0 1 0 100 1000000 2560 0");
  assert.deepEqual(stat, { name: "chrome (renderer)", ticks: 200, rssPages: 2560 });
  const memory = parseMeminfo("MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 2048 kB\nSwapFree: 1024 kB\n");
  assert.equal(memory.MemAvailable, 512 * 1024);
  const previous = new Map([["1", { name: "chrome", ticks: 100, rssPages: 256 }], ["2", { name: "chrome", ticks: 0, rssPages: 256 }]]);
  const current = new Map([["1", { name: "chrome", ticks: 300, rssPages: 256 }], ["2", { name: "chrome", ticks: 100, rssPages: 256 }], ["3", { name: "node", ticks: 50, rssPages: 512 }]]);
  const [top] = topProcessesByName(previous, current, 2000);
  assert.deepEqual(top, { name: "chrome", cpu: 150, count: 2, rssMb: 2 });
});

test("health sampler writes host and server health", async (t) => {
  const env = await home(t);
  const at = new Date("2026-10-09T10:00:00Z");
  const writer = createPerfLogWriter(env, { now: () => at });
  const sampler = createHealthSampler(env, { writer, inflight: () => 3, now: () => at });
  t.after(() => sampler.stop());
  await sampler.sample();
  const entry = await sampler.sample();
  await writer.close();
  assert.equal(entry.orkestr.inflight, 3);
  assert.equal(typeof entry.orkestr.loopLagP99Ms, "number");
  assert.ok(entry.host.cpus >= 1);
  const lines = await readLines(perfLogFile("health", at, env));
  assert.equal(lines.length, 2);
});

test("perf summary reports route percentiles, health and findings", async (t) => {
  const env = await home(t);
  const now = Date.parse("2026-10-09T10:30:00Z");
  const dir = path.join(env.ORKESTR_HOME, "observability");
  await fs.mkdir(dir, { recursive: true });
  const requests = [];
  for (let index = 0; index < 20; index += 1) {
    requests.push({ ts: "2026-10-09T10:10:00.000Z", method: "GET", route: "/api/vault/items", status: index < 3 ? 503 : 200, ms: 2500 + index, bytes: 10, auth: "user", inflight: 1 });
    requests.push({ ts: "2026-10-09T10:10:00.000Z", method: "GET", route: "/api/threads", status: 200, ms: 20, bytes: 10, auth: "user", inflight: 1 });
  }
  requests.push({ ts: "2026-10-09T08:00:00.000Z", method: "GET", route: "/old", status: 200, ms: 99999 });
  await fs.writeFile(path.join(dir, "requests-2026-10-09.jsonl"), `${requests.map((entry) => JSON.stringify(entry)).join("\n")}\nnot json\n`);
  const health = [1, 2].map(() => ({
    ts: "2026-10-09T10:20:00.000Z",
    host: { cpus: 4, load1: 9, cpuPct: 95, memAvailableMb: 1000, swapUsedMb: 9000, swapTotalMb: 16000, diskUsedPct: 80, top: [{ name: "chrome", cpu: 130, count: 160, rssMb: 9000 }] },
    orkestr: { cpuPct: 70, rssMb: 2700, loopLagP99Ms: 450, loopLagMaxMs: 900, inflight: 4 },
  }));
  await fs.writeFile(path.join(dir, "health-2026-10-09.jsonl"), `${health.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const summary = await perfSummary(env, { window: "1h", now });
  assert.equal(summary.requests.total, 40);
  assert.equal(summary.requests.errors, 3);
  assert.equal(summary.requests.routesByTotalTime[0].route, "GET /api/vault/items");
  assert.equal(summary.requests.slowest[0].ms, 2519);
  assert.equal(summary.health.samples, 2);
  const codes = summary.findings.map((finding) => finding.code);
  for (const code of ["event_loop_blocked", "cpu_saturated", "swap_pressure", "server_cpu_busy", "slow_route", "failing_route", "busy_process"]) {
    assert.ok(codes.includes(code), code);
  }
  const text = formatPerfDoctor(summary);
  assert.match(text, /40 requests, 3 5xx/);
  assert.match(text, /GET \/api\/vault\/items/);
  assert.match(text, /event loop/);
});

test("perf window parsing is bounded", () => {
  assert.equal(parsePerfWindow("15m"), 900000);
  assert.equal(parsePerfWindow("30d"), 7 * 86400000);
  assert.equal(parsePerfWindow("bogus"), 3600000);
  assert.deepEqual(perfFindings({ requests: { routesByTotalTime: [] }, health: {} }), []);
});
