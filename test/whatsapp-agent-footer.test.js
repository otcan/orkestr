import assert from "node:assert/strict";
import test from "node:test";
import { singleAgentFooter } from "../packages/connectors/src/whatsapp-agent-footer.js";
import { stripWhatsAppDebugFooter } from "../packages/connectors/src/whatsapp-formatting.js";

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
