import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexMetadataUpdatePatch, explicitCodexSettings, persistObservedCodexMetadata } from "../packages/core/src/codex-observed-metadata.js";
import { createThread, getThread, updateThread } from "../packages/core/src/threads.js";
import { withCanonicalPublicReferenceLock } from "../packages/core/src/canonical-public-reference-lock.js";
import { threadRuntimeSummary } from "../apps/server/src/thread-summary.ts";

const at = "2026-09-01T12:00:00.000Z";
const settings = { codexModel: "gpt-configured", codexReasoningEffort: "high", codexServiceTier: null, codexModelUpdatedAt: at };
const observed = { codexModel: "gpt-old", codexReasoningEffort: "low", codexServiceTier: "priority", codexTokenUsage: { total_tokens: 42 } };

test("historical metadata preserves explicit settings and fresh usage across repeated refreshes", () => {
  let thread = { ...settings, executor: { metadata: { ...observed } } };
  for (let scan = 0; scan < 3; scan++) {
    thread = { ...thread, ...codexMetadataUpdatePatch(thread, observed) };
    for (const [key, value] of Object.entries(settings)) {
      assert.equal(thread[key], value);
      assert.equal(thread.executor.metadata[key], value);
    }
    assert.deepEqual(thread.codexTokenUsage, observed.codexTokenUsage);
  }
});

test("reset-to-default cannot resurrect old model, effort, or fast tier", () => {
  const reset = { ...settings, codexModel: null, codexReasoningEffort: null };
  const patch = codexMetadataUpdatePatch({ ...reset, executor: { metadata: observed } }, observed);
  for (const key of ["codexModel", "codexReasoningEffort", "codexServiceTier"]) {
    assert.equal(patch[key], null);
    assert.equal(patch.executor.metadata[key] ?? null, null);
  }
});

test("legacy observations still work; newest valid explicit snapshot wins", () => {
  assert.equal(codexMetadataUpdatePatch({}, observed).codexModel, observed.codexModel);
  assert.deepEqual(explicitCodexSettings({ codexModelUpdatedAt: "invalid" }), {});
  assert.deepEqual(explicitCodexSettings({ executor: { metadata: settings } }), settings);
  assert.deepEqual(explicitCodexSettings({ ...observed, codexModelUpdatedAt: "2026-08-01T00:00:00Z", executor: { metadata: settings } }), settings);
  assert.deepEqual(explicitCodexSettings({ ...settings, executor: { metadata: { ...observed, codexModelUpdatedAt: at } } }), settings);
});

test("metadata sanitation still drops corrupt model/provider values", () => {
  const patch = codexMetadataUpdatePatch({ codexModel: "/tmp/history.jsonl", codexModelProvider: "/tmp/history.jsonl" }, { codexReasoningEffort: "invalid" });
  assert.equal(patch.codexModel, null);
  assert.equal(patch.codexModelProvider, null);
  assert.equal(patch.executor.metadata.codexReasoningEffort, undefined);
});

test("summary uses explicit settings instead of stale live model metadata", async () => {
  const codexThreadId = "88888888-8888-4888-8888-888888888888";
  for (const snapshot of [settings, { ...settings, codexModel: null, codexReasoningEffort: null }]) {
    const summary = await threadRuntimeSummary({
      id: "model-summary-test", name: "Model Summary Test", state: "ready",
      runtimeKind: "codex-app-server", codexThreadId, ...snapshot,
      executor: { type: "codex", transport: "app-server", codexThreadId, metadata: observed },
    }, [], { cacheTtlMs: 0, sampleRuntime: false, codexMetadataById: new Map([[codexThreadId, observed]]) });
    assert.notEqual(summary.codexModel, observed.codexModel);
    if (snapshot.codexModel) assert.equal(summary.codexModel, snapshot.codexModel);
    if (snapshot.codexReasoningEffort) assert.equal(summary.codexReasoningEffort, snapshot.codexReasoningEffort);
    assert.equal(summary.codexServiceTier, null);
    assert.equal(summary.codexModelUpdatedAt, at);
  }
});

test("slow metadata refresh reads the latest settings under the mutation lock", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-observed-metadata-"));
  const env = { ...process.env, ORKESTR_HOME: home };
  const thread = await createThread({ id: "metadata-race-test", name: "Metadata Race Test", ...observed }, env);
  let release, entered;
  const held = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const command = withCanonicalPublicReferenceLock(async () => {
    entered();
    await gate;
    await updateThread(thread.id, settings, env);
  }, env);
  await held;
  const refresh = persistObservedCodexMetadata(thread.id, observed, env);
  release();
  await Promise.all([command, refresh]);
  const result = await getThread(thread.id, env);
  assert.equal(result.codexModel, settings.codexModel);
  assert.equal(result.codexReasoningEffort, settings.codexReasoningEffort);
  assert.equal(result.executor.metadata.codexModel, settings.codexModel);
  assert.deepEqual(result.codexTokenUsage, observed.codexTokenUsage);
});
