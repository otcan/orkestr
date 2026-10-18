import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { claudeCodeJobAdapter } from "../packages/core/src/agent-job-claude-code.js";
import { fakeClaude } from "./fixtures/claude-job-fixtures.js";
import { supervisor } from "./fixtures/personal-agent-session-fixtures.js";

test("first managed Claude turn denies hooks before durable session.started, then allows", async t => {
  const fake = await fakeClaude([]);
  t.after(() => fs.rm(fake.env.ORKESTR_HOME, { recursive: true, force: true }));
  const cwd = path.join(fake.env.ORKESTR_HOME, "project"), barrier = path.join(cwd, "persisted");
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(fake.env.ORKESTR_HOME, "fake-claude/plan.json"), JSON.stringify({ turns: [{
    preInitTools: [{ name: "Read", input: { file_path: "before.txt" } }],
    initBarrier: barrier,
    tools: [{ name: "Read", input: { file_path: "after.txt" } }],
  }] }));
  let persisted = false;
  const observed = [];
  const ctx = { ...supervisor(), env: { ...fake.env, ORKESTR_PERSONAL_AGENT_ENABLED: "1" },
    personalAgentSession: { effort: "high" }, prepareWorkspace: async () => ({ path: cwd, kind: "project" }),
    emit(event) {
      if (event.type === "session.started") {
        // This is the same synchronous boundary as the manager's prepared CAS.
        persisted = true;
        writeFileSync(barrier, "synthetic-persisted");
      }
    },
    async authorizeTool({ args }) { observed.push({ path: args.file_path, persisted }); return { decision: "allow" }; },
  };
  assert.equal((await claudeCodeJobAdapter.run(ctx, { prompt: "synthetic fixture" })).type, "final");
  assert.deepEqual(observed, [{ path: "after.txt", persisted: true }], "no policy allow may occur before native identity persistence");
  assert.deepEqual((await fake.ran()).map(call => call.input.file_path), ["after.txt"]);
});

for (const failure of ["throw", "abort"]) {
  test(`Claude session persistence ${failure} never grants a tool`, async t => {
    const fake = await fakeClaude([{ tools: [{ name: "Read", input: { file_path: "never.txt" } }] }]);
    t.after(() => fs.rm(fake.env.ORKESTR_HOME, { recursive: true, force: true }));
    const cwd = path.join(fake.env.ORKESTR_HOME, "project");
    await fs.mkdir(cwd);
    const caller = new AbortController();
    let authorizations = 0;
    const ctx = { ...supervisor(caller.signal), env: { ...fake.env, ORKESTR_PERSONAL_AGENT_ENABLED: "1" },
      personalAgentSession: { effort: "high" }, prepareWorkspace: async () => ({ path: cwd, kind: "project" }),
      emit(event) {
        if (event.type !== "session.started") return;
        if (failure === "throw") throw new Error("synthetic journal failure");
        caller.abort("lease_lost"); // manager identity CAS failure aborts instead of throwing
      },
      async authorizeTool() { authorizations++; return { decision: "allow" }; },
    };
    if (failure === "throw") await assert.rejects(claudeCodeJobAdapter.run(ctx, {}), /session_persistence_failed/);
    else assert.equal((await claudeCodeJobAdapter.run(ctx, {})).type, "cancelled");
    assert.equal(authorizations, 0);
    assert.deepEqual(await fake.ran(), []);
  });
}

for (const mode of ["resumed", "flag off"]) {
  test(`Claude ${mode} keeps existing hook authorization behavior`, async t => {
    const fake = await fakeClaude([{ preInitTools: [{ name: "Read", input: { file_path: "existing.txt" } }] }]);
    t.after(() => fs.rm(fake.env.ORKESTR_HOME, { recursive: true, force: true }));
    const cwd = path.join(fake.env.ORKESTR_HOME, "project");
    await fs.mkdir(cwd);
    let authorizations = 0;
    const ctx = { ...supervisor(), env: { ...fake.env, ORKESTR_PERSONAL_AGENT_ENABLED: mode === "resumed" ? "1" : "0" },
      personalAgentSession: { effort: "high" }, resume: mode === "resumed" ? { sessionRef: "durable-synthetic-session" } : undefined,
      prepareWorkspace: async () => ({ path: cwd, kind: "project" }),
      async authorizeTool() { authorizations++; return { decision: "allow" }; },
    };
    assert.equal((await claudeCodeJobAdapter.run(ctx, {})).type, "final");
    assert.equal(authorizations, 1);
    assert.equal((await fake.ran()).length, 1);
  });
}
