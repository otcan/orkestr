import { appendEvent } from "../../storage/src/store.js";
import { approvePairingChallenge } from "./security.js";
import { rawSecurityApproveChallengeId } from "./raw-terminal-commands.js";
import { appendThreadMessage, updateThread, updateThreadMessage } from "./threads.js";

function clean(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function publicError(error) {
  return clean(error?.message || error?.stderr || error?.stdout || String(error || ""));
}

function approvedByForMessage(message = {}) {
  const source = clean(message.source).toLowerCase();
  if (source === "whatsapp" || clean(message.connector).toLowerCase() === "whatsapp") return "whatsapp-thread";
  return "thread";
}

export function threadSecurityApproveChallengeId(message = {}) {
  return rawSecurityApproveChallengeId(message.text);
}

export async function completeThreadSecurityApproveCommand(thread, message, env = process.env) {
  const challengeId = threadSecurityApproveChallengeId(message);
  if (!challengeId) return null;

  const deliveredAt = nowIso();
  try {
    const result = await approvePairingChallenge(challengeId, {
      env,
      approvedBy: approvedByForMessage(message),
    });
    const updated = await updateThreadMessage(thread.id, message.id, {
      state: "completed",
      deliveryState: "delivered",
      observedVia: "orkestr_security_approve_command",
      deliveredAt,
      error: null,
    }, env);
    const reply = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "security_command",
      phase: "final_answer",
      text: `Approved pairing challenge ${result.challenge?.id || challengeId}.`,
      state: "completed",
      parentMessageId: message.id,
      observedVia: "orkestr_security_approve_command",
    }, env);
    await updateThread(thread.id, { state: "ready", lastError: null }, env).catch(() => {});
    await appendEvent({
      type: "thread_security_challenge_approved",
      threadId: thread.id,
      messageId: message.id,
      challengeId,
      approvedBy: approvedByForMessage(message),
    }, env).catch(() => {});
    return { handled: true, ok: true, messageId: updated.id, message: updated, reply, challenge: result.challenge };
  } catch (error) {
    const errorText = publicError(error) || "approval_failed";
    const updated = await updateThreadMessage(thread.id, message.id, {
      state: "completed",
      deliveryState: "delivered",
      observedVia: "orkestr_security_approve_command_failed",
      deliveredAt,
      error: errorText,
    }, env);
    const reply = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "security_command",
      phase: "final_answer",
      text: `Could not approve pairing challenge ${challengeId}: ${errorText}`,
      state: "completed",
      parentMessageId: message.id,
      observedVia: "orkestr_security_approve_command_failed",
    }, env);
    await updateThread(thread.id, { state: "ready", lastError: errorText }, env).catch(() => {});
    await appendEvent({
      type: "thread_security_challenge_approve_failed",
      threadId: thread.id,
      messageId: message.id,
      challengeId,
      error: errorText,
      approvedBy: approvedByForMessage(message),
    }, env).catch(() => {});
    return { handled: true, ok: false, messageId: updated.id, message: updated, reply, error: errorText };
  }
}
