import assert from "node:assert/strict";
import test from "node:test";
import {
  codexFallbackModels,
  codexModelCandidates,
  compatibleCodexReasoningEffort,
  defaultCodexModel,
  resolveCodexModelForCatalog,
} from "../packages/core/src/codex-model-policy.js";
import { codexModelRoleForThread, modelForThread } from "../packages/core/src/codex-app-server-common.js";

test("Codex model policy assigns GPT-6 tiers by workload role", () => {
  assert.equal(defaultCodexModel("standard"), "gpt-6-sol");
  assert.equal(defaultCodexModel("demanding"), "gpt-6-astra");
  assert.equal(defaultCodexModel("lightweight"), "gpt-6-luna");
  assert.deepEqual(codexFallbackModels("standard"), ["gpt-5.6-sol"]);
  assert.deepEqual(codexFallbackModels("lightweight"), ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
});

test("Codex model policy follows catalog rollout and retains GPT-5.6 fallbacks", () => {
  assert.equal(
    resolveCodexModelForCatalog("standard", [{ id: "gpt-6-sol" }, { id: "gpt-5.6-sol" }]),
    "gpt-6-sol",
  );
  assert.equal(
    resolveCodexModelForCatalog("standard", [{ id: "gpt-6.1-sol" }, { id: "gpt-6-sol" }]),
    "gpt-6.1-sol",
  );
  assert.equal(
    resolveCodexModelForCatalog("standard", [{ id: "gpt-5.6-sol" }]),
    "gpt-5.6-sol",
  );
  assert.equal(
    resolveCodexModelForCatalog("lightweight", [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6-sol" }]),
    "gpt-5.6-terra",
  );
  assert.equal(
    resolveCodexModelForCatalog("standard", [{ id: "provider-default", isDefault: true }]),
    "provider-default",
  );
  assert.deepEqual(codexModelCandidates("standard"), ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"]);
});

test("Codex model policy preserves explicit pins and routes unpinned thread roles", () => {
  const env = {};
  assert.equal(modelForThread({}, env), "gpt-6-sol");
  assert.equal(modelForThread({ threadKind: "worker" }, env), "gpt-6-luna");
  assert.equal(modelForThread({ threadKind: "task-agent", agentProfileId: "sre_engineer" }, env), "gpt-6-astra");
  assert.equal(modelForThread({ threadKind: "worker", codexModel: "gpt-5.6-sol" }, env), "gpt-5.6-sol");
  assert.equal(modelForThread({}, { ORKESTR_DEFAULT_CODEX_MODEL: "operator-pinned" }), "operator-pinned");
  assert.equal(codexModelRoleForThread({ threadKind: "worker" }), "lightweight");
  assert.equal(codexModelRoleForThread({ threadKind: "task-agent", agentProfileId: "sre_engineer" }), "demanding");
});

test("Codex model policy normalizes reasoning settings that GPT-6.1 Sol and Astra reject", () => {
  assert.equal(compatibleCodexReasoningEffort("gpt-6.1-sol", "none"), "low");
  assert.equal(compatibleCodexReasoningEffort("gpt-6-astra", "minimal"), "low");
  assert.equal(compatibleCodexReasoningEffort("gpt-6-sol", "none"), "none");
  assert.equal(compatibleCodexReasoningEffort("gpt-6-luna", "none"), "none");
  assert.equal(compatibleCodexReasoningEffort("gpt-6.1-sol", "high"), "high");
});
