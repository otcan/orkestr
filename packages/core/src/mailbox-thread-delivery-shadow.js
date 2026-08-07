import { createHash } from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import {
  authorizeThreadResourceAccess,
  readThreadResourcePolicy,
  threadResourceId,
} from "./thread-resource-grants.js";

const clean = (value = "") => String(value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const auditKeyHash = (value = "") => createHash("sha256").update(clean(value)).digest("hex").slice(0, 24);

function mailboxResourceId(mailbox = {}, env = process.env) {
  return threadResourceId("mailbox", mailbox.id, mailbox.ownerUserId, env);
}

function systemPrincipal(mailbox = {}) {
  return { kind: "system", userId: mailbox.ownerUserId || "system" };
}

function matches(listener = {}, message = {}) {
  const filter = listener.filter || {};
  if (filter.fromIncludes && !lower(message.headers?.from).includes(filter.fromIncludes)) return false;
  if (filter.subjectIncludes && !lower(message.headers?.subject).includes(filter.subjectIncludes)) return false;
  if (filter.hasAttachments === true && !(message.attachments || []).length) return false;
  if (filter.hasAttachments === false && (message.attachments || []).length) return false;
  if (filter.verificationOnly === true && !(message.verificationCandidates || []).length) return false;
  if (filter.verificationOnly === false && (message.verificationCandidates || []).length) return false;
  return true;
}

export async function evaluateMailboxThreadDeliveryShadow({ mailbox, message, idempotencyKey } = {}, env = process.env) {
  const resourceId = mailboxResourceId(mailbox, env);
  let evaluation = {
    mode: "shadow", wouldAllow: false, reason: "mailbox_resource_not_registered",
    activeListenerCount: 0, matchedListenerCount: 0, authorizedListenerCount: 0,
  };
  try {
    const state = await readThreadResourcePolicy(env);
    const resource = state.resources.find((item) => item.resourceType === "mailbox" && item.id === resourceId && item.status === "active" && !item.retiredAt) || null;
    const candidates = resource
      ? (state.mailboxListeners || []).filter((item) => item.resourceId === resourceId && item.status === "active" && !item.revokedAt)
      : [];
    const matchesMessage = candidates.filter((listener) => matches(listener, message));
    const decisions = await Promise.all(matchesMessage.map(async (listener) => ({ listener, decision: await authorizeThreadResourceAccess({
      resourceType: "mailbox", resourceId, resourceKey: mailbox.id, ownerUserId: mailbox.ownerUserId,
      threadId: listener.threadId, principal: systemPrincipal(mailbox), permission: "subscribe",
    }, env) })));
    const authorized = resource ? decisions.filter(({ listener, decision }) =>
      decision.granted && !decision.shadowDenied && decision.grant &&
      decision.policyRevision === state.revision && decision.resourceGeneration === resource.generation &&
      matches(listener, message),
    ) : [];
    evaluation = {
      mode: "shadow", wouldAllow: authorized.length > 0,
      reason: !resource ? "mailbox_resource_not_registered" : authorized.length ? "mailbox_authorized_listener" : "mailbox_no_authorized_listener",
      activeListenerCount: candidates.length, matchedListenerCount: matchesMessage.length, authorizedListenerCount: authorized.length,
    };
  } catch {
    // Shadow evaluation never holds up the legacy connector-inbox path.
    evaluation = { ...evaluation, reason: "mailbox_policy_evaluation_unavailable", evaluationUnavailable: true };
  }
  // Keep this audit summary free of message content and listener/thread IDs.
  await appendEvent({
    type: "mailbox_thread_delivery_shadow_evaluated", mailboxId: mailbox.id, ownerUserId: mailbox.ownerUserId,
    resourceId, idempotencyKeyHash: auditKeyHash(idempotencyKey), outcome: evaluation.wouldAllow ? "would_allow" : "would_deny",
    mismatch: !evaluation.wouldAllow, reason: evaluation.reason, activeListenerCount: evaluation.activeListenerCount,
    matchedListenerCount: evaluation.matchedListenerCount, authorizedListenerCount: evaluation.authorizedListenerCount,
    evaluationUnavailable: Boolean(evaluation.evaluationUnavailable),
  }, env).catch(() => {});
  return evaluation;
}
