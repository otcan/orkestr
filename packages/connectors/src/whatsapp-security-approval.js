import { createHash } from "node:crypto";
import { brokerInstance } from "../../core/src/broker-instance-registry.js";
import { ensureRouterTurn, recordRouterTraceEvent } from "../../core/src/router-traces.js";
import { rawSecurityApproveChallengeId } from "../../core/src/raw-terminal-commands.js";
import { approvePairingChallenge, getPairingChallenge } from "../../core/src/security.js";
import { appendEvent } from "../../storage/src/store.js";
import { stripWhatsAppDebugFooter } from "./whatsapp-formatting.js";
import { isWhatsAppGroupChatId, whatsappBindingIsRouteEligible } from "./whatsapp-inbound-routing.js";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function hashHex(value = "") {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function possibleWhatsAppIdentityStrings(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (typeof value !== "object") return [];
  return [
    value.id,
    value._serialized,
    value.serialized,
    value.user,
    value.phone,
    value.phoneNumber,
    value.number,
  ].map((item) => pickString(item)).filter(Boolean);
}

function directWhatsAppTargetCandidates(input = {}) {
  const candidates = new Set();
  const values = [
    input.chatId,
    input.from,
    input.sender,
    input.author,
    input.to,
    input.fromChatId,
    input.chat,
    input.contact,
    input.senderId,
    input.authorId,
  ];
  for (const text of values.flatMap((value) => possibleWhatsAppIdentityStrings(value))) {
    if (/@g\.us\b/i.test(text)) continue;
    const userPart = text.split("@")[0] || text;
    const digits = userPart.replace(/[^\d]/g, "");
    if (digits) candidates.add(`${digits}@c.us`);
  }
  return candidates;
}

function whatsappApprovalSenderMatchesHash(input = {}, expectedHash = "") {
  const hash = pickString(expectedHash).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  for (const candidate of directWhatsAppTargetCandidates(input)) {
    if (hashHex(candidate) === hash) return true;
  }
  return false;
}

function whatsappApprovalRoutedBindingAllowed({ input = {}, chatId = "", threadRoute = {} } = {}) {
  const binding = threadRoute?.binding || {};
  if (!threadRoute?.threadId || !binding || typeof binding !== "object") return false;
  if (!isWhatsAppGroupChatId(chatId)) return false;
  if (!whatsappBindingIsRouteEligible(binding)) return false;
  if (String(binding.connector || "whatsapp") !== "whatsapp") return false;
  if (pickString(binding.chatId) !== pickString(chatId, input.chatId, input.chat?.id, input.fromChatId)) return false;
  return true;
}

function canonicalWhatsAppEventId(value = "") {
  return String(value || "").trim().replace(/^(?:true|false)_/, "");
}

function sameWhatsAppSourceEvent(left = {}, right = {}) {
  const leftCanonical = canonicalWhatsAppEventId(left.canonicalEventId || left.eventId);
  const rightCanonical = canonicalWhatsAppEventId(right.canonicalEventId || right.eventId);
  if (!leftCanonical || !rightCanonical || leftCanonical !== rightCanonical) return false;
  const leftChat = pickString(left.chatId);
  const rightChat = pickString(right.chatId);
  return !leftChat || !rightChat || leftChat === rightChat;
}

export async function maybeApprovePairingChallengeFromWhatsApp({
  input = {},
  env = process.env,
  state = {},
  writeState,
  eventId = "",
  canonicalEventId = "",
  routerTraceId = "",
  turnId = "",
  chatId = "",
  accountId = "",
  threadRoute = null,
} = {}) {
  const text = stripWhatsAppDebugFooter(pickString(input.text, input.body, input.message));
  const challengeId = rawSecurityApproveChallengeId(text);
  if (!challengeId) return null;
  if (typeof writeState !== "function") throw new Error("whatsapp_security_approval_write_state_required");

  const existing = (state.inboundEvents || []).find((event) =>
    event.eventId === eventId || sameWhatsAppSourceEvent(event, { eventId, canonicalEventId, chatId })
  );
  if (existing) {
    await recordRouterTraceEvent({
      routerTraceId: pickString(existing.routerTraceId, routerTraceId),
      turnId: pickString(existing.turnId, turnId),
      connector: "whatsapp",
      accountId: pickString(existing.accountId, accountId),
      chatId: pickString(existing.chatId, chatId),
      sourceEventId: eventId,
      threadId: existing.threadId || null,
      messageId: existing.messageId,
      phase: "skipped",
      reason: existing.eventId === eventId ? "duplicate_event_id" : "duplicate_source_message",
      terminal: true,
    }, env).catch(() => {});
    return {
      duplicate: true,
      event: existing,
      agentId: existing.agentId || null,
      threadId: existing.threadId || null,
      messageId: existing.messageId,
    };
  }

  const from = pickString(input.from, input.sender, input.author);
  const receivedAt = pickString(input.timestamp, input.receivedAt) || new Date().toISOString();
  const recordSkipped = async (reason, extra = {}) => {
    const event = {
      eventId,
      canonicalEventId,
      routerTraceId,
      turnId,
      agentId: null,
      threadId: null,
      messageId: null,
      chatId,
      from,
      accountId,
      ignoredReason: reason,
      receivedAt,
      ...extra,
    };
    state.inboundEvents = [...(state.inboundEvents || []), event];
    await writeState(state, env);
    await ensureRouterTurn({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      accountId,
      chatId,
      eventId,
      threadId: "",
      state: "skipped",
    }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId,
      turnId,
      connector: "whatsapp",
      accountId,
      chatId,
      sourceEventId: eventId,
      phase: "skipped",
      reason,
      terminal: true,
    }, env).catch(() => {});
    return event;
  };

  let challenge = null;
  try {
    challenge = await getPairingChallenge(challengeId, { env });
  } catch (error) {
    const event = await recordSkipped("security_approval_challenge_not_found", {
      challengeId,
      error: String(error?.message || error || "pairing_challenge_not_found").slice(0, 200),
    });
    await appendEvent({
      type: "whatsapp_security_approval_command_rejected",
      eventId,
      canonicalEventId,
      routerTraceId,
      chatId,
      accountId,
      challengeId,
      reason: "security_approval_challenge_not_found",
    }, env).catch(() => {});
    return { duplicate: false, skipped: "security_approval_challenge_not_found", event, agentId: null, threadId: null, messageId: null };
  }

  const instance = challenge.instanceId ? await brokerInstance(challenge.instanceId, env).catch(() => null) : null;
  const senderMatchesRegisteredTarget = instance?.whatsappChatHash &&
    whatsappApprovalSenderMatchesHash(input, instance.whatsappChatHash);
  const senderMatchesRoutedThread = whatsappApprovalRoutedBindingAllowed({ input, chatId, threadRoute });
  if (!senderMatchesRegisteredTarget && !senderMatchesRoutedThread) {
    const event = await recordSkipped("security_approval_sender_denied", {
      challengeId: challenge.id || challengeId,
      instanceId: challenge.instanceId || null,
    });
    await appendEvent({
      type: "whatsapp_security_approval_command_rejected",
      eventId,
      canonicalEventId,
      routerTraceId,
      chatId,
      accountId,
      challengeId: challenge.id || challengeId,
      instanceId: challenge.instanceId || null,
      reason: "security_approval_sender_denied",
    }, env).catch(() => {});
    return { duplicate: false, skipped: "security_approval_sender_denied", event, agentId: null, threadId: null, messageId: null };
  }

  if (challenge.status && challenge.status !== "pending" && challenge.status !== "approved") {
    const reason = `security_approval_challenge_${challenge.status}`;
    const event = await recordSkipped(reason, {
      challengeId: challenge.id || challengeId,
      instanceId: challenge.instanceId || null,
    });
    await appendEvent({
      type: "whatsapp_security_approval_command_rejected",
      eventId,
      canonicalEventId,
      routerTraceId,
      chatId,
      accountId,
      challengeId: challenge.id || challengeId,
      instanceId: challenge.instanceId || null,
      reason,
    }, env).catch(() => {});
    return { duplicate: false, skipped: reason, event, agentId: null, threadId: null, messageId: null };
  }

  const result = challenge.status === "approved"
    ? { ok: true, challenge }
    : await approvePairingChallenge(challengeId, { env, approvedBy: "whatsapp" });
  const event = {
    eventId,
    canonicalEventId,
    routerTraceId,
    turnId,
    agentId: null,
    threadId: null,
    messageId: null,
    chatId,
    from,
    accountId,
    ignoredReason: "security_approval_command",
    challengeId: result.challenge?.id || challenge.id || challengeId,
    instanceId: result.challenge?.instanceId || challenge.instanceId || null,
    receivedAt,
  };
  state.inboundEvents = [...(state.inboundEvents || []), event];
  await writeState(state, env);
  await ensureRouterTurn({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    accountId,
    chatId,
    eventId,
    threadId: "",
    state: "completed",
  }, env).catch(() => null);
  await recordRouterTraceEvent({
    routerTraceId,
    turnId,
    connector: "whatsapp",
    accountId,
    chatId,
    sourceEventId: eventId,
    phase: "completed",
    reason: "security_approval_command",
    terminal: true,
  }, env).catch(() => {});
  await appendEvent({
    type: "whatsapp_security_approval_command_approved",
    eventId,
    canonicalEventId,
    routerTraceId,
    chatId,
    accountId,
    challengeId: result.challenge?.id || challenge.id || challengeId,
    instanceId: result.challenge?.instanceId || challenge.instanceId || null,
    alreadyApproved: challenge.status === "approved",
  }, env).catch(() => {});
  return {
    duplicate: false,
    approvedSecurityChallenge: true,
    challenge: result.challenge || challenge,
    event,
    agentId: null,
    threadId: null,
    messageId: null,
  };
}
