import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRuntimeCanaryEvidence } from "../packages/core/src/runtime-canary-evidence.js";
import { evaluateRuntimeControlReleaseGate } from "../packages/core/src/runtime-control-observability.js";
import { runRuntimeControlReleaseGate } from "../scripts/runtime-control-release-gate.mjs";

const measurements = { falseRecoveries: 0, unresolvedSteeringInputs: 0, duplicateTurns: 0,
  maxStopLatencyMs: 250, checkpointResumeFailures: 0, pendingFinalDeliveries: 0 };
function input() {
  return { ...measurements, canaryEvidence: { version: 1, releaseId: "candidate-a",
    startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T01:00:00Z",
    canaries: ["internal", "tenant"].map(stage => ({ id: stage, stage, releaseId: "candidate-a",
      scopeRef: `private:${stage}`, evidenceRef: `private:${stage}-observation`, terminalDisposition: "completed",
      completedAt: "2026-01-01T00:30:00Z", finalMessageId: `${stage}-final`, finalPersisted: true,
      transportAccepted: true, deliveryReceiptRef: `${stage}-receipt`, deliveryAcceptedAt: "2026-01-01T00:31:00Z",
      stopObserved: true, steeringObserved: true, checkpointResumeObserved: true })),
    rollback: { observed: true, evidenceRef: "private:rollback", releaseId: "candidate-a",
      restoredReleaseId: "previous", observedAt: "2026-01-01T00:59:00Z", healthy: true } } };
}

test("runtime measurements fail closed on missing, negative and coerced observations", () => {
  assert.equal(evaluateRuntimeControlReleaseGate({}).ok, false);
  assert.equal(evaluateRuntimeControlReleaseGate(null).ok, false);
  for (const key of Object.keys(measurements)) for (const value of [undefined, null, -1, NaN, Infinity, "0", false]) {
    const result = evaluateRuntimeControlReleaseGate({ ...measurements, [key]: value });
    assert.equal(result.ok, false, `${key}: ${value}`);
    assert.ok(result.checks.some(check => check.reason === "missing_or_invalid_measurement"));
  }
  assert.equal(evaluateRuntimeControlReleaseGate({ ...measurements, duplicateTurns: 0.5 }).ok, false);
  assert.equal(evaluateRuntimeControlReleaseGate(measurements).ok, true);
});

test("attended evidence requires both scoped canaries, final receipts and observed rollback", async () => {
  assert.equal(evaluateRuntimeCanaryEvidence(input()).ok, true);
  const cases = [
    data => { delete data.canaryEvidence; },
    data => { data.canaryEvidence.canaries.pop(); },
    data => { data.canaryEvidence.canaries[1].id = "internal"; },
    data => { data.canaryEvidence.canaries[1].deliveryReceiptRef = data.canaryEvidence.canaries[0].deliveryReceiptRef; },
    data => { data.canaryEvidence.canaries[1].scopeRef = data.canaryEvidence.canaries[0].scopeRef; },
    data => { data.canaryEvidence.canaries[1].releaseId = "old"; },
    data => { data.canaryEvidence.canaries[1].transportAccepted = false; },
    data => { data.canaryEvidence.canaries[0].finalPersisted = false; },
    data => { data.canaryEvidence.canaries[0].deliveryReceiptRef = ""; },
    data => { data.canaryEvidence.canaries[0].terminalDisposition = "running"; },
    data => { data.canaryEvidence.canaries[0].checkpointResumeObserved = false; },
    data => { data.canaryEvidence.canaries[0].deliveryAcceptedAt = "2025-01-01T00:00:00Z"; },
    data => { data.canaryEvidence.canaries[0].deliveryAcceptedAt = "2026-01-01T00:29:00Z"; },
    data => { data.canaryEvidence.rollback.observed = false; },
    data => { data.canaryEvidence.rollback.releaseId = "other"; },
    data => { data.canaryEvidence.rollback.restoredReleaseId = "candidate-a"; },
    data => { data.canaryEvidence.completedAt = "2999-01-01T00:00:00Z"; },
  ];
  for (const mutate of cases) { const data = input(); mutate(data); assert.equal(evaluateRuntimeCanaryEvidence(data).ok, false); }
  const env = { ORKESTR_RUNTIME_CONTROL_GATE_INPUT_JSON: JSON.stringify(input()) };
  assert.equal((await runRuntimeControlReleaseGate({ argv: ["--attended"], env })).ok, true);
  const missing = await runRuntimeControlReleaseGate({ argv: ["--attended"], env: {
    ORKESTR_RUNTIME_CONTROL_GATE_INPUT_JSON: JSON.stringify(measurements) } });
  assert.equal(missing.ok, false);
  assert.equal(missing.qualification, "attended_rollout");
  assert.equal(JSON.stringify(missing).includes("private:"), false);
});
