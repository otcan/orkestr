import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detachedTurnProcessAlive, detachedTurnState, spawnDetachedClaudeTurn } from "../packages/core/src/claude-code-detached-turn.js";

async function waitUntilStopped(pid) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("T")) return;
    if (Date.now() > deadline) throw new Error("synthetic wrapper did not reach the prelaunch barrier");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const [signal, shellCode] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  test(`${signal} before detached provider launch is terminal`, { skip: process.platform !== "linux", timeout: 10_000 }, async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-dt-signal-"));
    const launcher = path.join(home, "paused-scope");
    // Preserve the production wrapper and its PID. Pause at the instruction
    // boundary after traps are installed but before the provider exists. This
    // forces the startup race without waiting for provider readiness or
    // repeating a cancellation signal until the assertion happens to pass.
    await fs.writeFile(launcher, `#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done
shell=$1; flag=$2; script=$3; shift 3
script=$(printf '%s\n' "$script" | sed '/^"\\$@" /i\\kill -STOP "$$"')
exec "$shell" "$flag" "$script" "$@"
`, { mode: 0o755 });
    const env = { ORKESTR_HOME: home, ORKESTR_CLAUDE_DETACHED_SCOPE: "1", ORKESTR_SYSTEMD_RUN_BIN: launcher, ORKESTR_CLAUDE_DETACHED_POLL_MS: "5" };
    const facade = spawnDetachedClaudeTurn({ command: "/bin/sh", args: ["-c", "printf 'provider-started\\n'"],
      cwd: home, childEnv: { PATH: process.env.PATH }, prompt: "synthetic", threadId: "synthetic", attemptId: signal, env });
    const record = facade.record();
    facade.onLine(() => {});
    const closed = new Promise((resolve, reject) => {
      facade.on("close", (code, observedSignal) => resolve({ code, signal: observedSignal }));
      facade.on("error", reject);
    });
    t.after(async () => {
      if (detachedTurnProcessAlive(record)) process.kill(-record.pgid, "SIGKILL");
      await closed.catch(() => {});
      await fs.rm(home, { recursive: true, force: true });
    });
    await waitUntilStopped(record.pid);
    assert.equal(detachedTurnProcessAlive(record), true);
    assert.equal(await fs.readFile(record.paths.events, "utf8"), "", "provider has not started at the barrier");
    process.kill(-record.pgid, signal);
    process.kill(-record.pgid, "SIGCONT");
    assert.deepEqual(await closed, { code: null, signal });
    assert.equal(await fs.readFile(record.paths.events, "utf8"), "", "cancellation must not launch the provider");
    assert.equal(await detachedTurnState(record), "exited");
    const exit = JSON.parse(await fs.readFile(record.paths.exit, "utf8"));
    assert.equal(exit.code, shellCode);
    assert.equal(exit.observedBy, undefined, "the running wrapper records its own terminal signal");
    assert.match(await fs.readFile(`${record.paths.exit}.signals`, "utf8"), new RegExp(`^${signal.slice(3)} \\d+$`, "m"));
  });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} still reaches an active detached provider`, { skip: process.platform === "win32", timeout: 10_000 }, async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-dt-active-signal-"));
    const env = { ORKESTR_HOME: home, ORKESTR_CLAUDE_DETACHED_SCOPE: "0", ORKESTR_CLAUDE_DETACHED_POLL_MS: "5" };
    const facade = spawnDetachedClaudeTurn({ command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000); process.stdout.write('provider-ready\\n');"],
      cwd: home, childEnv: { PATH: process.env.PATH }, prompt: "synthetic", threadId: "synthetic", attemptId: signal, env });
    const record = facade.record();
    let providerReady;
    const ready = new Promise(resolve => { providerReady = resolve; });
    facade.onLine(line => { if (line === "provider-ready") providerReady(); });
    const closed = new Promise((resolve, reject) => {
      facade.on("close", (code, observedSignal) => resolve({ code, signal: observedSignal }));
      facade.on("error", reject);
    });
    t.after(async () => {
      if (detachedTurnProcessAlive(record)) process.kill(-record.pgid, "SIGKILL");
      await closed.catch(() => {});
      await fs.rm(home, { recursive: true, force: true });
    });
    await Promise.race([ready, closed.then(() => { throw new Error("provider exited before readiness"); })]);
    process.kill(-record.pgid, signal);
    assert.deepEqual(await closed, { code: null, signal });
    assert.equal(await detachedTurnState(record), "exited");
    assert.match(await fs.readFile(`${record.paths.exit}.signals`, "utf8"), new RegExp(`^${signal.slice(3)} \\d+$`, "m"));
  });
}
