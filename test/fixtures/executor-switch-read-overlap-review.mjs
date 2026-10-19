import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyPendingExecutorSwitch, switchThreadExecutor } from "../../packages/core/src/thread-executor-switch.js";
import { threadUsesClaudeCode } from "../../packages/core/src/runtime-claude-code-adapter.js";
import { getThread, updateThread } from "../../packages/core/src/threads.js";
import { dataPaths } from "../../packages/storage/src/paths.js";

function latch() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export function reviewReadOverlap({ fixture, readyProfile, codexThread, fakeRuntime }) {
  test("independent switch application completes entirely during one snapshot read", { timeout: 5000 }, async (t) => {
    const id = "overlap-read", base = await fixture(t, id);
    const env = { ...base.env, ORKESTR_THREAD_STORE: "json" };
    await readyProfile(env);
    await codexThread(id, env);
    const runtime = fakeRuntime();
    await switchThreadExecutor(id, "claude", { runtime }, env);
    await updateThread(id, { state: "working", runtime: { state: "working", activeTurnId: "synthetic-turn" } }, env);
    const entered = latch(), release = latch(), mkdir = fs.mkdir, readFile = fs.readFile;
    let active = true, armed = false, applying, witnessed = false;
    t.mock.method(fs, "mkdir", async function (directory, ...args) {
      if (directory === path.join(base.home, "context-checkpoints", id)) {
        entered.resolve();
        await release.promise;
      }
      return mkdir.call(this, directory, ...args);
    });
    runtime.claudeTurnActive = () => active;
    runtime.interruptClaude = async () => {
      active = false;
      await updateThread(id, { state: "ready", runtime: { state: "ready", activeTurnId: null } }, env);
      armed = true;
      return { interrupted: true };
    };
    t.mock.method(fs, "readFile", async function (file, ...args) {
      if (!armed || file !== dataPaths(env).threads) return readFile.call(this, file, ...args);
      armed = false;
      // The waiter sampled no lock before this read. Start the actual application,
      // capture real bytes while its cleared marker precedes target mutation,
      // then let the application finish before this delayed read resolves.
      applying = applyPendingExecutorSwitch(id, { runtime }, env);
      await entered.promise;
      const raw = await readFile.call(this, file, ...args);
      const snapshot = JSON.parse(raw).find((row) => row.id === id);
      assert.equal(snapshot.pendingExecutorSwitch, undefined);
      assert.equal(threadUsesClaudeCode(snapshot), true);
      witnessed = true;
      release.resolve();
      await applying;
      await Promise.resolve();
      assert.equal(threadUsesClaudeCode(await getThread(id, env)), false);
      return raw;
    });
    try {
      const result = await switchThreadExecutor(id, "codex", { runtime, when: "now" }, env);
      assert.equal(witnessed, true);
      assert.equal(result.changed, true);
      assert.equal(result.deferred, false);
      assert.equal(threadUsesClaudeCode(result.thread), false);
      assert.equal(runtime.calls.filter((call) => call.op === "resumeCodex").length, 1);
    } finally {
      release.resolve();
      await applying;
    }
  });
}
