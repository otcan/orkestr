import assert from "node:assert/strict";
import test from "node:test";
import * as formatter from "../packages/connectors/src/whatsapp-formatting.js";
import { scopedGroupReplyChunks } from "../packages/connectors/src/whatsapp-scoped-group-formatting.js";
import { memberAuthoredInput, threadHasNonOwnerMembers } from "../packages/connectors/src/whatsapp-footer-audience.js";

const { appendWhatsAppDebugFooter } = formatter;
const env = { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1" };
const owner = ["owner-phone@c.us", "owner-lid@lid"];
const ownerOnly = { id: "t-owner", binding: { chatId: "group-a@g.us", allowOtherPeople: true, ownerContactIds: owner, authorizedContactIds: owner } };
const shared = { id: "t-shared", binding: { ...ownerOnly.binding, additionalParticipantsEnabled: true, additionalParticipantIds: [...owner, "490000000001@c.us"] } };
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
  // Explicit inbound-security trusted participants are members too.
  const trusted = { ...ownerOnly, binding: { ...ownerOnly.binding, inboundSecurity: { trustedParticipantIds: ["490000000002@c.us"] } } };
  assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: trusted, message: fast }), "Answer");
  // A census-verified non-owner WA member the binding does not name.
  const census = { ...ownerOnly, binding: { ...ownerOnly.binding, whatsappNonOwnerMembers: true } };
  assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: census, message: fast }), "Answer");
  // Members with no owner identity at all fail closed.
  const unverified = { id: "t-unverified", binding: { chatId: "group-b@g.us", additionalParticipantsEnabled: true, additionalParticipantIds: ["490000000001@c.us"] } };
  assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: unverified, message: fast }), "Answer");
});

test("owner identities follow inbound security: authorized, sender and aliases, normalized", () => {
  // Festival-like binding: the authorized list includes the chat's own sending
  // account in another spelling; that is the owner, not a member.
  const festival = { id: "t-festival", binding: {
    chatId: "group-c@g.us", allowOtherPeople: true,
    senderContactId: "490000000681@c.us",
    ownerContactIds: ["490000000099@s.whatsapp.net"],
    authorizedContactIds: ["490000000681@s.whatsapp.net", "+490000000099"],
    additionalParticipantsEnabled: false, additionalParticipantIds: ["490000000777@c.us"],
  } };
  assert.equal(threadHasNonOwnerMembers(festival), false, "disabled additional participants are not members");
  assert.match(appendWhatsAppDebugFooter("Answer", { env, thread: festival, message: fast, messages: [ownerInput] }), /\n\n⚡ Quick: codex example-luna\/low/);
  const enabled = { ...festival, binding: { ...festival.binding, additionalParticipantsEnabled: true, additionalParticipantIds: ["+490000000681", "490000000099@c.us"] } };
  assert.equal(threadHasNonOwnerMembers(enabled), false, "an owner listed as participant in another spelling is still the owner");
  const explicitOwner = { id: "t-explicit", binding: { chatId: "group-d@g.us", inboundSecurity: { ownerParticipantIds: ["12345@lid"] },
    additionalParticipantsEnabled: true, additionalParticipantIds: ["12345@lid"] } };
  assert.equal(threadHasNonOwnerMembers(explicitOwner), false);
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

test("V1 queue, mode and router notices never carry a footer", () => {
  const local = { role: "assistant", source: "codex-app-server", phase: "final_answer" };
  for (const deliveryType of ["queue_notice", "mode_queued", "router_update", "delivery_error"]) {
    assert.equal(appendWhatsAppDebugFooter("Queued.", { env, thread: ownerOnly, message: local, deliveryType }), "Queued.", deliveryType);
  }
});

test("the local dbg line never prints unknown", () => {
  const local = { role: "assistant", source: "codex-app-server", phase: "final_answer" };
  const text = appendWhatsAppDebugFooter("Done", { env, thread: ownerOnly, message: local });
  assert.match(text, /\n\ndbg: [^\n]*msg:\*final\*/);
  assert.doesNotMatch(text, /unknown/);
  const claude = appendWhatsAppDebugFooter("Done", { env, thread: { ...ownerOnly, runtimeKind: "claude-code" }, message: { ...local, source: "claude-code" } });
  assert.doesNotMatch(claude, /unknown/);
  assert.match(appendWhatsAppDebugFooter("Done", { env, thread: { ...ownerOnly, codexModel: "example-model", codexReasoningEffort: "high" }, message: local }), /\n\ndbg: [^/\n]+\/example-model\/h /);
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
