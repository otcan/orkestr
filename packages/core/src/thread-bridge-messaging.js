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
import { enqueueThreadInput, getThread, getThreadMessage, listThreadMessageCandidates } from "./threads.js";
import { currentCodexGenerationMatches } from "./codex-generation.js";
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
    // A delegated assistant's text is never an Orkestr control command:
    // `/now`, `/stop`, `/reset` ... stay literal text, so an MCP message can
    // neither interrupt nor be coalesced into another request's turn.
    commandProcessing: "disabled",
    bridgeWhatsAppReply: input.deliverToWhatsApp !== false,
    ...(input.deliverToWhatsApp === false ? {} : {
      replyDeliveryIntent: createBridgeReplyDeliveryIntent(thread, { enabled: true, ownerUserId: grant.ownerUserId }),
    }),
    ...(String(thread.codexThreadId || thread.executor?.codexThreadId || thread.runtime?.codexThreadId || "").trim()
      ? { codexThreadId: String(thread.codexThreadId || thread.executor?.codexThreadId || thread.runtime?.codexThreadId || "").trim() }
      : {}),
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

function turnId(message = {}) {
  return String(message.executorTurnId || message.codexTurnId || "").trim();
}

// Runtime generation a turn id belongs to. Codex turn ids repeat per Codex
// thread, so the Codex thread id is the generation; Claude attempt ids are
// random per attempt (claude_turn_<96-bit>) and identify themselves.
function turnGeneration(message = {}) {
  return String(message.codexThreadId || message.executorThreadId || "").trim();
}

function claudeAttemptId(id = "") {
  return /^claude_turn_[A-Za-z0-9_-]{12,}$/.test(id);
}

function sameRuntimeTurn(input, message) {
  const inputTurn = turnId(input);
  if (!inputTurn || turnId(message) !== inputTurn) return false;
  const inputGeneration = turnGeneration(input);
  const messageGeneration = turnGeneration(message);
  if (inputGeneration || messageGeneration) return Boolean(inputGeneration) && inputGeneration === messageGeneration;
  return claudeAttemptId(inputTurn);
}

// A final that can stand as the answer: completed and not deleted, hidden or
// superseded (a replaced final must not mask its visible replacement).
function eligibleFinal(message) {
  return message?.role === "assistant" && message.phase === "final_answer" && message.state === "completed" &&
    !message.deletedAt && !message.supersededBy && String(message.visibility || "").trim().toLowerCase() !== "internal";
}

function noReplyFinal(message) {
  return String(message?.text || "").trim() === "NO_REPLY";
}

// The answer to one input among eligible finals: parentMessageId is the
// input, or the same runtime turn of the same generation (batched inputs). A
// later final for another input never counts. Returns { reply } with a
// visible answer (preferred) or { noReply } for an explicit NO_REPLY.
export function correlatedFinal(input, candidates = []) {
  const matches = candidates.filter((message) => eligibleFinal(message) &&
    (message.parentMessageId === input.id || sameRuntimeTurn(input, message)));
  const reply = matches.find((message) => !noReplyFinal(message) && bridgeMessageVisible(message));
  if (reply) return { reply };
  const noReply = matches.find(noReplyFinal);
  return noReply ? { noReply } : null;
}

const failedTurnStatuses = new Set(["failed", "interrupted", "aborted", "cancelled", "canceled"]);
const NO_FINAL_GRACE_MS = 3000;

// Whether the runtime turn that took this input has ended, from the
// runtime's own turn record. Input state is not evidence: the Codex adapter
// marks an input "completed" as soon as turn/start is accepted while the turn
// keeps running. Unknown (no turn id yet, or the runtime has moved on) is
// treated as not ended, so a reply is never declared missing early.
export function inputTurnOutcome(input = {}, thread = {}) {
  const inputTurn = turnId(input);
  const runtime = thread?.runtime || {};
  if (!inputTurn || String(runtime.activeTurnId || "") === inputTurn) return null;
  // The runtime record describes the thread's current generation only; an
  // input from another Codex generation with the same turn id is no evidence.
  const inputGeneration = turnGeneration(input);
  if (inputGeneration ? !currentCodexGenerationMatches(thread || {}, inputGeneration).ok : !claudeAttemptId(inputTurn)) return null;
  if (String(runtime.lastTurnId || "") !== inputTurn) return null;
  const status = String(runtime.lastTurnStatus || "").toLowerCase();
  if (status === "completed") return "completed";
  return failedTurnStatuses.has(status) ? "failed" : null;
}

// Resolves after `ms` or on abort; the abort listener is removed when the
// timer fires, so long waits do not accumulate one listener per poll.
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

// Waits (bounded) for the agent's answer to a message sent with
// send_message. Returns answered, failed, completed_without_reply or
// still_working; stops early when `signal` aborts (client disconnected).
export async function waitForBridgeReply(threadId, messageId, principal, { timeoutSeconds = 30, pollMs = 1000, signal = null } = {}, env = process.env) {
  const grant = await authorization(principal, env);
  await target(threadId, grant, "observe", env);
  const sent = await getThreadMessage(threadId, String(messageId || ""), env);
  if (!sent || sent.source !== BRIDGE_MESSAGE_SOURCE || sent.bridgeAgentId !== principal.agentId) fail("bridge_message_not_found", 404);
  const deadline = Date.now() + Math.min(MAX_WAIT_SECONDS, Math.max(1, Number(timeoutSeconds) || 30)) * 1000;
  let terminalSince = 0;
  for (;;) {
    await authorization(principal, env);
    const input = (await getThreadMessage(threadId, sent.id, env)) || sent;
    const after = await listThreadMessageCandidates(threadId, { afterCursor: Number(sent.cursor || 0) }, env);
    const match = correlatedFinal(input, after);
    if (match?.reply) return { status: "answered", inputState: input.state || null, reply: summarize(match.reply, 16000) };
    if (match?.noReply) return { status: "completed_without_reply", inputState: input.state || null, reason: "no_reply" };
    if (input.state === "failed" || input.state === "interrupted" || input.state === "cancelled") {
      return { status: "failed", inputState: input.state, error: String(input.error || "").slice(0, 500) || null };
    }
    // Only the runtime's record that this input's own turn ended counts; the
    // final may be projected just after it, hence the short grace.
    const outcome = inputTurnOutcome(input, await getThread(threadId, env).catch(() => null));
    if (outcome === "failed") return { status: "failed", inputState: input.state || null, error: "turn_failed" };
    if (outcome === "completed") {
      terminalSince ||= Date.now();
      if (Date.now() - terminalSince >= NO_FINAL_GRACE_MS) return { status: "completed_without_reply", inputState: input.state || null, reason: "no_final_answer" };
    } else {
      terminalSince = 0;
    }
    if (Date.now() >= deadline || signal?.aborted) {
      return { status: "still_working", inputState: input.state || null, hint: "Call wait_for_reply again, or subscribe to thread.message.created." };
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
  }
}
