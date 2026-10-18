import assert from "node:assert/strict";
import test from "node:test";
import { probeInstalledSessions } from "../scripts/personal-agent-session-probe.mjs";

test("opt-in installed runtime control-plane inventory spends no inference quota", { skip: process.env.ORKESTR_SESSION_PROBE !== "1" }, async () => {
  const result = await probeInstalledSessions();
  assert.equal(result.inferenceTurns, 0);
  assert.equal(result.codex.blocked, undefined);
  assert.equal(result.codex.distinctNativeIds, true);
  for (const method of ["ThreadResume", "ThreadFork", "TurnSteer", "TurnInterrupt"]) assert.ok(result.codex.protocol[method].includes("threadId"));
  assert.ok(result.codex.protocol.TurnStart.includes("effort"));
  assert.equal(result.codex.idleSteer.accepted, false);
  assert.equal(result.codex.idleInterrupt.accepted, false);
  assert.equal(result.codex.modelChange.accepted, true);
  assert.equal(result.codex.afterModelChange.sameNativeId, true);
  console.log(JSON.stringify(result)); // Sanitized booleans/protocol fields only.
});
