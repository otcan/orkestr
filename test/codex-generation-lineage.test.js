import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexGenerationTransitionPatch,
  currentCodexGeneration,
  inspectRolloutIdentity,
  resolveCurrentCodexGeneration,
  verifyRolloutGeneration,
} from "../packages/core/src/codex-generation-lineage.js";
import { threadForCodexThreadId } from "../packages/core/src/codex-app-server-common.js";
import { appendThreadMessage, createThread, getThread } from "../packages/core/src/threads.js";
import { doctorCodexGenerationResources } from "../packages/core/src/runtime-leases.js";

test("current Codex generation accepts runtime-only identity and fails closed on conflicting fields", () => {
  assert.equal(currentCodexGeneration({ runtime: { codexThreadId: "generation-runtime" } }), "generation-runtime");
  assert.deepEqual(resolveCurrentCodexGeneration({
    runtime: { codexThreadId: "generation-new" },
    executor: { codexThreadId: "generation-old", metadata: { codexThreadId: "generation-old" } },
    codexThreadId: "generation-old",
  }), {
    generation: "",
    consistent: false,
    ambiguous: true,
    fields: {
      runtime: "generation-new",
      executor: "generation-old",
      root: "generation-old",
      metadata: "generation-old",
    },
    generations: ["generation-new", "generation-old"],
  });
});

test("live Codex lookup maps a runtime-only current generation and rejects a superseded conflicting ID", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-generation-lookup-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "runtime-only-generation-thread",
    name: "Runtime-only generation",
    runtime: { codexThreadId: "generation-runtime-only" },
  }, env);
  await createThread({
    id: "conflicting-generation-thread",
    name: "Conflicting generation",
    codexThreadId: "generation-old",
    executor: { codexThreadId: "generation-old", metadata: { codexThreadId: "generation-old" } },
    runtime: { codexThreadId: "generation-new" },
  }, env);

  assert.equal((await threadForCodexThreadId("generation-runtime-only", env))?.id, "runtime-only-generation-thread");
  assert.equal(await threadForCodexThreadId("generation-old", env), null);
  assert.equal(await threadForCodexThreadId("generation-new", env), null);
});

test("generation transition clears every rollout cursor and mirrors the replacement identity", () => {
  const patch = codexGenerationTransitionPatch({
    codexThreadId: "generation-old",
    codexRolloutPath: "/old/root.jsonl",
    executor: {
      codexThreadId: "generation-old",
      metadata: { codexThreadId: "generation-old", codexRolloutPath: "/old/executor.jsonl", retained: true },
    },
    runtime: {
      codexThreadId: "generation-old",
      operatorRolloutPath: "/old/runtime.jsonl",
      operatorRolloutGeneration: "generation-old",
      operatorRolloutOffset: 123,
      operatorRolloutSyncedAt: "2026-08-09T00:00:00.000Z",
      operatorRolloutSyncError: "stale",
      retained: true,
    },
  }, "generation-new", "session-new");

  assert.equal(patch.codexThreadId, "generation-new");
  assert.equal(patch.executor.codexThreadId, "generation-new");
  assert.equal(patch.executor.metadata.codexThreadId, "generation-new");
  assert.equal(patch.runtime.codexThreadId, "generation-new");
  assert.equal(patch.codexRolloutPath, null);
  assert.equal(patch.executor.metadata.codexRolloutPath, undefined);
  assert.equal(patch.runtime.operatorRolloutPath, undefined);
  assert.equal(patch.runtime.operatorRolloutOffset, undefined);
  assert.equal(patch.runtime.operatorRolloutSyncedAt, undefined);
  assert.equal(patch.runtime.retained, true);
});

test("rollout identity inspection uses bounded session metadata and rejects missing, malformed, and wrong generations", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-rollout-lineage-"));
  const valid = path.join(home, "valid.jsonl");
  const missing = path.join(home, "missing.jsonl");
  const malformed = path.join(home, "malformed.jsonl");
  await fs.writeFile(valid, [
    JSON.stringify({ type: "session_meta", payload: { id: "generation-current" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] } }),
  ].join("\n") + "\n");
  await fs.writeFile(missing, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "old" } }) + "\n");
  await fs.writeFile(malformed, "{not-json}\n");

  assert.equal((await inspectRolloutIdentity(valid, { maxBytes: 1024 })).generation, "generation-current");
  assert.equal((await inspectRolloutIdentity(valid, { maxBytes: 1024 })).bytesRead <= 1024, true);
  assert.equal((await inspectRolloutIdentity(missing)).reason, "codex_rollout_session_meta_missing");
  assert.equal((await inspectRolloutIdentity(malformed)).reason, "codex_rollout_session_meta_malformed");
  assert.equal((await verifyRolloutGeneration(valid, "generation-old")).reason, "codex_rollout_generation_mismatch");
  assert.equal((await verifyRolloutGeneration(valid, "generation-current")).ok, true);
});

test("Codex generation doctor retains a verified legacy cursor, backfills final delivery, and is idempotent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-generation-doctor-"));
  const env = { ORKESTR_HOME: path.join(home, "orkestr") };
  const generation = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const rolloutPath = path.join(home, "rollout.jsonl");
  await fs.writeFile(rolloutPath, JSON.stringify({ type: "session_meta", payload: { id: generation } }) + "\n");
  await createThread({
    id: "generation-doctor-thread",
    name: "Generation doctor",
    codexThreadId: generation,
    codexRolloutPath: rolloutPath,
    executor: { transport: "app-server", codexThreadId: generation, metadata: { codexThreadId: generation, codexRolloutPath: rolloutPath } },
    runtime: { runtimeKind: "codex-app-server", codexThreadId: generation, operatorRolloutPath: rolloutPath, operatorRolloutOffset: 5, lastTurnId: "turn-doctor", lastTurnStatus: "completed" },
    binding: { connector: "whatsapp", chatId: "chat-doctor", responderAccountId: "sender" },
  }, env);
  const final = await appendThreadMessage("generation-doctor-thread", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    text: "Recovered final",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-doctor",
    accountId: "sender",
    codexThreadId: generation,
    codexTurnId: "turn-doctor",
  }, env);

  const before = await doctorCodexGenerationResources({ env, repair: false });
  assert.equal(before.issues.some((issue) => issue.code === "codex_rollout_generation_mismatch"), true);
  assert.equal(before.issues.some((issue) => issue.code === "final_message_missing_outbox"), true);

  const repaired = await doctorCodexGenerationResources({ env, repair: true });
  const stored = await getThread("generation-doctor-thread", env);
  assert.equal(repaired.actions.some((action) => action.action === "rebound_codex_rollout"), true);
  assert.equal(repaired.actions.some((action) => action.action === "backfilled_final_delivery"), true);
  assert.equal(stored.runtime.operatorRolloutGeneration, generation);
  assert.equal(stored.runtime.operatorRolloutOffset, 5);
  assert.equal(stored.runtime.finalDelivery.messageId, final.id);

  const second = await doctorCodexGenerationResources({ env, repair: true });
  assert.equal(second.actions.length, 0);
  assert.equal(second.issues.length, 0);
});
