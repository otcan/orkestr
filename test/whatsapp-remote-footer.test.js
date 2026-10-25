import assert from "node:assert/strict";
import test from "node:test";
import { remoteLayerFooter, remoteLayerMetadata } from "../packages/connectors/src/whatsapp-remote-footer.js";
import { appendWhatsAppDebugFooter, stripWhatsAppDebugFooter, whatsappDebugFooter } from "../packages/connectors/src/whatsapp-formatting.js";
import { normalizedDeliveryText } from "../packages/connectors/src/whatsapp-delivery-ledger.js";

const scope = { role: "assistant", remoteBackend: "example", remoteThreadId: "example-thread", remoteOriginalInputId: "input-one", remoteMessageId: "export-one" };
const fast = { ...scope, id: "fast", remoteLayer: "fast", remoteProvider: "codex", remoteModel: "gpt-example-mini", remoteObservedReasoningEffort: "low" };
const deep = { ...scope, id: "deep", remoteLayer: "deep", remoteProvider: "codex", remoteModel: "gpt-example", remoteObservedReasoningEffort: "high" };
const coordinator = { ...scope, id: "post", remoteLayer: "coordinator", remoteProvider: "claude", remoteModel: "opus-5.5", remoteIdentitySource: "post" };

test("a Fast message shows its own identity and only a correlated observed Deep", () => {
  assert.equal(remoteLayerFooter(fast, [fast, deep]), "⚡ Quick: codex gpt-example-mini/low · 🧠 Deep: codex gpt-example/high · ▶ Quick");
  assert.equal(remoteLayerFooter(fast), "⚡ Quick: codex gpt-example-mini/low · 🧠 Deep: unknown unknown/unknown · ▶ Quick");
});

test("a Deep final shows the original input's Fast and its own writer", () => {
  assert.equal(remoteLayerFooter(deep, [fast, deep]), "⚡ Quick: codex gpt-example-mini/low · 🧠 Deep: codex gpt-example/high · ▶ Deep");
});

test("a coordinator post keeps its declared post identity and never the native Deep", () => {
  assert.equal(remoteLayerFooter(coordinator, [fast, deep, coordinator]), "⚡ Quick: codex gpt-example-mini/low · 🧠 Coordinator: claude opus-5.5/unknown · ▶ Coordinator");
  const old = { ...coordinator, remoteIdentitySource: undefined, remoteProvider: "codex", remoteModel: "unreported" };
  assert.match(remoteLayerFooter(old, [fast, deep]), /Coordinator: unknown unknown\/unknown · ▶ Coordinator$/);
  assert.deepEqual(remoteLayerMetadata({ provider: "codex", model: "unreported" }, { postAuthor: "coordinator" }), { remoteLayer: "coordinator", remoteProvider: null, remoteModel: null });
});

test("unknown model and effort stay unknown despite local configured defaults", () => {
  const message = { ...deep, remoteModel: "unreported", remoteObservedReasoningEffort: undefined, model: "configured-wrong", codexReasoningEffort: "xhigh" };
  const footer = whatsappDebugFooter({ message, thread: { codexModel: "thread-wrong", codexReasoningEffort: "xhigh" }, env: { OPENAI_MODEL: "env-wrong" } });
  assert.match(footer, /🧠 Deep: codex unknown\/unknown · ▶ Deep/);
  assert.doesNotMatch(footer, /configured-wrong|thread-wrong|env-wrong|xhigh/);
});

test("a Claude conversation uses the two distinct observed Claude runs", () => {
  const quick = { ...fast, remoteProvider: "claude", remoteModel: "haiku-example", remoteObservedReasoningEffort: undefined };
  const final = { ...deep, remoteProvider: "claude", remoteModel: "opus-example", remoteObservedReasoningEffort: "medium" };
  assert.equal(remoteLayerFooter(final, [quick]), "⚡ Quick: claude haiku-example/unknown · 🧠 Deep: claude opus-example/medium · ▶ Deep");
});

test("foreign inputs/runtime scopes and conflicting peer evidence cannot fill a layer", () => {
  for (const foreign of [{ ...fast, remoteOriginalInputId: "another-input" }, { ...fast, remoteBackend: "other" }, { ...fast, remoteThreadId: "other" }]) {
    assert.match(remoteLayerFooter(deep, [foreign]), /^⚡ Quick: unknown unknown\/unknown/);
  }
  assert.match(remoteLayerFooter(deep, [fast, { ...fast, id: "other", remoteModel: "conflict" }]), /^⚡ Quick: unknown unknown\/unknown/);
  assert.match(remoteLayerFooter({ ...deep, remoteOriginalInputId: undefined }, [fast]), /^⚡ Quick: unknown unknown\/unknown/);
});

test("new remote footers strip idempotently and preserve the existing quota/load lines", () => {
  const options = { message: deep, messages: [fast], env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" } };
  const text = appendWhatsAppDebugFooter("Answer", options);
  assert.equal(stripWhatsAppDebugFooter(text), "Answer");
  assert.equal(normalizedDeliveryText(text), "Answer");
  assert.equal((appendWhatsAppDebugFooter(text, options).match(/⚡ Quick:/g) || []).length, 1);
  assert.match(text, /\nq:0 · load:\d+% · api:\d+% · help:\/help$/);
});

test("only explicitly observed remote effort and original identities are imported", () => {
  assert.deepEqual(remoteLayerMetadata({ firstResponse: true, reasoningEffort: "xhigh", model: "configured" }), { remoteLayer: "fast" });
  assert.deepEqual(remoteLayerMetadata({ layer: "deep", sourceInputId: "input-one", runId: "run-one", observedReasoningEffort: "low", identitySource: "run" }), {
    remoteLayer: "deep", remoteOriginalInputId: "input-one", remoteRunId: "run-one", remoteObservedReasoningEffort: "low", remoteIdentitySource: "run",
  });
});
