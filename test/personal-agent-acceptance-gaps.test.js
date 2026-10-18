import assert from "node:assert/strict";
import test from "node:test";
import { admitRun } from "../packages/core/src/agent-job-admission.js";
import { getRunAudit } from "../packages/core/src/agent-job-audit.js";
import { listRunEffects } from "../packages/core/src/agent-job-ledger.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { listCheckpoints } from "../packages/core/src/agent-job-store.js";
import { registerAgentJobTool } from "../packages/core/src/agent-job-tools.js";
import { fixtureSpec, offlineFixture, pendingCases } from "./fixtures/personal-agent-acceptance/fixtures.mjs";
import { acceptanceCheck, expectKnownGap } from "./fixtures/personal-agent-acceptance/harness.mjs";

// These demonstrate why an Agent Job's terminal state alone cannot certify
// a Personal Agent Task. They do NOT redefine low-level Agent Job success.
// Replace the runner-only mapping with Lane A's task verifier after OP-02.
for (const mode of ["failed", "unknown", "denied"]) {
  const id = { failed: "PA-G01", unknown: "PA-G02", denied: "PA-G03" }[mode];
  test(`${id} [OP-04 OP-06 OP-14]: runner-only completion after ${mode} required verification is insufficient`, async (t) => {
    const env = await offlineFixture(t);
    const tool = `acceptance.required.${mode}`;
    let calls = 0;
    if (mode !== "unknown") {
      t.after(registerAgentJobTool({ name: tool, effect: true, async perform() {
        calls += 1;
        throw new Error("fixture_required_verification_failed");
      } }));
    }
    const spec = fixtureSpec({
      script: [{ tool, args: {} }, { output: { summary: "All required checks passed. DONE." } }],
      tools: mode === "denied" ? { deny: [tool] } : { allow: [tool] },
    });
    const { run } = await admitRun({ spec, dedupeKey: id }, env);
    const result = await driveRun(run.id, {}, env);
    // Regression assertions run outside known-gap handling.
    assert.equal(calls, mode === "failed" ? 1 : 0);
    const effects = await listRunEffects(run.id, env);
    if (mode === "failed") assert.equal(effects[0].state, "failed");
    else assert.deepEqual(effects, []);
    const audit = await getRunAudit(run.id, env);
    assert.equal(audit.tool_decisions[0].decision, mode === "denied" ? "deny" : "allow");
    const outcome = (await listCheckpoints(run.id, env)).find((entry) => entry.kind === "tool_result");
    assert.equal(outcome.data.status, { failed: "error", unknown: "unknown_tool", denied: "denied" }[mode]);
    assert.equal(audit.output.summary, "All required checks passed. DONE.");
    await expectKnownGap(t, {
      id, ops: ["OP-04", "OP-06", "OP-14"],
      reason: "Task certification must verify its required artifact/criterion instead of copying run success",
    }, async () => {
      acceptanceCheck(result.state !== "succeeded", id,
        `Runner-only mapping certifies ${mode} required verification without a verified artifact (run=${result.state})`);
    });
  });
}

for (const [id, ops, reason] of pendingCases) {
  const name = `${id} [${ops.join(" ")}]: ${reason}`;
  if (process.env.ORKESTR_PERSONAL_AGENT_ACCEPTANCE_STRICT === "1") {
    test(name, () => assert.fail(`PENDING_ACCEPTANCE ${id}: implement the oracle in docs/product/personal-agent-acceptance-plan.md`));
  } else {
    test.todo(name);
  }
}
