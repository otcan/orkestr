import assert from "node:assert/strict";
import test from "node:test";
import { remoteLayerFooter, remoteLayerMetadata } from "../packages/connectors/src/whatsapp-remote-footer.js";
import { appendWhatsAppDebugFooter, stripWhatsAppDebugFooter, whatsappDebugFooter } from "../packages/connectors/src/whatsapp-formatting.js";
import { normalizedDeliveryText } from "../packages/connectors/src/whatsapp-delivery-ledger.js";

// One footer spec for every model reply (see whatsappDebugFooter):
//   ⚡ Quick: <provider model | —> · 🧠 Deep|Coordinator: <provider model | pending | —> · ▶ <writer>
const LAYER_LINE = /^⚡ Quick: [^·\n]+ · 🧠 (?:Deep|Coordinator): [^·\n]+ · ▶ (?:Quick|Deep|Coordinator|Post)$/;
const env = { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" };
const quotaThread = { whatsAppDebugProviderQuota: {
  codex: { weeklyRemainingPct: 80 },
  claude: { fiveHourRemainingPct: 90, weeklyRemainingPct: 70 },
} };

const scope = { role: "assistant", remoteBackend: "example", remoteThreadId: "example-thread", remoteOriginalInputId: "input-one", remoteMessageId: "export-one" };
const fast = { ...scope, id: "fast", remoteLayer: "fast", remoteProvider: "codex", remoteModel: "gpt-example-mini", remoteObservedReasoningEffort: "low" };
const deep = { ...scope, id: "deep", remoteLayer: "deep", remoteProvider: "codex", remoteModel: "gpt-example", remoteObservedReasoningEffort: "high" };
const coordinator = { ...scope, id: "post", remoteLayer: "coordinator", remoteProvider: "claude", remoteModel: "opus-5.5", remoteIdentitySource: "post" };

function footerLines(message, messages = [], thread = quotaThread, deliveryType = "final") {
  return whatsappDebugFooter({ message, messages, thread, deliveryType, env }).split("\n");
}

function assertSpec(lines, layerLine) {
  assert.equal(lines[0], layerLine);
  assert.match(lines[0], LAYER_LINE);
  assert.deepEqual(lines.slice(1, 3), ["codex wk: 80%", "claude 5h: 90% wk: 70%"]);
  assert.match(lines[3], /^q:\d+ · load:\d+% · api:\d+% · help:\/help$/);
  assert.equal(lines.length, 4);
}

test("Quick reply: its own identity, Deep pending, writer Quick", () => {
  assertSpec(footerLines(fast), "⚡ Quick: codex gpt-example-mini/low · 🧠 Deep: pending · ▶ Quick");
  assertSpec(footerLines(fast, [fast, deep]), "⚡ Quick: codex gpt-example-mini/low · 🧠 Deep: codex gpt-example/high · ▶ Quick");
});

test("Deep final: the input's Quick and its own identity, writer Deep", () => {
  assertSpec(footerLines(deep, [fast, deep]), "⚡ Quick: codex gpt-example-mini/low · 🧠 Deep: codex gpt-example/high · ▶ Deep");
});

test("Deep final whose Quick V1 cannot correlate uses the adapter-reported Quick", () => {
  // A grouped or parallel final names the burst's last input; the adapter
  // reports the Quick run itself, so the Quick line is never silently dropped.
  const imported = remoteLayerMetadata({ layer: "deep", phase: "final_answer", sourceInputId: "input-last", quoteSource: true,
    quickProvider: "codex", quickModel: "gpt-example-mini", quickObservedReasoningEffort: "low" });
  assert.deepEqual(imported, { remoteLayer: "deep", remoteOriginalInputId: "input-last", remoteQuickProvider: "codex",
    remoteQuickModel: "gpt-example-mini", remoteQuickEffort: "low", remoteQuoteSource: true });
  const grouped = { ...deep, ...imported };
  assertSpec(footerLines(grouped, [fast]), "⚡ Quick: codex gpt-example-mini/low · 🧠 Deep: codex gpt-example/high · ▶ Deep");
});

test("Deep final with no Quick run (timer, health probe, Fast off) keeps the Quick slot as —", () => {
  const timer = { ...deep, ...remoteLayerMetadata({ layer: "deep", phase: "final_answer", quick: "none" }) };
  assert.equal(timer.remoteQuickState, "none");
  assertSpec(footerLines(timer, [fast]), "⚡ Quick: — · 🧠 Deep: codex gpt-example/high · ▶ Deep");
  // An older adapter without the field: no correlated Quick also reads —.
  assertSpec(footerLines({ ...deep, remoteOriginalInputId: undefined }, [fast]), "⚡ Quick: — · 🧠 Deep: codex gpt-example/high · ▶ Deep");
});

test("timer answer delivered as timer_reply carries the same model-reply footer", () => {
  const timer = { ...deep, remoteQuickState: "none" };
  assertSpec(footerLines(timer, [], quotaThread, "timer_reply"), "⚡ Quick: — · 🧠 Deep: codex gpt-example/high · ▶ Deep");
});

test("coordinator post: its declared post identity, never the native Deep", () => {
  assertSpec(footerLines(coordinator, [fast, deep, coordinator]), "⚡ Quick: codex gpt-example-mini/low · 🧠 Coordinator: claude opus-5.5 · ▶ Coordinator");
  assertSpec(footerLines({ ...coordinator, remoteOriginalInputId: undefined }), "⚡ Quick: — · 🧠 Coordinator: claude opus-5.5 · ▶ Coordinator");
  const old = { ...coordinator, remoteIdentitySource: undefined, remoteProvider: "codex", remoteModel: "unreported" };
  assert.equal(remoteLayerFooter(old, [fast, deep]), "⚡ Quick: codex gpt-example-mini/low · 🧠 Coordinator: — · ▶ Coordinator");
  assert.deepEqual(remoteLayerMetadata({ provider: "codex", model: "unreported" }, { postAuthor: "coordinator" }), { remoteLayer: "coordinator", remoteProvider: null, remoteModel: null });
  assert.deepEqual(remoteLayerMetadata({ phase: "final_answer", provider: "codex", model: "native-deep" }, { timerId: "post", postAuthor: "coordinator" }), { remoteLayer: "coordinator", remoteProvider: null, remoteModel: null });
});

test("a native question is the Deep run's own post; any other post is writer Post, never Deep", () => {
  const question = remoteLayerMetadata({ layer: "deep", identitySource: "run", runId: "run-one", sourceInputId: "input-one" }, { timerId: "post", postAuthor: "assistant_question" });
  assert.equal(question.remoteLayer, "deep");
  assert.equal(remoteLayerFooter({ ...deep, ...question }, [fast]), "⚡ Quick: codex gpt-example-mini/low · 🧠 Deep: codex gpt-example/high · ▶ Deep");
  assert.deepEqual(remoteLayerMetadata({ phase: "final_answer" }, { timerId: "post" }), { remoteLayer: "post" });
  assert.equal(remoteLayerFooter({ ...scope, remoteLayer: "post", remoteProvider: "claude", remoteModel: "opus-5.5" }), "⚡ Quick: — · 🧠 Deep: claude opus-5.5 · ▶ Post");
});

test("a provider without a reported model keeps the slot shape and never prints unknown or settings", () => {
  const message = { ...deep, remoteModel: "unreported", remoteObservedReasoningEffort: undefined, model: "configured-wrong", codexReasoningEffort: "xhigh" };
  const footer = whatsappDebugFooter({ message, thread: { codexModel: "thread-wrong", codexReasoningEffort: "xhigh" }, env: { OPENAI_MODEL: "env-wrong" } });
  assert.match(footer, /^⚡ Quick: — · 🧠 Deep: codex \? · ▶ Deep\n/);
  assert.doesNotMatch(footer, /unknown|configured-wrong|thread-wrong|env-wrong|xhigh/);
  assert.equal(remoteLayerFooter({ ...scope, remoteLayer: "deep" }), "⚡ Quick: — · 🧠 Deep: — · ▶ Deep");
});

test("adapter refusal notices are notices: quota and q/load lines only", () => {
  const imported = remoteLayerMetadata({ kind: "notice", source: "rust-v2-adapter", phase: "final_answer" });
  assert.deepEqual(imported, { remoteLayer: "notice" });
  const notice = { ...scope, id: "notice", ...imported, remoteProvider: "codex", remoteModel: "unreported" };
  const lines = footerLines(notice, [fast]);
  assert.deepEqual(lines.slice(0, 2), ["codex wk: 80%", "claude 5h: 90% wk: 70%"]);
  assert.match(lines[2], /^q:\d+ · load:/);
  assert.equal(lines.length, 3);
  assert.equal(remoteLayerFooter(fast, [notice]), "⚡ Quick: codex gpt-example-mini/low · 🧠 Deep: pending · ▶ Quick");
  assert.deepEqual(remoteLayerMetadata({ kind: "notice", phase: "final_answer", layer: "deep" }), { remoteLayer: "notice" });
  assert.deepEqual(remoteLayerMetadata({ kind: "notice", firstResponse: true }), { remoteLayer: "fast" });
});

test("a Claude conversation uses the two distinct observed Claude runs", () => {
  const quick = { ...fast, remoteProvider: "claude", remoteModel: "haiku-example", remoteObservedReasoningEffort: undefined };
  const final = { ...deep, remoteProvider: "claude", remoteModel: "opus-example", remoteObservedReasoningEffort: "medium" };
  assert.equal(remoteLayerFooter(final, [quick]), "⚡ Quick: claude haiku-example · 🧠 Deep: claude opus-example/medium · ▶ Deep");
});

test("foreign inputs/runtime scopes and conflicting peer evidence cannot fill a layer", () => {
  for (const foreign of [{ ...fast, remoteOriginalInputId: "another-input" }, { ...fast, remoteBackend: "other" }, { ...fast, remoteThreadId: "other" }]) {
    assert.equal(remoteLayerFooter(deep, [foreign]), "⚡ Quick: — · 🧠 Deep: codex gpt-example/high · ▶ Deep");
  }
  assert.equal(remoteLayerFooter(deep, [fast, { ...fast, id: "other", remoteModel: "conflict" }]), "⚡ Quick: — · 🧠 Deep: codex gpt-example/high · ▶ Deep");
});

test("V1-native reply uses the same layer line with Quick —", () => {
  const local = { role: "assistant", source: "codex-app-server", phase: "final_answer" };
  const lines = footerLines(local, [], { ...quotaThread, codexModel: "gpt-example", codexReasoningEffort: "low" });
  assertSpec(lines, "⚡ Quick: — · 🧠 Deep: codex gpt-example/l · ▶ Deep");
});

test("footers strip idempotently and every model reply has exactly one layer line", () => {
  const options = { message: deep, messages: [fast], env };
  const text = appendWhatsAppDebugFooter("Answer", options);
  assert.equal(stripWhatsAppDebugFooter(text), "Answer");
  assert.equal(normalizedDeliveryText(text), "Answer");
  assert.equal((appendWhatsAppDebugFooter(text, options).match(/⚡ Quick:/g) || []).length, 1);
  assert.match(text, /\nq:0 · load:\d+% · api:\d+% · help:\/help$/);
});

test("only explicitly observed remote effort and original identities are imported", () => {
  assert.deepEqual(remoteLayerMetadata({ phase: "final_answer" }), { remoteLayer: "deep" });
  assert.deepEqual(remoteLayerMetadata({ firstResponse: true, reasoningEffort: "xhigh", model: "configured", quickModel: "ignored" }), { remoteLayer: "fast" });
  assert.deepEqual(remoteLayerMetadata({ layer: "deep", sourceInputId: "input-one", runId: "run-one", observedReasoningEffort: "low", identitySource: "run", quickModel: "unreported" }), {
    remoteLayer: "deep", remoteOriginalInputId: "input-one", remoteRunId: "run-one", remoteObservedReasoningEffort: "low", remoteIdentitySource: "run",
  });
});
