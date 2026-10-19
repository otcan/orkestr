import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyPendingExecutorSwitch, switchThreadExecutor } from "../../packages/core/src/thread-executor-switch.js";
import { threadUsesClaudeCode } from "../../packages/core/src/runtime-claude-code-adapter.js";
import { getThread, updateThread } from "../../packages/core/src/threads.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export function pendingSwitchRaceTests({ fixture, readyProfile, codexThread, fakeRuntime }) {
  for (const stalled of [false, true]) {
    test(`when=now ${stalled ? "times out without waiting on" : "waits for"} a pending-cleared switch lock`, async (t) => {
      const id = stalled ? "pending-cleared-stalled" : "pending-cleared-completes";
      const { home, env } = await fixture(t, id);
      await readyProfile(env);
      await codexThread(id, env);
      const runtime = fakeRuntime();
      await switchThreadExecutor(id, "claude", { runtime }, env);
      await updateThread(id, { state: "working", runtime: { state: "working", activeTurnId: "synthetic-active-turn" } }, env);
      let active = true;
      let applying;
      const entered = deferred();
      const release = deferred();
      const mkdir = fs.mkdir;
      t.mock.method(fs, "mkdir", async function (directory, ...args) {
        if (directory === path.join(home, "context-checkpoints", id)) {
          entered.resolve();
          await release.promise;
        }
        return mkdir.call(this, directory, ...args);
      });
      runtime.claudeTurnActive = () => active;
      runtime.interruptClaude = async () => {
        active = false;
        await updateThread(id, { state: "ready", runtime: { state: "ready", activeTurnId: null } }, env);
        applying = applyPendingExecutorSwitch(id, { runtime }, env);
        return { interrupted: true };
      };
      const waitEnv = { ...env, ORKESTR_EXECUTOR_SWITCH_INTERRUPT_WAIT_MS: stalled ? "30" : "2000" };
      let settled = false;
      const switching = switchThreadExecutor(id, "codex", { runtime, when: "now" }, waitEnv)
        .then((result) => { settled = true; return result; }, (error) => { settled = true; throw error; });
      // Attach a rejection handler immediately while the barrier is inspected.
      switching.catch(() => {});
      try {
        await entered.promise;
        const middle = await getThread(id, env);
        assert.equal(middle.pendingExecutorSwitch, undefined);
        assert.equal(threadUsesClaudeCode(middle), true, "barrier must precede target mutation");
        if (stalled) {
          const result = await Promise.race([
            switching,
            new Promise((_, reject) => setTimeout(() => reject(new Error("switch exceeded finite wait while lock held")), 750)),
          ]);
          assert.equal(result.deferred, true);
          assert.equal(result.changed, false);
          assert.equal(threadUsesClaudeCode(result.thread), true);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 180));
          assert.equal(settled, false, "pending removal alone must not finish the switch");
        }
      } finally {
        release.resolve();
        await applying;
      }
      const result = await switching;
      if (!stalled) {
        assert.equal(result.changed, true);
        assert.equal(result.deferred, false);
      }
      assert.equal(threadUsesClaudeCode(await getThread(id, env)), false);
      assert.equal(runtime.calls.filter((call) => call.op === "resumeCodex").length, 1);
    });
  }
}
