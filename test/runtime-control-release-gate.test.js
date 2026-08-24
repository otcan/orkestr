import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runRuntimeControlReleaseGate } from "../scripts/runtime-control-release-gate.mjs";

test("runtime control release gate emits deterministic attended-rollout checks", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-gate-"));
  const inputPath = path.join(home, "gate-input.json");
  await fs.writeFile(inputPath, JSON.stringify({
    falseRecoveries: 0,
    unresolvedSteeringInputs: 0,
    duplicateTurns: 0,
    maxStopLatencyMs: 250,
    checkpointResumeFailures: 0,
    pendingFinalDeliveries: 0,
  }));

  const result = await runRuntimeControlReleaseGate({
    argv: ["--input", inputPath],
    env: { ORKESTR_RUNTIME_STOP_LATENCY_GATE_MS: "5000" },
  });

  assert.equal(result.gate, "runtime_control_liveness");
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 6);
  assert.equal(result.checks.every((check) => check.ok), true);
});
