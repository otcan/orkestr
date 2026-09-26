import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodexThreadSettingsCommand } from "../packages/core/src/codex-thread-settings.js";

const models = [
  {
    id: "gpt-main",
    model: "gpt-main",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })),
    serviceTiers: [{ id: "priority", name: "Fast" }],
  },
  {
    id: "gpt-small",
    model: "gpt-small",
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    serviceTiers: [],
  },
];

test("Codex thread settings command reports catalog and validates model effort", () => {
  const status = resolveCodexThreadSettingsCommand({ command: "model", thread: {}, models });
  assert.equal(status.ok, true);
  assert.match(status.replyText, /Model: gpt-main/);
  assert.match(status.replyText, /gpt-small/);

  const invalidModel = resolveCodexThreadSettingsCommand({ command: "model", text: "missing", thread: {}, models });
  assert.equal(invalidModel.ok, false);
  assert.match(invalidModel.error, /Unknown Codex model/);

  const invalidEffort = resolveCodexThreadSettingsCommand({ command: "model", text: "gpt-small high", thread: {}, models });
  assert.equal(invalidEffort.ok, false);
  assert.match(invalidEffort.error, /Unsupported effort/);

  const reset = resolveCodexThreadSettingsCommand({ command: "model", text: "default", thread: { codexModel: "gpt-small" }, models });
  assert.equal(reset.ok, true);
  assert.deepEqual(reset.patch, { codexModel: null, codexReasoningEffort: null });
  assert.equal(reset.runtimePatch.model, "gpt-main");

  const clearsFast = resolveCodexThreadSettingsCommand({ command: "model", text: "gpt-small", thread: { codexModel: "gpt-main", codexServiceTier: "priority" }, models });
  assert.equal(clearsFast.patch.codexServiceTier, null);
  assert.equal(clearsFast.runtimePatch.serviceTier, null);
});

test("Codex fast command toggles, reports, disables, and rejects unsupported models", () => {
  const enabled = resolveCodexThreadSettingsCommand({ command: "fast", text: "toggle", thread: { codexModel: "gpt-main" }, models });
  assert.deepEqual(enabled.patch, { codexServiceTier: "priority" });

  const status = resolveCodexThreadSettingsCommand({ command: "fast", text: "status", thread: { codexModel: "gpt-main", codexServiceTier: "priority" }, models });
  assert.match(status.replyText, /on/);

  const disabled = resolveCodexThreadSettingsCommand({ command: "fast", text: "off", thread: { codexModel: "gpt-main", codexServiceTier: "priority" }, models });
  assert.deepEqual(disabled.runtimePatch, { serviceTier: null });

  const unsupported = resolveCodexThreadSettingsCommand({ command: "fast", text: "on", thread: { codexModel: "gpt-small" }, models });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /does not advertise a fast service tier/);
});

test("bare settings commands report status content without mutation", () => {
  const thread = { codexModel: "gpt-main", codexReasoningEffort: "high", codexServiceTier: "priority" };
  const model = resolveCodexThreadSettingsCommand({ command: "model", text: "", thread, models });
  assert.equal(model.action, "status");
  assert.equal(model.patch, undefined);
  assert.match(model.replyText, /Model: gpt-main · effort: high/);
  assert.match(model.replyText, /Fast: on/);
  assert.match(model.replyText, /- gpt-main \(low\/medium\/high\) · fast/);
  assert.match(model.replyText, /- gpt-small \(low\)/);

  const effort = resolveCodexThreadSettingsCommand({ command: "effort", text: "", thread, models });
  assert.equal(effort.action, "status");
  assert.equal(effort.patch, undefined);
  assert.match(effort.replyText, /Model: gpt-main · effort: high/);
  assert.match(effort.replyText, /Supported efforts: low, medium, high/);

  const fast = resolveCodexThreadSettingsCommand({ command: "fast", text: "", thread, models });
  assert.equal(fast.action, "status");
  assert.equal(fast.patch, undefined);
  assert.match(fast.replyText, /Fast mode is on/);
});

test("effort setter validates the current catalog entry and rejects malformed arguments", () => {
  const thread = { codexModel: "gpt-small" };
  assert.deepEqual(resolveCodexThreadSettingsCommand({ command: "EFFORT", text: "LOW", thread, models }).runtimePatch, { model: "gpt-small", effort: "low" });
  assert.match(resolveCodexThreadSettingsCommand({ command: "effort", text: "high", thread, models }).error, /Unsupported effort for gpt-small/);
  assert.equal(resolveCodexThreadSettingsCommand({ command: "effort", text: "low extra", thread, models }).ok, false);
  assert.equal(resolveCodexThreadSettingsCommand({ command: "model", text: "gpt-main high extra", thread, models }).ok, false);
  assert.equal(resolveCodexThreadSettingsCommand({ command: "fast", text: "sometimes", thread, models }).ok, false);
  assert.match(resolveCodexThreadSettingsCommand({ command: "effort", text: "low", thread: { codexModel: "retired-model" }, models }).error, /current model is unavailable/);
});
