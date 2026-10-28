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

const FULL = /^Answer\n\n⚡ Quick: codex example-luna\/low · 🧠 Deep: pending · ▶ Quick\n(?:codex|claude)[^\n]*\n(?:codex|claude)[^\n]*\nq:0 · load:\d+% · api:\d+% · help:\/help$/;

test("a chat with non-owner members gets the same full footer (owner decision 2026-10-28)", () => {
  assert.equal(threadHasNonOwnerMembers(shared), true);
  assert.equal(threadHasNonOwnerMembers(ownerOnly), false);
  assert.match(appendWhatsAppDebugFooter("Answer", { env, thread: shared, message: fast, messages: [ownerInput] }), FULL);
  const trusted = { ...ownerOnly, binding: { ...ownerOnly.binding, inboundSecurity: { trustedParticipantIds: ["490000000002@c.us"] } } };
  assert.match(appendWhatsAppDebugFooter("Answer", { env, thread: trusted, message: fast }), FULL);
  const census = { ...ownerOnly, binding: { ...ownerOnly.binding, whatsappNonOwnerMembers: true } };
  assert.match(appendWhatsAppDebugFooter("Answer", { env, thread: census, message: fast }), FULL);
  const unverified = { id: "t-unverified", binding: { chatId: "group-b@g.us", additionalParticipantsEnabled: true, additionalParticipantIds: ["490000000001@c.us"] } };
  assert.match(appendWhatsAppDebugFooter("Answer", { env, thread: unverified, message: fast }), FULL);
});

test("tenant isolation, the per-thread/chat footer-off switch and the global flag still remove the footer in shared chats", () => {
  for (const binding of [{ suppressWhatsAppDebugFooter: true }, { whatsappDebugFooter: false }]) {
    assert.equal(appendWhatsAppDebugFooter("Answer", { env, thread: { ...shared, binding: { ...shared.binding, ...binding } }, message: fast, messages: [memberInput] }), "Answer");
  }
  assert.equal(appendWhatsAppDebugFooter("Answer", { env: { ...env, ORKESTR_WHATSAPP_SUPPRESS_DEBUG_FOOTER_CHATS: "group-a@g.us" }, thread: shared, message: fast }), "Answer");
  assert.equal(appendWhatsAppDebugFooter("Answer", { env: { ORKESTR_WHATSAPP_DEBUG_FOOTER: "0" }, thread: shared, message: fast }), "Answer");
  assert.equal(appendWhatsAppDebugFooter("Answer", { env: { ...env, ORKESTR_ADMIN_USER_ID: "owner-a" }, thread: { ...shared, ownerUserId: "contained-user" }, message: fast }), "Answer");
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

test("a reply to a member-authored input gets the footer too", () => {
  assert.equal(memberAuthoredInput(memberInput), true);
  assert.equal(memberAuthoredInput(ownerInput), false);
  assert.match(appendWhatsAppDebugFooter("Answer", { env, thread: ownerOnly, message: fast, messages: [memberInput] }), FULL);
  const viaRemote = { ...fast, parentMessageId: "timer-parent" };
  assert.match(appendWhatsAppDebugFooter("Answer", { env, thread: shared, message: viaRemote, messages: [memberInput] }), FULL);
});

// A notice has no run: owner-only chats get only the quota lines and the
// q/load line, never a Quick/Deep/dbg layer line or "unknown".
const compactNoticeFooter = /^(?:(?:codex|claude)[ :][^\n]*\n){2}(?:q|queue):[^\n]*load:\d+% · api:\d+% · help:\/help$/;
function noticeFooter(text, body) {
  assert.ok(text.startsWith(`${body}\n\n`), text);
  const footer = text.slice(body.length + 2);
  assert.match(footer, compactNoticeFooter);
  assert.doesNotMatch(footer, /dbg:|⚡|🧠|▶|unknown|\?/);
  assert.equal(formatter.stripWhatsAppDebugFooter(text), body);
  return footer;
}
const quotaThread = { ...ownerOnly, whatsAppDebugProviderQuota: {
  codex: { weeklyRemainingPct: 80, weeklyResetsAt: new Date(Date.now() + 86_400_000).toISOString() },
  claude: { fiveHourRemainingPct: 90, weeklyRemainingPct: 70 },
} };

test("V1 queue, mode and router notices in an owner-only chat get the compact footer", () => {
  const local = { role: "assistant", source: "codex-app-server", phase: "final_answer" };
  for (const deliveryType of ["queue_notice", "mode_queued", "router_update", "delivery_error"]) {
    const footer = noticeFooter(appendWhatsAppDebugFooter("Queued.", { env, thread: quotaThread, message: local, deliveryType }), "Queued.");
    assert.match(footer, /^codex wk: 80% \([0-9dhm]+\)\nclaude 5h: 90% wk: 70%\n/, deliveryType);
    assert.match(footer, deliveryType === "queue_notice" ? /\nqueue:\d+ · reason:queued · / : /\nq:0 · /, deliveryType);
  }
});

test("a notice keeps both quota lines, as no data, instead of printing unknown", () => {
  const local = { role: "assistant", source: "orkestr_runtime" };
  const footer = noticeFooter(appendWhatsAppDebugFooter("⚙️ System:\nRestarted.", { env, thread: ownerOnly, message: local, deliveryType: "router_update" }), "⚙️ System:\nRestarted.");
  assert.match(footer, /^codex: no data\nclaude: no data\nq:0 · load:/);
});

test("notices in a shared chat or answering a member carry the compact footer too", () => {
  const local = { role: "assistant", source: "codex-app-server", phase: "final_answer" };
  for (const deliveryType of ["queue_notice", "mode_queued", "router_update", "delivery_error"]) {
    noticeFooter(appendWhatsAppDebugFooter("Queued.", { env, thread: { ...shared, whatsAppDebugProviderQuota: quotaThread.whatsAppDebugProviderQuota }, message: local, deliveryType }), "Queued.");
  }
  const notice = { ...scope, id: "notice", remoteLayer: "notice" };
  noticeFooter(appendWhatsAppDebugFooter("🚨 Alert", { env, thread: shared, message: notice, messages: [ownerInput] }), "🚨 Alert");
  noticeFooter(appendWhatsAppDebugFooter("🚨 Alert", { env, thread: ownerOnly, message: notice, messages: [memberInput] }), "🚨 Alert");
});

test("the local (V1-native) layer line never prints unknown", () => {
  const local = { role: "assistant", source: "codex-app-server", phase: "final_answer" };
  const text = appendWhatsAppDebugFooter("Done", { env, thread: ownerOnly, message: local });
  assert.match(text, /\n\n⚡ Quick: — · 🧠 Deep: codex [^\n]* · ▶ Deep\n/);
  assert.doesNotMatch(text, /unknown/);
  const claude = appendWhatsAppDebugFooter("Done", { env, thread: { ...ownerOnly, runtimeKind: "claude-code" }, message: { ...local, source: "claude-code" } });
  assert.doesNotMatch(claude, /unknown/);
  assert.match(appendWhatsAppDebugFooter("Done", { env, thread: { ...ownerOnly, codexModel: "example-model", codexReasoningEffort: "high" }, message: local }), /\n\n⚡ Quick: — · 🧠 Deep: codex example-model\/h · ▶ Deep\n/);
});

test("remote notices and delivery failures get the compact footer in an owner-only chat", () => {
  const notice = { ...scope, id: "notice", remoteLayer: "notice" };
  noticeFooter(appendWhatsAppDebugFooter("Sorry, please send it again.", { env, thread: quotaThread, message: notice, messages: [ownerInput, fast] }), "Sorry, please send it again.");
  noticeFooter(appendWhatsAppDebugFooter("🚨 Runtime down", { env, thread: ownerOnly, message: { ...scope, id: "alert", remoteKind: "notice" }, messages: [] }), "🚨 Runtime down");
  const failure = { role: "assistant", source: "codex-app-server", phase: "final_answer" };
  noticeFooter(appendWhatsAppDebugFooter("Delivery failed.", { env, thread: ownerOnly, message: failure, deliveryType: "delivery_error" }), "Delivery failed.");
  // Regular replies keep their full footer with the layer line.
  assert.match(appendWhatsAppDebugFooter("Answer", { env, thread: quotaThread, message: fast, messages: [ownerInput, fast] }),
    /^Answer\n\n⚡ Quick: codex example-luna\/low · 🧠 Deep: pending · ▶ Quick\ncodex wk: 80% [^\n]*\nclaude 5h: 90% wk: 70%\nq:0 · /);
});

test("the scoped group relay applies the same audience rules", () => {
  const chunk = (thread, message, messages, config = { appendDebugFooter: true }) => scopedGroupReplyChunks({ text: "Done", deliveryType: "final", message: { ...message, chatId: "group-a@g.us" },
    thread, messages, config, formatter, env: {} });
  for (const [thread, message, messages] of [[ownerOnly, fast, [ownerInput]], [shared, fast, [ownerInput]], [ownerOnly, fast, [memberInput]]]) {
    assert.match(chunk(thread, message, messages)[0], /^Done\n\n⚡ Quick: codex example-luna\/low/);
  }
  for (const thread of [ownerOnly, shared]) {
    const [notice] = chunk(thread, { ...scope, remoteLayer: "notice" }, []);
    assert.match(notice, /^Done\n\ncodex: no data\nclaude: no data\nq:0 · load:\d+% · api:\d+% · help:\/help$/);
  }
  // The footer-off switch and a relay without the opt-in still send no footer.
  const [off] = chunk({ ...shared, binding: { ...shared.binding, suppressWhatsAppDebugFooter: true } }, fast, [memberInput]);
  assert.equal(off, "Done");
  assert.equal(chunk(shared, fast, [], { appendDebugFooter: false })[0], "Done");
  assert.doesNotMatch(off, footerPattern);
});

test("a notice about a member's own input carries the compact footer", () => {
  for (const deliveryType of ["queue_notice", "mode_queued", "delivery_error", "router_update"]) {
    noticeFooter(appendWhatsAppDebugFooter("Queued.", { env, thread: ownerOnly, message: memberInput, messages: [memberInput], deliveryType }), "Queued.");
  }
});
