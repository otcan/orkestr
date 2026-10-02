// Messages from a connected assistant (MCP) into Orkestr threads. Unlike
// comments, a message is queued as input and the thread's agent acts on it,
// so it needs the separate "message" grant scope. Messages are labelled as
// the assistant's (never the owner's) and are visible in the thread; the
// input carries no chat route. The delivery worker may mirror the answer only
// through the originating thread's existing eligible WhatsApp binding.
// Rate-limited per assistant.
import { appendEvent } from "../../storage/src/store.js";
import { bridgeMessageVisible } from "../../storage/src/thread-bridge-journal.js";
import { authorization, target } from "./thread-bridge.js";
import { enqueueThreadInput, getThreadMessage, listThreadMessageCandidates } from "./threads.js";
import { createBridgeReplyDeliveryIntent } from "./reply-delivery-intent.js";

export const BRIDGE_MESSAGE_SOURCE = "thread_bridge_message";
const MAX_MESSAGES_PER_HOUR = 30;
const MAX_WAIT_SECONDS = 45;
const recentSends = new Map();

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function rateLimit(agentId, now = Date.now()) {
  const recent = (recentSends.get(agentId) || []).filter((stamp) => now - stamp < 3_600_000);
  if (recent.length >= MAX_MESSAGES_PER_HOUR) fail("bridge_message_rate_limited", 429);
  recent.push(now);
  recentSends.set(agentId, recent);
}

// `options.deliver` (tests) replaces the runtime delivery kick.
export async function sendBridgeMessage(threadId, input = {}, principal, env = process.env, options = {}) {
  const grant = await authorization(principal, env);
  const thread = await target(threadId, grant, "message", env);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > 16000) fail("bridge_message_invalid");
  const requestId = String(input.requestId || "");
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(requestId)) fail("bridge_message_invalid");
  const clientMessageId = `bridge-message:${principal.agentId}:${requestId}`;
  // Idempotent retries return the original message without counting again.
  const existing = await listThreadMessageCandidates(threadId, { tailLimit: 200 }, env);
  const duplicate = existing.find((message) => message.clientMessageId === clientMessageId);
  if (duplicate) return { threadId, messageId: duplicate.id, state: duplicate.state, duplicate: true };
  rateLimit(principal.agentId);
  const message = await enqueueThreadInput(threadId, {
    source: BRIDGE_MESSAGE_SOURCE,
    text,
    ownerUserId: grant.ownerUserId,
    clientMessageId,
    bridgeAgentId: principal.agentId,
    bridgeGrantId: principal.grantId,
    bridgeWhatsAppReply: input.deliverToWhatsApp !== false,
    ...(input.deliverToWhatsApp === false ? {} : {
      replyDeliveryIntent: createBridgeReplyDeliveryIntent(thread, { enabled: true }),
    }),
    codexDeliveryMode: "passive",
    steerActiveTurn: false,
  }, env);
  if (typeof options.deliver === "function") options.deliver(threadId);
  else (await import("./runtime-leases.js")).requestThreadInputDelivery(threadId, env);
  await appendEvent({ type: "thread_bridge_message_sent", threadId, messageId: message.id, agentId: principal.agentId, grantId: principal.grantId }, env);
  return { threadId, messageId: message.id, state: message.state || "queued", duplicate: false };
}

function finalAnswer(message) {
  return message?.role === "assistant" && message.phase === "final_answer" && message.state === "completed" && bridgeMessageVisible(message);
}

function summarize(message, limit = 600) {
  if (!message) return null;
  const text = String(message.text || "");
  return { messageId: message.id, createdAt: message.createdAt || null, text: text.slice(0, limit), truncated: text.length > limit };
}

// Busy/idle state from the thread's own transcript and runtime record.
export async function bridgeThreadStatus(threadId, principal, env = process.env) {
  const grant = await authorization(principal, env);
  const thread = await target(threadId, grant, "observe", env);
  const messages = await listThreadMessageCandidates(threadId, { tailLimit: 200 }, env);
  const inputs = messages.filter((message) => message.role === "user");
  const queued = inputs.filter((message) => ["queued", "awaiting_ack", "delivering", "claimed"].includes(message.state)).length;
  const running = inputs.some((message) => message.state === "running") || Boolean(thread.runtime?.activeTurnId);
  const lastInput = inputs.at(-1);
  const state = running ? "working" : queued ? "queued" : lastInput?.state === "failed" ? "last_turn_failed" : "idle";
  return {
    threadId,
    name: String(thread.bindingName || thread.name || threadId),
    state,
    queuedMessages: queued,
    runtime: thread.runtimeKind || thread.executorId || null,
    model: thread.claudeModelResolved || thread.codexModel || null,
    lastError: state === "last_turn_failed" ? String(lastInput?.error || "").slice(0, 300) || null : null,
    lastAnswer: summarize([...messages].reverse().find(finalAnswer)),
  };
}

// Waits (bounded) for the agent's answer to a message sent with send_message.
export async function waitForBridgeReply(threadId, messageId, principal, { timeoutSeconds = 30, pollMs = 1000 } = {}, env = process.env) {
  const grant = await authorization(principal, env);
  await target(threadId, grant, "observe", env);
  const sent = await getThreadMessage(threadId, String(messageId || ""), env);
  if (!sent || sent.source !== BRIDGE_MESSAGE_SOURCE || sent.bridgeAgentId !== principal.agentId) fail("bridge_message_not_found", 404);
  const deadline = Date.now() + Math.min(MAX_WAIT_SECONDS, Math.max(1, Number(timeoutSeconds) || 30)) * 1000;
  for (;;) {
    await authorization(principal, env);
    const after = await listThreadMessageCandidates(threadId, { afterCursor: Number(sent.cursor || 0) }, env);
    const finals = after.filter(finalAnswer);
    const reply = finals.find((message) => message.parentMessageId === sent.id) || finals[0];
    const input = await getThreadMessage(threadId, sent.id, env);
    if (reply) return { status: "answered", inputState: input?.state || null, reply: summarize(reply, 16000) };
    if (input?.state === "failed") return { status: "failed", inputState: "failed", error: String(input.error || "").slice(0, 500) || null };
    if (Date.now() >= deadline) return { status: "still_working", inputState: input?.state || null, hint: "Call wait_for_reply again, or subscribe to thread.message.created." };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
