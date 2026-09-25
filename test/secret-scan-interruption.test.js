import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runScanner } from "../scripts/security/scanner-process.mjs";

const cli = fileURLToPath(new URL("../scripts/security/secret-scan.mjs", import.meta.url));
const env = { PATH: "/usr/local/bin:/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await pause(); }
  assert.fail("inert subprocess did not reach expected state");
}
async function stopped(pid) {
  try {
    // Linux may retain an orphan zombie until the container's init reaps it.
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) for (const phase of ["scan", "version"]) {
  test(`${signal} during ${phase} removes owned residue and stops scanner descendants`, { skip: process.platform !== "linux", timeout: 15000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scan-interruption-test-"));
    const repository = path.join(root, "repo");
    await fs.mkdir(repository);
    const git = args => {
      const result = spawnSync("git", ["-C", repository, "-c", "user.name=Example",
        "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", ...args], { env, encoding: "utf8" });
      assert.equal(result.status, 0);
      return result.stdout.trim();
    };
    git(["init", "--quiet", "--template="]);
    git(["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Inert fixture"]);
    const binary = path.join(root, "scanner.cjs");
    await fs.writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
if (process.argv[2] === 'version' && ${JSON.stringify(phase)} !== 'version') {
  console.log('8.30.1');
} else {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const index = process.argv.indexOf('--report-path');
  const report = index < 0 ? null : process.argv[index + 1];
  if (report) fs.writeFileSync(report, JSON.stringify([{ Message: 'INERT_METADATA_ONLY' }]));
  fs.writeFileSync(path.join(__dirname, 'ready.json'), JSON.stringify({ pid: process.pid, child: child.pid, report }));
  setInterval(() => {}, 1000);
}
`, { mode: 0o700 });
    const report = path.join(root, "evidence.json");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const wrapper = spawn(process.execPath, [cli, "--binary", binary, "--repository", repository,
      "--label", "example/repository", "--report", report, "--target-ref", "HEAD", "--expected-commit", git(["rev-parse", "HEAD"])],
    { env: { ...env, TMPDIR: root }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", ready;
    wrapper.stdout.on("data", data => { output += data; });
    wrapper.stderr.on("data", data => { output += data; });
    const exited = new Promise(resolve => wrapper.on("close", (code, receivedSignal) => resolve({ code, signal: receivedSignal })));
    t.after(async () => {
      wrapper.kill("SIGKILL"); unrelated.kill("SIGKILL");
      try { process.kill(-wrapper.pid, "SIGKILL"); } catch {}
      if (ready) { try { process.kill(-ready.pid, "SIGKILL"); } catch {} }
      await fs.rm(root, { recursive: true, force: true });
    });
    await until(async () => {
      try { ready = JSON.parse(await fs.readFile(path.join(root, "ready.json"), "utf8")); return true; }
      catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return false; throw error; }
    });
    if (ready.report) assert.equal((await fs.stat(path.dirname(ready.report))).mode & 0o777, 0o700);
    wrapper.kill(signal);
    const result = await exited;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    const evidence = JSON.parse(await fs.readFile(report, "utf8"));
    assert.equal(evidence.complete, false);
    assert.equal(evidence.ok, false);
    assert.equal(evidence.category, "scan_interrupted");
    assert.doesNotMatch(output + JSON.stringify(evidence), /INERT_METADATA_ONLY/);
    assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith("orkestr-redacted-scan-")), []);
    await until(async () => await stopped(ready.pid) && await stopped(ready.child));
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  });
}

test("asynchronous scanner runner bounds execution and captured output", { timeout: 5000 }, async () => {
  const signal = new AbortController().signal;
  const options = { env, timeout: 150, maxBuffer: 32 };
  const timedOut = await runScanner(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options, signal);
  assert.equal(timedOut.error.message, "scanner_timeout");
  const overflow = await runScanner(process.execPath, ["-e", "console.log('x'.repeat(100))"], { ...options, timeout: 2000 }, signal);
  assert.equal(overflow.error.message, "scanner_output_limit");
  const missing = await runScanner("/nonexistent-inert-scanner", [], options, signal);
  assert.ok(missing.error);
  assert.notEqual(missing.status, 0);
});
