import assert from "node:assert/strict";
import { ERROR_CLASSES, TURN_STATUSES } from "./capabilities.js";

// Conformance checks. Every check receives the harness and a fresh session and
// talks to the adapter only through the harness contract documented in
// docs/spec/conformance.md:
//
//   harness.startSession({ sessionKey })            -> session
//   harness.runTurn(session, input, { onEvent, onToolRequest }) -> TurnResult
//   harness.cancelTurn(session)                     -> { cancelled }
//   harness.restart()                               -> void (drop in-memory state)
//   harness.resumeSession(session)                  -> { providerSessionId, resumed }
//   harness.providerTurnCount()                     -> number of provider turn invocations
//
// Inputs carry a provider-neutral `scenario` the harness translates into fake
// provider behaviour: "echo" (default), "progress", "slow", "tool",
// "fault:auth", "fault:transient", "fault:permanent".

let inputCounter = 0;

export function conformanceInput(scenario = "echo", text = "") {
  inputCounter += 1;
  const inputId = `conformance-input-${process.pid}-${inputCounter}`;
  return { inputId, scenario, text: text || `conformance ${scenario} ${inputCounter}` };
}

export function assertTurnResultShape(result) {
  assert.ok(result && typeof result === "object", "runTurn must resolve to a TurnResult object");
  assert.equal(typeof result.turnId, "string", "TurnResult.turnId must be a string");
  assert.ok(result.turnId.length > 0, "TurnResult.turnId must be non-empty");
  assert.ok(TURN_STATUSES.includes(result.status), `TurnResult.status must be one of ${TURN_STATUSES.join("|")}, got ${result.status}`);
  if (result.status === "failed") {
    assert.ok(result.error && typeof result.error === "object", "failed turns must carry an error object");
  }
}

function collector() {
  const events = [];
  return { events, onEvent: (event) => events.push(event) };
}

async function expectCompleted(harness, session, input, options = {}) {
  const result = await harness.runTurn(session, input, options);
  assertTurnResultShape(result);
  assert.equal(result.status, "completed", `turn should complete, got ${result.status} ${JSON.stringify(result.error || null)}`);
  return result;
}

async function errorCheck(harness, session, errorClass) {
  const result = await harness.runTurn(session, conformanceInput(`fault:${errorClass}`));
  assertTurnResultShape(result);
  assert.equal(result.status, "failed");
  assert.ok(ERROR_CLASSES.includes(result.error.class), `error.class must be one of ${ERROR_CLASSES.join("|")}`);
  assert.equal(result.error.class, errorClass);
  assert.ok(!result.output?.text, "failed turns must not report final output");
}

async function toolCheck(harness, session, decision) {
  const requests = [];
  const result = await harness.runTurn(session, conformanceInput("tool"), {
    onToolRequest: async (request) => {
      requests.push(request);
      return decision;
    },
  });
  assertTurnResultShape(result);
  assert.equal(requests.length, 1, "the tool-permission hook must be consulted exactly once");
  assert.equal(typeof requests[0].tool, "string", "tool requests must name the tool");
  assert.ok(result.tool, "TurnResult.tool must describe the tool request");
  assert.equal(result.tool.decision, decision);
  assert.equal(result.tool.executed, decision === "approve", `tool must ${decision === "approve" ? "" : "not "}execute after ${decision}`);
}

export const CHECKS = Object.freeze([
  {
    id: "start-turn",
    capability: "turn.start",
    title: "starts a turn and returns a stable turn id",
    async run(harness, session) {
      const first = await expectCompleted(harness, session, conformanceInput());
      const second = await expectCompleted(harness, session, conformanceInput());
      assert.notEqual(first.turnId, second.turnId, "distinct inputs must produce distinct turn ids");
    },
  },
  {
    id: "final-output",
    capability: "turn.final_output",
    title: "returns structured final output",
    async run(harness, session) {
      const input = conformanceInput("echo", "conformance final output probe");
      const { events, onEvent } = collector();
      const result = await expectCompleted(harness, session, input, { onEvent });
      assert.equal(typeof result.output?.text, "string");
      assert.match(result.output.text, /conformance final output probe/, "fake providers echo the input text");
      assert.equal(result.error ?? null, null);
      assert.equal(events.filter((event) => event.type === "final").length, 1, "exactly one final event");
    },
  },
  {
    id: "streaming-progress",
    capability: "turn.streaming",
    title: "streams progress events before the final output",
    async run(harness, session) {
      const { events, onEvent } = collector();
      await expectCompleted(harness, session, conformanceInput("progress"), { onEvent });
      const progressAt = events.findIndex((event) => event.type === "progress");
      const finalAt = events.findIndex((event) => event.type === "final");
      assert.ok(progressAt >= 0, "at least one progress event");
      assert.ok(finalAt > progressAt, "progress must precede the final event");
    },
  },
  {
    id: "cancellation",
    capability: "turn.cancel",
    title: "cancels an active turn without late final output",
    async run(harness, session) {
      const { events, onEvent } = collector();
      const running = harness.runTurn(session, conformanceInput("slow"), { onEvent });
      const cancelled = await harness.cancelTurn(session);
      assert.equal(cancelled.cancelled, true);
      const result = await running;
      assertTurnResultShape(result);
      assert.equal(result.status, "cancelled");
      assert.equal(events.some((event) => event.type === "final"), false, "no final event after cancel");
      await expectCompleted(harness, session, conformanceInput());
    },
  },
  {
    id: "restart-resume",
    capability: "session.resume",
    title: "resumes the same provider session after a process restart",
    async run(harness, session) {
      const before = await expectCompleted(harness, session, conformanceInput());
      await harness.restart();
      const resumed = await harness.resumeSession(session);
      assert.equal(resumed.resumed, true, "resumeSession must report that it resumed");
      assert.ok(before.providerSessionId, "TurnResult.providerSessionId is required for session.resume");
      assert.equal(resumed.providerSessionId, before.providerSessionId);
      const after = await expectCompleted(harness, session, conformanceInput());
      assert.equal(after.providerSessionId, before.providerSessionId, "post-restart turn runs in the original provider session");
    },
  },
  {
    id: "idempotent-redelivery",
    capability: "input.idempotent",
    title: "runs a re-delivered input at most once and returns the original outcome",
    async run(harness, session) {
      const input = conformanceInput();
      const startCount = await harness.providerTurnCount();
      const first = await expectCompleted(harness, session, input);
      const second = await harness.runTurn(session, { ...input });
      assertTurnResultShape(second);
      assert.equal(second.duplicate, true, "the re-delivery must be reported as duplicate");
      assert.equal(second.turnId, first.turnId, "the duplicate resolves to the original turn");
      assert.equal(second.status, first.status, "the duplicate returns the original turn status");
      assert.equal(second.output?.text, first.output?.text, "the duplicate returns the original final output");
      if (first.finalMessageId) assert.equal(second.finalMessageId, first.finalMessageId, "the duplicate returns the original final message id");
      assert.equal(await harness.providerTurnCount() - startCount, 1, "provider ran exactly one turn");
    },
  },
  {
    id: "tool-permission-deny",
    capability: "tools.approval",
    title: "tool-permission hook deny blocks the tool",
    run: (harness, session) => toolCheck(harness, session, "deny"),
  },
  {
    id: "tool-permission-approve",
    capability: "tools.approval",
    title: "tool-permission hook approve runs the tool",
    run: (harness, session) => toolCheck(harness, session, "approve"),
  },
  ...ERROR_CLASSES.map((errorClass) => ({
    id: `error-${errorClass}`,
    capability: `errors.${errorClass}`,
    title: `classifies ${errorClass} failures`,
    run: (harness, session) => errorCheck(harness, session, errorClass),
  })),
]);
