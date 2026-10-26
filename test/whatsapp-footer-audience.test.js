import assert from "node:assert/strict";
import test from "node:test";
import * as formatter from "../packages/connectors/src/whatsapp-formatting.js";
import { scopedGroupReplyChunks } from "../packages/connectors/src/whatsapp-scoped-group-formatting.js";
import { memberAuthoredInput, threadHasNonOwnerMembers } from "../packages/connectors/src/whatsapp-footer-audience.js";

const { appendWhatsAppDebugFooter } = formatter;
const env = { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" };
const owner = ["owner-phone@c.us", "owner-lid@lid"];
const ownerOnly = { id: "t-owner", binding: { chatId: "group-a@g.us", allowOtherPeople: true, ownerContactIds: owner, authorizedContactIds: owner } };
const shared = { id: "t-shared", binding: { ...ownerOnly.binding, authorizedContactIds: [...owner, "member-phone@c.us"] } };
const scope = { role: "assistant", source: "rust-v2-adapter", remoteBackend: "example", remoteThreadId: "remote-thread", remoteOriginalInputId: "input-1", remoteMessageId: "export-1", parentMessageId: "local-input" };
const fast = { ...scope, id: "fast", remoteLayer: "fast", remoteProvider: "codex", remoteModel: "example-luna", remoteObservedReasoningEffort: "low" };
const ownerInput = { id: "local-input", role: "user", remoteMessageId: "input-1", senderEffectiveRole: "owner", senderTrustLevel: "owner" };
const memberInput = { ...ownerInput, senderParticipantId: "member-lid@lid", senderEffectiveRole: "trusted", senderTrustLevel: "trusted", senderPolicyMode: "this-thread-only" };
const footerPattern = /⚡|🧠|▶|codex wk|claude|q:\d|load:|api:|help:\/help/;

test("an owner-only chat gets the compact footer with the observed Quick model and effort", () => {
  const text = appendWhatsAppDebugFooter("Answer", { env, thread: ownerOnly, message: fast, messages: [ownerInput, fast] });
  assert.match(text, /^Answer\n\n⚡ Quick: codex example-luna\/low · 🧠 Deep: pending · ▶ Quick\n/);
  assert.match(text, /\nq:0 · load:\d+% · api:\d+% · help:\/help$/);
  assert.doesNotMatch(text, /unknown/);
});

test("a chat with a non-owner participant never gets the footer, quota or load", () => {
  assert.equal(threadHasNonOwnerMembers(shared), true);
  assert.equal(threadHasNonOwnerMembers(ownerOnly), false);
  assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: shared, message: fast, messages: [ownerInput] }), "Answer");
  const extra = { ...ownerOnly, binding: { ...ownerOnly.binding, additionalParticipantsEnabled: true, additionalParticipantIds: ["member-lid@lid"] } };
  assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: extra, message: fast }), "Answer");
  // A census-verified non-owner WA member the binding does not name.
  const census = { ...ownerOnly, binding: { ...ownerOnly.binding, whatsappNonOwnerMembers: true } };
  assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: census, message: fast }), "Answer");
  // Unknown owner identities fail closed.
  const unverified = { ...ownerOnly, binding: { ...ownerOnly.binding, ownerContactIds: [] } };
  assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: unverified, message: fast }), "Answer");
});

test("a reply to a member-authored input never gets the footer, even in an owner-bound chat", () => {
  assert.equal(memberAuthoredInput(memberInput), true);
  assert.equal(memberAuthoredInput(ownerInput), false);
  assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: ownerOnly, message: fast, messages: [memberInput] }), "Answer");
  // Matched through the remote original input when the local parent differs.
  const viaRemote = { ...fast, parentMessageId: "timer-parent" };
  assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: ownerOnly, message: viaRemote, messages: [memberInput] }), "Answer");
  assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: ownerOnly, message: { ...fast, parentMessageId: "x", remoteOriginalInputId: "y" }, messages: [{ ...memberInput, originOwner: false, senderPolicyMode: "", senderEffectiveRole: "", senderTrustLevel: "", id: "x" }] }), "Answer");
});

test("notices never carry a footer", () => {
  const notice = { ...scope, id: "notice", remoteLayer: "notice" };
  assert.equal(appendWhatsAppDebugFooter("Sorry, please send it again.", { env, thread: ownerOnly, message: notice, messages: [ownerInput, fast] }), "Sorry, please send it again.");
  const failure = { role: "assistant", source: "codex-app-server", phase: "final_answer" };
  assert.equal(appendWhatsAppDebugFooter("Delivery failed.", { env, thread: ownerOnly, message: failure, deliveryType: "delivery_error" }), "Delivery failed.");
});

test("the scoped group relay applies the same audience rules", () => {
  const chunk = (thread, message, messages) => scopedGroupReplyChunks({ text: "Done", deliveryType: "final", message: { ...message, chatId: "group-a@g.us" },
    thread, messages, config: { appendDebugFooter: true }, formatter, env: {} });
  assert.match(chunk(ownerOnly, fast, [ownerInput])[0], /^Done\n\n⚡ Quick: codex example-luna\/low/);
  for (const [thread, message, messages] of [[shared, fast, [ownerInput]], [ownerOnly, fast, [memberInput]], [ownerOnly, { ...scope, remoteLayer: "notice" }, []]]) {
    const [entry] = chunk(thread, message, messages);
    assert.equal(entry, "Done");
    assert.doesNotMatch(entry, footerPattern);
  }
});
