import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTestChild } from "../scripts/ci-test-child.mjs";
import { parseCiTestRunnerArgs, runCiTests } from "../scripts/ci-test-runner.mjs";

const passingFile = `import test from "node:test";\ntest("passes", () => {});\n`;
// Keeps a live handle so node cannot detect the pending promise and bail out.
const hangingFile = `import test from "node:test";\ntest("never resolves", () => new Promise(() => { setInterval(() => {}, 1000); }));\n`;

async function fixtureRoot(t, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ci-supervision-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "test"), { recursive: true });
  await fs.writeFile(path.join(root, "test", "test-bootstrap.mjs"), "", "utf8");
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(root, "test", name), body, "utf8");
  }
  return root;
}

function captureLogger() {
  const out = [];
  const err = [];
  return { out, err, log: (line) => out.push(String(line)), error: (line) => err.push(String(line)) };
}

function options(root, env = {}) {
  return parseCiTestRunnerArgs(["--root", root], env);
}

test("runner parses timeout, watchdog and progress settings from env", () => {
  const defaults = parseCiTestRunnerArgs([], {});
  assert.equal(defaults.testTimeoutMs, 300_000);
  assert.equal(defaults.watchdogMs, 1_200_000);
  assert.equal(defaults.progress, false);
  const custom = parseCiTestRunnerArgs([], {
    ORKESTR_TEST_TIMEOUT_MS: "0",
    ORKESTR_TEST_WATCHDOG_MS: "1500",
    ORKESTR_TEST_PROGRESS: "1",
    ORKESTR_TEST_PROGRESS_EVERY: "3",
  });
  assert.equal(custom.testTimeoutMs, 0);
  assert.equal(custom.watchdogMs, 1500);
  assert.equal(custom.progress, true);
  assert.equal(custom.progressEvery, 3);
});

test("a hung test file fails by name via the per-file timeout", async (t) => {
  const root = await fixtureRoot(t, { "a-hang.test.js": hangingFile, "b-ok.test.js": passingFile });
  const logger = captureLogger();
  const result = await runCiTests(options(root, { ORKESTR_TEST_TIMEOUT_MS: "1000", ORKESTR_TEST_WATCHDOG_MS: "60000" }), logger);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, undefined);
  const errors = logger.err.join("\n");
  assert.match(errors, /not ok \d+ - test\/a-hang\.test\.js/);
  assert.match(errors, /timed out after 1000ms/);
  assert.match(errors, /# pass 1/);
  assert.equal(logger.out.some((line) => line.startsWith("[ci-test]")), false);
});

test("the watchdog kills a hung run and names the in-flight test file", async (t) => {
  const root = await fixtureRoot(t, { "a-ok.test.js": passingFile, "b-hang.test.js": hangingFile });
  const logger = captureLogger();
  const startedAt = Date.now();
  const result = await runCiTests(options(root, { ORKESTR_TEST_TIMEOUT_MS: "0", ORKESTR_TEST_WATCHDOG_MS: "2000" }), logger);
  assert.equal(Date.now() - startedAt < 20_000, true);
  assert.deepEqual(result, { ok: false, code: 124, timedOut: true });
  const errors = logger.err.join("\n");
  assert.match(errors, /exceeded the 2000ms watchdog/);
  assert.match(errors, /Files completed: 1\/2/);
  assert.match(errors, /Still running: test\/b-hang\.test\.js/);
  assert.match(errors, /Last started test files:\n {2}test\/a-ok\.test\.js\n {2}test\/b-hang\.test\.js/);
  assert.match(errors, /Output tail:\nTAP version 13/);
});

test("progress lines are opt-in and keep the TAP summary output unchanged", async (t) => {
  const root = await fixtureRoot(t, { "a.test.js": passingFile, "b.test.js": passingFile });
  const quiet = captureLogger();
  assert.deepEqual(await runCiTests(options(root), quiet), { ok: true, code: 0 });
  assert.equal(quiet.out.some((line) => line.includes("[ci-test]")), false);
  assert.equal(quiet.out.some((line) => line.includes("::orkestr-ci-test::")), false);
  assert.match(quiet.out.join("\n"), /^1\.\.2\n# tests 2\n# suites 0\n# pass 2\n# fail 0/m);

  const verbose = captureLogger();
  assert.deepEqual(await runCiTests(options(root, { ORKESTR_TEST_PROGRESS: "1", ORKESTR_TEST_PROGRESS_EVERY: "1" }), verbose), { ok: true, code: 0 });
  const progress = verbose.out.filter((line) => line.startsWith("[ci-test]"));
  assert.equal(progress.length, 2);
  assert.match(progress[0], /^\[ci-test\] 1\/2 files done, 0 failed, elapsed \d+s; running: none$/);
  assert.match(progress[1], /^\[ci-test\] 2\/2 files done, 0 failed/);
});

test("the child supervisor resolves on exit when a grandchild keeps stdio open", async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
    "console.log('grandchild=' + grandchild.pid);",
    "process.exit(0);",
  ].join("\n");
  const startedAt = Date.now();
  const result = await runTestChild({ args: ["-e", script], stdioGraceMs: 300, log: () => {} });
  assert.equal(Date.now() - startedAt < 10_000, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdioTimedOut, true);
  const pid = Number(/grandchild=(\d+)/.exec(result.output)?.[1]);
  assert.ok(pid > 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
