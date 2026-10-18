import assert from "node:assert/strict";
import test from "node:test";
import { codexContextOverrides } from "../packages/core/src/codex-context-policy.js";
import { threadStartParams, turnStartParams } from "../packages/core/src/codex-app-server-common.js";

test("context budget uses native compaction without changing model or effort", () => {
  const env = { ORKESTR_CODEX_AUTO_COMPACT_TOKEN_LIMIT: "131072" };
  const thread = { codexModel: "gpt-6-astra", codexReasoningEffort: "high" };
  const start = threadStartParams(thread, env);
  assert.deepEqual(start.config, { model_auto_compact_token_limit: 131072 });
  assert.equal(start.model, "gpt-6-astra");
  const turn = turnStartParams(thread, { text: "Continue the task" }, env);
  assert.equal(turn.model, "gpt-6-astra");
  assert.equal(turn.effort, "high");
  assert.equal(turn.config, undefined, "turn/start has no config override in the native protocol");
});

test("unset, disabled and malformed limits preserve Codex's own configuration", () => {
  for (const raw of [undefined, "", "0", "-1", "NaN", "100", "12000.5", "Infinity"]) {
    assert.deepEqual(codexContextOverrides({}, { ORKESTR_CODEX_AUTO_COMPACT_TOKEN_LIMIT: raw }), {});
  }
});

test("a thread may override or opt out of its host context budget", () => {
  const env = { ORKESTR_CODEX_AUTO_COMPACT_TOKEN_LIMIT: "131072" };
  assert.deepEqual(codexContextOverrides({ codexAutoCompactTokenLimit: 180000 }, env), { config: { model_auto_compact_token_limit: 180000 } });
  assert.deepEqual(codexContextOverrides({ codexAutoCompactTokenLimit: 0 }, env), {});
});
