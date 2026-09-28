import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { detachedDeployCommand, readDetachedDeploy } from "../apps/cli/src/update-detach.js";
import { runDetachedDeploy } from "../scripts/deploy-detached-runner.mjs";
import { deployOutcome, formatDeployReport, summarizeDeployLog } from "../scripts/deploy-detached-summary.mjs";

function capture() {
  let text = "";
  return { write(chunk) { text += String(chunk); return true; }, text: () => text };
}

function fakeSpawn(spawned, exitCode = 0) {
  return (command, args, options) => {
    spawned.push({ command, args, env: options.env });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", exitCode));
    return child;
  };
}

async function tempDir(t, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ork-detach-${name}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SAMPLE_LOG = `Starting Orkestr versioned release update for abc1234...
Smoke test passed
Deploy drain active: new inputs will queue while orkestr-ui.service restarts.
Deploy drain cleared after orkestr-ui.service passed health checks.
Public exposure check passed: unauthenticated private APIs returned 401/403.
deployed vm-alpha               exit=0
failed   vm-beta                exit=1
skipped  vm-gamma               release_train_disabled
skipped  local-1                local_already_deployed
Post-deploy worker sync: scanned 4, synced 2, pushed 2, skipped 2.
Orkestr deployed main-abc1234def56 (abc1234def5678901234567890abcdef12345678).
Release instance broker failed for one or more remote instances (local release healthy).
`;

test("detached deploy summary reports release, checks, fan-out and outcome", () => {
  const summary = summarizeDeployLog(SAMPLE_LOG);
  assert.equal(summary.releaseId, "main-abc1234def56");
  assert.equal(summary.smokePassed, true);
  assert.equal(summary.healthChecksPassed, true);
  assert.equal(summary.exposure, "passed");
  assert.deepEqual(summary.fanout.map((item) => [item.status, item.instance]), [["deployed", "vm-alpha"], ["failed", "vm-beta"], ["skipped", "vm-gamma"]]);
  assert.match(summary.workerSync, /synced 2/);
  assert.equal(deployOutcome(3, summary), "partial_remote");
  assert.equal(deployOutcome(0, summary), "success");
  assert.equal(deployOutcome(1, summary), "failed");
  assert.equal(deployOutcome(0, summarizeDeployLog("Another Orkestr deploy is already running.\n")), "blocked");
  const report = formatDeployReport({ deployId: "d1", exitCode: 3, outcome: "partial_remote", summary, logPath: "/x/deploy.log" });
  assert.match(report, /some remote instances failed/);
  assert.match(report, /Release: main-abc1234def56 \(abc1234d\)/);
  assert.match(report, /1 deployed, 1 failed \(vm-beta\)/);
});

test("detached deploy runner records the result and reports to the calling thread", async (t) => {
  const dir = await tempDir(t, "runner");
  const deploy = path.join(dir, "fake-deploy.sh");
  await fs.writeFile(deploy, `#!/bin/bash
echo "args: $*"
echo "ignore: $ORKESTR_DEPLOY_IGNORE_THREAD_IDS lockBusyExit: $ORKESTR_DEPLOY_LOCK_BUSY_EXIT_CODE"
cat <<'LOG'
${SAMPLE_LOG}LOG
exit 3
`, { mode: 0o755 });
  const posts = path.join(dir, "posts.jsonl");
  const orkestr = path.join(dir, "fake-orkestr.mjs");
  await fs.writeFile(orkestr, `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(posts)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`, { mode: 0o755 });
  const code = await runDetachedDeploy([
    "--deploy-id", "d-test", "--dir", dir, "--script", deploy, "--thread", "thread-1", "--orkestr-bin", orkestr,
    "--", "install", "--ref", "main",
  ], { ...process.env, ORKESTR_DEPLOY_IGNORE_THREAD_IDS: "other", ORKESTR_DETACHED_DEPLOY_REPORT_ATTEMPTS: "1" });
  assert.equal(code, 3);
  const result = JSON.parse(await fs.readFile(path.join(dir, "result.json"), "utf8"));
  assert.equal(result.outcome, "partial_remote");
  assert.equal(result.summary.releaseId, "main-abc1234def56");
  assert.equal(result.reportPosted, true);
  const log = await fs.readFile(path.join(dir, "deploy.log"), "utf8");
  assert.match(log, /args: install --ref main/);
  assert.match(log, /ignore: other,thread-1 lockBusyExit: 75/);
  const calls = (await fs.readFile(posts, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  const [start, report] = calls.map((args) => ({ text: args[args.indexOf("--text") + 1], phase: args[args.indexOf("--phase") + 1], thread: args[args.indexOf("--thread") + 1] }));
  assert.equal(start.thread, "thread-1");
  assert.equal(start.phase, "commentary");
  assert.match(start.text, /Deploy d-test started/);
  assert.equal(report.phase, "final_answer");
  assert.match(report.text, /some remote instances failed/);
  assert.equal(readDetachedDeploy("d-test", { ORKESTR_DETACHED_DEPLOY_DIR: path.dirname(dir) }).found, false);
});

test("detached deploy command runs the runner in a transient unit via sudo", () => {
  const launch = detachedDeployCommand({
    deployId: "20260928-1", dir: "/var/tmp/orkestr-deploys/20260928-1", script: "/opt/app/scripts/deploy-git-release.sh",
    runner: "/opt/app/scripts/deploy-detached-runner.mjs", deployArgs: ["install", "--ref", "main"], threadId: "t1", owner: "995:995",
    nodePath: "/usr/bin/node", envArgs: ["--setenv=ORKESTR_HOME=/srv/orkestr"],
  });
  assert.equal(launch.command, "sudo");
  assert.deepEqual(launch.args.slice(0, 2), ["-n", "systemd-run"]);
  assert.ok(launch.args.includes("--unit=orkestr-deploy-20260928-1"));
  assert.ok(launch.args.includes("--setenv=ORKESTR_HOME=/srv/orkestr"));
  const runnerAt = launch.args.indexOf("/opt/app/scripts/deploy-detached-runner.mjs");
  assert.equal(launch.args[runnerAt - 1], "/usr/bin/node");
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--") + 1), ["install", "--ref", "main"]);
  assert.ok(launch.args.includes("--thread"));
  assert.equal(detachedDeployCommand({ deployId: "x", dir: "/d", script: "/s", runner: "/r", deployArgs: [], isRoot: true }).command, "systemd-run");
});

test("CLI update --detach refuses to start while another deploy unit is active", async (t) => {
  const dir = await tempDir(t, "busy");
  const spawned = [];
  const stderr = capture();
  const code = await runCli(["update", "--release", "--ref", "main", "--detach", "--no-thread"], {
    env: { ORKESTR_DETACHED_DEPLOY_DIR: dir, ORKESTR_TEST_ACTIVE_DEPLOY_UNITS: "orkestr-deploy-other.service", PATH: "/usr/bin" },
    stdout: capture(),
    stderr,
    spawnImpl: fakeSpawn(spawned),
  });
  assert.equal(code, 75);
  assert.equal(spawned.length, 0);
  assert.match(stderr.text(), /another deploy is running \(orkestr-deploy-other\.service\)/);
});

test("CLI update --detach launches the runner and status reads the recorded result", async (t) => {
  const dir = await tempDir(t, "launch");
  const spawned = [];
  const stdout = capture();
  const env = { ORKESTR_DETACHED_DEPLOY_DIR: dir, ORKESTR_TEST_ACTIVE_DEPLOY_UNITS: "", PATH: "/usr/bin" };
  const code = await runCli(["update", "--release", "--ref", "main", "--allow-untagged", "--wait-active", "--detach", "--thread", "thread-9", "--json"], {
    env, stdout, stderr: capture(), spawnImpl: fakeSpawn(spawned),
  });
  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  const launched = JSON.parse(stdout.text());
  assert.equal(launched.threadId, "thread-9");
  assert.match(launched.unit, /^orkestr-deploy-/);
  const args = spawned[0].args;
  assert.ok(args.some((arg) => /deploy-detached-runner\.mjs$/.test(arg)));
  assert.match(args[args.indexOf("--script") + 1], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["install", "--ref", "main", "--allow-untagged", "--all-instances", "--wait-active"]);

  const deployDir = launched.dir;
  const status = capture();
  assert.equal(await runCli(["update", "status", "--deploy-id", launched.deployId], { env, stdout: status, stderr: capture(), spawnImpl: fakeSpawn([]) }), 0);
  assert.match(status.text(), /starting/);
  await fs.writeFile(path.join(deployDir, "result.json"), JSON.stringify({
    deployId: launched.deployId, state: "finished", exitCode: 0, outcome: "success", summary: summarizeDeployLog(SAMPLE_LOG),
  }));
  const done = capture();
  assert.equal(await runCli(["update", "status", "--deploy-id", launched.deployId], { env, stdout: done, stderr: capture(), spawnImpl: fakeSpawn([]) }), 0);
  assert.match(done.text(), /Deploy finished .*exit 0/);
  const missing = capture();
  assert.equal(await runCli(["update", "status", "--deploy-id", "../etc"], { env, stdout: missing, stderr: capture(), spawnImpl: fakeSpawn([]) }), 1);
});

test("CLI update --detach requires a versioned release deploy", async () => {
  const stderr = capture();
  const spawned = [];
  const code = await runCli(["update", "--in-place", "--detach"], { env: {}, stdout: capture(), stderr, spawnImpl: fakeSpawn(spawned) });
  assert.notEqual(code, 0);
  assert.equal(spawned.length, 0);
  assert.match(stderr.text(), /--detach requires a versioned release/);
});
