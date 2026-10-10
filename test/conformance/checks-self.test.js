import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCapabilities } from "./capabilities.js";
import { CHECKS } from "./checks.js";
import { ReferenceAdapter } from "./reference-adapter.js";

// The suite is only useful if it fails broken adapters. Each case below breaks
// one behaviour of the reference adapter and expects the matching check to fail.

const check = (id) => CHECKS.find((item) => item.id === id);

async function brokenAdapter(t, patch) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-conformance-self-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const adapter = new ReferenceAdapter({ stateFile: path.join(dir, "state.json"), slowMs: 200 });
  patch(adapter);
  return adapter;
}

test("conformance capabilities reject unknown names", () => {
  assert.throws(() => normalizeCapabilities(["turn.start", "turn.teleport"]), /turn\.teleport/);
});

test("idempotency check fails an adapter that re-runs duplicate inputs", async (t) => {
  const adapter = await brokenAdapter(t, (target) => {
    const run = target.runTurn.bind(target);
    target.runTurn = (session, input, options) => run(session, { ...input, inputId: `${input.inputId}-${Math.random()}` }, options);
  });
  const session = await adapter.startSession({ sessionKey: "dup" });
  await assert.rejects(check("idempotent-redelivery").run(adapter, session), /duplicate/);
});

test("tool-permission check fails an adapter that ignores deny", async (t) => {
  const adapter = await brokenAdapter(t, (target) => {
    const execute = target.execute.bind(target);
    target.execute = async (input, signal, options) => {
      const result = await execute(input, signal, options);
      return result.tool ? { ...result, tool: { ...result.tool, executed: true } } : result;
    };
  });
  const session = await adapter.startSession({ sessionKey: "tool" });
  await assert.rejects(check("tool-permission-deny").run(adapter, session), /not execute/);
});

test("cancellation check fails an adapter that finishes the turn anyway", async (t) => {
  const adapter = await brokenAdapter(t, (target) => {
    target.cancelTurn = async () => ({ cancelled: true });
  });
  const session = await adapter.startSession({ sessionKey: "cancel" });
  await assert.rejects(check("cancellation").run(adapter, session), /cancelled/);
});

test("resume check fails an adapter that opens a new provider session after restart", async (t) => {
  const adapter = await brokenAdapter(t, (target) => {
    target.resumeSession = async () => ({ providerSessionId: "ref-session-new", resumed: true });
  });
  const session = await adapter.startSession({ sessionKey: "resume" });
  await assert.rejects(check("restart-resume").run(adapter, session), /ref-session-new/);
});

test("error classification check fails an adapter that reports every failure as permanent", async (t) => {
  const adapter = await brokenAdapter(t, (target) => {
    const execute = target.execute.bind(target);
    target.execute = async (input, signal, options) => {
      const result = await execute(input, signal, options);
      return result.error ? { ...result, error: { ...result.error, class: "permanent" } } : result;
    };
  });
  const session = await adapter.startSession({ sessionKey: "errors" });
  await assert.rejects(check("error-auth").run(adapter, session), /permanent/);
  await check("error-permanent").run(adapter, session);
});
