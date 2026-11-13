import assert from "node:assert/strict";
import test from "node:test";
import { singleAgentFooter } from "../packages/connectors/src/whatsapp-agent-footer.js";
import { stripWhatsAppDebugFooter, whatsappDebugFooter } from "../packages/connectors/src/whatsapp-formatting.js";

test("the single reply producer supplies identity without sibling Fast context", () => {
  const message = { remoteProvider: "codex", remoteModel: "example-model", remoteObservedReasoningEffort: "high",
    remoteQuickProvider: "claude", remoteQuickModel: "unrelated-model", remoteLayer: "deep" };
  assert.equal(singleAgentFooter(message), "🤖 codex example-model high");
  delete message.remoteModel;
  assert.equal(singleAgentFooter(message), "🤖 codex high");
  assert.equal(singleAgentFooter({}), "🤖 Agent");
  assert.equal(singleAgentFooter({ remoteModel: "pending" }), "🤖 Agent");
});

test("unverified coordinator identities and control characters are never substituted", () => {
  assert.equal(singleAgentFooter({ remoteLayer: "coordinator", remoteProvider: "codex", remoteModel: "example" }), "🤖 Agent");
  assert.equal(singleAgentFooter({ remoteProvider: "codex\nforged", remoteModel: "example" }), "🤖 example");
});

test("new and historical footers are stripped before appending one footer", () => {
  const old = "⚡ Quick: codex old · 🧠 Deep: codex example · ▶ Deep\ncodex wk: 50%\nclaude: no data\nq:0 · help:/help";
  const next = "🤖 codex example\ncodex wk: 50%\nclaude: no data\nq:0 · help:/help";
  assert.equal(stripWhatsAppDebugFooter(`Answer\n\n${old}\n\n${next}`), "Answer");
  assert.equal(stripWhatsAppDebugFooter("Answer mentions 🤖 within a sentence."), "Answer mentions 🤖 within a sentence.");
});

test("a remote progress export reads as an update on every delivery path (ORK-819)", () => {
  const env = { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" };
  const message = { role: "assistant", remoteMessageId: "remote-1", remoteProvider: "codex", remoteModel: "example-model", remoteKind: "progress" };
  assert.match(whatsappDebugFooter({ message, deliveryType: "final", env }), /^🤖 codex example-model · msg:\*update\*\n/);
  assert.match(whatsappDebugFooter({ message: { ...message, remoteKind: undefined }, deliveryType: "final", env }), /^🤖 codex example-model · msg:\*final\*\n/);
  assert.match(whatsappDebugFooter({ message: { ...message, remoteKind: undefined }, deliveryType: "progress", env }), /^🤖 codex example-model · msg:\*update\*\n/);
});
