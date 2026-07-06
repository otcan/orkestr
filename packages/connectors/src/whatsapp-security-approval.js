import { createHash } from "node:crypto";
import { brokerInstance, brokerWhatsAppRelayAccountId } from "../../core/src/broker-instance-registry.js";
import { ensureRouterTurn, recordRouterTraceEvent } from "../../core/src/router-traces.js";
import { exactSecurityApproveChallengeId } from "../../core/src/raw-terminal-commands.js";
import { approvePairingChallenge, getPairingChallenge } from "../../core/src/security.js";
import { listThreads } from "../../core/src/threads.js";
import { appendEvent } from "../../storage/src/store.js";
import { stripWhatsAppDebugFooter } from "./whatsapp-formatting.js";
import { comparableParticipantId, whatsappBindingIsRouteEligible, whatsappInboundThreadMatchesBinding } from "./whatsapp-inbound-routing.js";
import { upsertWhatsAppThreadBinding } from "./whatsapp-account-bindings.js";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function truthy(value = "") {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
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

function directWhatsAppParticipantCandidates(input = {}) {
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
    input.participantId,
    input.externalUserId,
  ];
  for (const text of values.flatMap((value) => possibleWhatsAppIdentityStrings(value))) {
    if (/@g\.us\b/i.test(text)) continue;
    const comparable = comparableParticipantId(text);
    if (comparable) candidates.add(comparable);
    const userPart = text.split("@")[0] || text;
    const digits = userPart.replace(/[^\d]/g, "");
    if (digits) candidates.add(digits);
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
  if (!whatsappBindingIsRouteEligible(binding)) return false;
  if (String(binding.connector || "whatsapp") !== "whatsapp") return false;
  if (pickString(binding.chatId) !== pickString(chatId, input.chatId, input.chat?.id, input.fromChatId)) return false;
  return true;
}

function whatsappApprovalBrokeredUnscopedAllowed({ input = {}, challenge = {}, env = process.env } = {}) {
  if (challenge?.instanceId) return false;
  if (!truthy(env.ORKESTR_WHATSAPP_SECURITY_APPROVAL_ALLOW_BROKERED_UNSCOPED || env.WHATSAPP_SECURITY_APPROVAL_ALLOW_BROKERED_UNSCOPED)) return false;
  return Boolean(input.machineAuthContext);
}

function envThreadCandidates(env = process.env) {
  return [
    env.ORKESTR_BROKER_WHATSAPP_THREAD_ID,
    env.ORKESTR_CONNECT_WHATSAPP_THREAD_ID,
    env.ORKESTR_PUBLIC_WHATSAPP_THREAD_ID,
    env.ORKESTR_DEFAULT_WHATSAPP_THREAD_ID,
    env.ORKESTR_WHATSAPP_DEFAULT_THREAD_ID,
  ].map((value) => pickString(value)).filter(Boolean);
}

function threadMatchesKey(thread = {}, key = "") {
  const wanted = pickString(key).toLowerCase();
  if (!wanted) return false;
  return [thread.id, thread.name, thread.title, thread.bindingName]
    .map((value) => pickString(value).toLowerCase())
    .some((value) => value === wanted);
}

function threadOwner(thread = {}, env = process.env) {
  return pickString(thread.ownerUserId, env.ORKESTR_ADMIN_USER_ID, "admin");
}

function isWatcherThread(thread = {}) {
  return [thread.id, thread.name, thread.title, thread.bindingName]
    .map((value) => pickString(value).toLowerCase())
    .some((value) => value.includes("watcher"));
}

function isWhatsAppThread(thread = {}) {
  const binding = thread?.binding || {};
  return pickString(binding.chatId) || pickString(binding.connector).toLowerCase() === "whatsapp";
}

async function brokerApprovalBindingThread({ challenge = {}, env = process.env } = {}) {
  const threads = await listThreads(env).catch(() => []);
  if (!threads.length) return { thread: null, reason: "no_threads" };

  for (const key of envThreadCandidates(env)) {
    const explicit = threads.find((thread) => threadMatchesKey(thread, key));
    if (explicit) return { thread: explicit, reason: "explicit_env_thread" };
  }

  const owner = pickString(challenge.userId, env.ORKESTR_ADMIN_USER_ID, "admin");
  const owned = threads.filter((thread) => threadOwner(thread, env) === owner && !isWatcherThread(thread));
  const ownedWhatsApp = owned.filter(isWhatsAppThread);
  if (ownedWhatsApp.length === 1) return { thread: ownedWhatsApp[0], reason: "single_owned_whatsapp_thread" };

  const readyOwned = owned.filter((thread) => pickString(thread.state, "ready") === "ready");
  if (readyOwned.length === 1) return { thread: readyOwned[0], reason: "single_owned_ready_thread" };

  return {
    thread: null,
    reason: ownedWhatsApp.length > 1 || readyOwned.length > 1 ? "ambiguous_threads" : "no_matching_thread",
  };
}

async function bindBrokerApprovalChat({ input = {}, challenge = {}, instance = null, chatId = "", accountId = "", from = "", env = process.env } = {}) {
  if (!challenge?.instanceId || !instance?.whatsappChatHash || !chatId) return null;
  if (!whatsappApprovalSenderMatchesHash(input, instance.whatsappChatHash)) return null;
  const target = await brokerApprovalBindingThread({ challenge, instance, env });
  if (!target.thread?.id) {
    await appendEvent({
      type: "whatsapp_security_approval_auto_bind_skipped",
      challengeId: challenge.id || null,
      instanceId: challenge.instanceId || null,
      chatId,
      accountId,
      reason: target.reason || "thread_not_found",
    }, env).catch(() => {});
    return { ok: false, skipped: target.reason || "thread_not_found" };
  }
  const responderAccountId = pickString(
    accountId,
    instance.relayAccountId,
    brokerWhatsAppRelayAccountId(instance, env),
  );
  const result = await upsertWhatsAppThreadBinding({
    level: "chat",
    threadId: target.thread.id,
    chatId,
    displayName: pickString(target.thread.bindingName, target.thread.name, target.thread.title, "Orkestr"),
    responderConnectorAccountId: responderAccountId,
    responderAccountId,
    outboundAccountId: responderAccountId,
    senderContactId: pickString(from, input.from, input.sender, input.author, chatId),
    instanceId: challenge.instanceId,
    mirrorToWhatsApp: true,
    routeEligible: true,
    enabled: true,
    acl: {
      send: { mode: "thread" },
      receive: { mode: "thread" },
      read: { mode: "thread" },
      manage: { mode: "owner-only" },
    },
  }, env);
  await appendEvent({
    type: "whatsapp_security_approval_auto_bound",
    challengeId: challenge.id || null,
    instanceId: challenge.instanceId || null,
    threadId: target.thread.id,
    bindingId: result.binding?.id || result.binding?.bindingId || null,
    chatId,
    accountId: responderAccountId,
    reason: target.reason,
  }, env).catch(() => {});
  return { ok: true, ...result, reason: target.reason };
}

export async function maybeBindApprovedBrokerChat({
  input = {},
  env = process.env,
  state = {},
  chatId = "",
  accountId = "",
} = {}) {
  const targetChatId = pickString(chatId, input.chatId, input.chat?.id, input.fromChatId);
  if (!targetChatId) return null;
  const priorApproval = [...(state.inboundEvents || [])].reverse().find((event) =>
    pickString(event.chatId) === targetChatId &&
      pickString(event.ignoredReason) === "security_approval_command" &&
      pickString(event.instanceId)
  );
  if (!priorApproval) return null;
  const instance = await brokerInstance(priorApproval.instanceId, env).catch(() => null);
  if (!instance?.whatsappChatHash) return null;
  return bindBrokerApprovalChat({
    input,
    challenge: {
      id: pickString(priorApproval.challengeId),
      instanceId: pickString(priorApproval.instanceId),
      userId: pickString(priorApproval.userId),
    },
    instance,
    chatId: targetChatId,
    accountId: pickString(accountId, priorApproval.accountId, input.accountId),
    from: pickString(input.from, input.sender, input.author, priorApproval.from),
    env,
  });
}

async function whatsappApprovalPriorRoutedBindingAllowed({ input = {}, state = {}, accountId = "", env = process.env } = {}) {
  const candidates = directWhatsAppParticipantCandidates(input);
  if (!candidates.size) return false;
  const recentEvents = [...(state.inboundEvents || [])].reverse().slice(0, 500);
  const threads = await listThreads(env).catch(() => []);
  if (!threads.length) return false;
  for (const event of recentEvents) {
    if (!event?.chatId || event.ignoredReason || (!event.messageId && !event.threadId)) continue;
    const eventFrom = comparableParticipantId(pickString(event.from));
    if (!eventFrom || !candidates.has(eventFrom)) continue;
    const eventAccountId = pickString(event.accountId);
    const expectedAccountId = pickString(accountId, input.accountId);
    if (expectedAccountId && eventAccountId && eventAccountId !== expectedAccountId) continue;
    const matchingThread = threads.find((thread) => {
      try {
        return whatsappInboundThreadMatchesBinding({
          thread,
          chatId: pickString(event.chatId),
          accountId: pickString(expectedAccountId, eventAccountId),
          from: pickString(event.from),
          fromMe: false,
        });
      } catch {
        return false;
      }
    });
    if (matchingThread) return true;
  }
  return false;
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
  const challengeId = exactSecurityApproveChallengeId(text);
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
  const senderMatchesRoutedThread = whatsappApprovalRoutedBindingAllowed({ input, chatId, threadRoute });
  const senderMatchesPriorRoutedThread = senderMatchesRoutedThread ? false : await whatsappApprovalPriorRoutedBindingAllowed({
    input,
    state,
    accountId,
    env,
  });
  const senderMatchesRegisteredTarget = instance?.whatsappChatHash &&
    whatsappApprovalSenderMatchesHash(input, instance.whatsappChatHash);
  const senderMatchesBrokeredUnscoped = whatsappApprovalBrokeredUnscopedAllowed({ input, challenge, env });
  if (!senderMatchesRegisteredTarget && !senderMatchesRoutedThread && !senderMatchesPriorRoutedThread && !senderMatchesBrokeredUnscoped) {
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
  const autoBinding = await bindBrokerApprovalChat({
    input,
    challenge: result.challenge || challenge,
    instance,
    chatId,
    accountId,
    from,
    env,
  }).catch(async (error) => {
    await appendEvent({
      type: "whatsapp_security_approval_auto_bind_failed",
      challengeId: result.challenge?.id || challenge.id || challengeId,
      instanceId: result.challenge?.instanceId || challenge.instanceId || null,
      chatId,
      accountId,
      error: String(error?.message || error || "auto_bind_failed").slice(0, 240),
    }, env).catch(() => {});
    return { ok: false, error: String(error?.message || error || "auto_bind_failed") };
  });
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
    autoBinding: autoBinding?.ok ? {
      threadId: autoBinding.thread?.id || autoBinding.binding?.threadId || null,
      bindingId: autoBinding.binding?.id || autoBinding.binding?.bindingId || null,
    } : null,
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
