import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const deployScript = await fs.readFile(path.join(root, "scripts/deploy-git-release.sh"), "utf8");
const reportFunctions = deployScript.slice(
  deployScript.indexOf("active_thread_count() {"),
  deployScript.indexOf("service_is_active() {"),
);
const guardFunction = deployScript.slice(
  deployScript.indexOf("deploy_guard_active_work() {"),
  deployScript.indexOf("deploy_guard_before_restart() {"),
);

function runGuard(report, { mode = "all", serviceActive = true } = {}) {
  return spawnSync("bash", ["-c", `
set -euo pipefail
${reportFunctions}
${guardFunction}
active_thread_report() { printf '%s' "$fixture_report"; }
service_is_active() { return "$fixture_service_status"; }
print_active_thread_report() { printf '%s\\n' 'fixture active work'; }
fixture_report="$1"
fixture_service_status="$2"
no_interrupt=1
wait_active=0
active_timeout_seconds=1
deploy_guard_active_work "$3"
printf '%s\\n' 'DEPLOY_ALLOWED'
`, "bash", report, serviceActive ? "0" : "1", mode], {
    encoding: "utf8",
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
}

test("active-work CLI through a release symlink reports the real unsafe thread", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-active-cli-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const link = path.join(temporary, "current release");
  await fs.symlink(root, link, "dir");
  const requested = [];
  const server = http.createServer((request, response) => {
    requested.push({ url: request.url, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ threads: [
      { id: "unsafe-fixture", state: "working", runtimeKind: "raw-terminal", activeTurnId: "turn-fixture", runningCount: 1 },
      { id: "safe-fixture", state: "working", runtimeKind: "codex-app-server", codexAppServerTransport: "proxy" },
      { id: "idle-fixture", state: "ready" },
    ] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/threads?scope=all`;
  const physical = path.join(root, "scripts/deploy-active-work-check.mjs");
  const symlinked = path.join(link, "scripts/deploy-active-work-check.mjs");
  for (const entry of [physical, symlinked, path.relative(temporary, symlinked)]) {
    const result = await execFileAsync(process.execPath, [entry, "--url", url], {
      cwd: temporary,
      env: { PATH: "/usr/bin:/bin", HOME: temporary, ORKESTR_HOME: temporary, ORKESTR_API_TOKEN: "fixture-only-token" },
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    assert.equal(result.stderr, "");
    assert.notEqual(result.stdout.trim(), "", `checker must execute for ${entry}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.unavailable, false);
    assert.deepEqual(report.active.map(({ id, restartSafe, activeTurnId }) => ({ id, restartSafe, activeTurnId })), [
      { id: "unsafe-fixture", restartSafe: false, activeTurnId: "turn-fixture" },
      { id: "safe-fixture", restartSafe: true, activeTurnId: "" },
    ]);
    const guarded = runGuard(result.stdout, { mode: "unsafe" });
    assert.equal(guarded.status, 75, guarded.stderr);
    assert.doesNotMatch(guarded.stdout, /DEPLOY_ALLOWED/);
    assert.match(guarded.stderr, /active Orkestr thread work is running/);
  }
  assert.deepEqual(requested, Array(3).fill({ url: "/api/threads?scope=all", authorization: "Bearer fixture-only-token" }));
});

for (const [label, report] of [
  ["empty", ""],
  ["whitespace", " \n "],
  ["non-JSON", "not a report"],
  ["null", "null"],
  ["empty object", "{}"],
  ["missing availability", '{"ok":true,"active":[]}'],
  ["unsuccessful", '{"ok":false,"unavailable":false,"active":[]}'],
  ["wrong active shape", '{"ok":true,"unavailable":false,"active":{}}'],
]) {
  test(`active service deploy guard refuses a ${label} checker report`, () => {
    const guarded = runGuard(report);
    assert.equal(guarded.status, 75, guarded.stderr);
    assert.doesNotMatch(guarded.stdout, /DEPLOY_ALLOWED/);
    assert.match(guarded.stderr, /active thread state is unavailable.*invalid_active_work_report/);
  });
}

test("deploy guard preserves unavailable-service and valid report behavior", () => {
  const unavailable = JSON.stringify({ ok: false, unavailable: true, active: [], error: "fixture_offline" });
  const blocked = runGuard(unavailable);
  assert.equal(blocked.status, 75);
  assert.match(blocked.stderr, /fixture_offline/);
  const inactive = runGuard(unavailable, { serviceActive: false });
  assert.equal(inactive.status, 0, inactive.stderr);
  assert.match(inactive.stdout, /DEPLOY_ALLOWED/);
  const idle = runGuard(JSON.stringify({ ok: true, unavailable: false, active: [] }));
  assert.equal(idle.status, 0, idle.stderr);
  assert.match(idle.stdout, /DEPLOY_ALLOWED/);
  const safe = runGuard(JSON.stringify({ ok: true, unavailable: false, active: [
    { id: "safe-fixture", runtimeKind: "claude-code", restartSafe: true },
  ] }), { mode: "unsafe" });
  assert.equal(safe.status, 0, safe.stderr);
  assert.match(safe.stdout, /DEPLOY_ALLOWED/);
});

async function checkHttpPayload(t, payload) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-active-payload-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await execFileAsync(process.execPath, [path.join(root, "scripts/deploy-active-work-check.mjs"),
    "--url", `http://127.0.0.1:${server.address().port}/api/threads`], {
    env: { PATH: "/usr/bin:/bin", HOME: temporary, ORKESTR_HOME: temporary },
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(requests, 1);
  assert.equal(result.stderr, "");
  return { report: JSON.parse(result.stdout), guarded: runGuard(result.stdout) };
}

for (const [label, payload] of [
  ["empty object", {}],
  ["null", null],
  ["error envelope", { error: "fixture_unavailable" }],
  ["explicit failed threads envelope", { ok: false, threads: [] }],
  ["explicit error threads envelope", { error: "fixture_unavailable", threads: [] }],
  ["explicit failed items envelope", { ok: false, items: [] }],
  ["explicit error despite success flag", { ok: true, error: "fixture_unavailable", items: [] }],
  ["non-array threads", { threads: {} }],
  ["null threads", { threads: null }],
  ["non-array items", { items: {} }],
  ["conflicting envelope", { threads: {}, items: [] }],
  ["null record", [null]],
  ["string record", ["not a thread"]],
  ["array record", [[]]],
  ["missing record identity", [{}]],
  ["invalid record identity", [{ id: 42 }]],
]) {
  test(`HTTP200 ${label} is unavailable and blocks an active-service deploy`, async (t) => {
    const { report, guarded } = await checkHttpPayload(t, payload);
    assert.equal(report.ok, false);
    assert.equal(report.unavailable, true);
    assert.equal(report.error, "invalid_threads_payload");
    assert.deepEqual(report.active, []);
    assert.equal(guarded.status, 75, guarded.stderr);
    assert.doesNotMatch(guarded.stdout, /DEPLOY_ALLOWED/);
    assert.match(guarded.stderr, /active thread state is unavailable.*invalid_threads_payload/);
  });
}

for (const [label, envelope] of [
  ["raw array", (threads) => threads],
  ["threads", (threads) => ({ threads })],
  ["items", (threads) => ({ items: threads })],
  ["success metadata", (threads) => ({ ok: true, error: null, threads })],
]) {
  test(`HTTP200 valid ${label} reports retain empty and unsafe-work behavior`, async (t) => {
    const idle = await checkHttpPayload(t, envelope([]));
    assert.equal(idle.report.ok, true);
    assert.equal(idle.report.unavailable, false);
    assert.deepEqual(idle.report.active, []);
    assert.equal(idle.guarded.status, 0, idle.guarded.stderr);
    assert.match(idle.guarded.stdout, /DEPLOY_ALLOWED/);
    const active = await checkHttpPayload(t, envelope([
      { threadId: "legacy-fixture", state: "working", runtimeKind: "raw-terminal", activeTurnId: "fixture-turn" },
      { id: "managed-fixture", threadId: "provider-fixture", state: "working", runtimeKind: "raw-terminal" },
    ]));
    assert.equal(active.report.ok, true);
    assert.equal(active.report.unavailable, false);
    assert.deepEqual(active.report.active.map(({ id, restartSafe }) => ({ id, restartSafe })), [
      { id: "legacy-fixture", restartSafe: false },
      { id: "managed-fixture", restartSafe: false },
    ]);
    assert.equal(active.guarded.status, 75, active.guarded.stderr);
    assert.doesNotMatch(active.guarded.stdout, /DEPLOY_ALLOWED/);
  });
}
