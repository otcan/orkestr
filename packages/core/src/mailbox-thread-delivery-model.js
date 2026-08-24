import { createHash } from "node:crypto";
import { policyError } from "./policy.js";
import { threadResourceAccessMode, threadResourceId } from "./thread-resource-grants.js";

const clean = (value = "") => String(value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const hash = (value = "") => createHash("sha256").update(String(value || "")).digest("hex");
const listenerFilterKeys = new Set(["fromIncludes", "subjectIncludes", "hasAttachments", "verificationOnly"]);

export function mailboxResourceId(mailbox = {}, env = process.env) {
  return threadResourceId("mailbox", mailbox.id, mailbox.ownerUserId, env);
}

export function publicMailboxThreadListener(listener = {}) {
  return {
    id: listener.id,
    mailboxResourceId: listener.resourceId,
    threadId: listener.threadId,
    filter: { ...(listener.filter || {}) },
    generation: listener.generation,
    status: listener.status,
    grantRevision: listener.grantRevision,
    policyRevision: listener.policyRevision,
    resourceGeneration: listener.resourceGeneration,
    createdAt: listener.createdAt,
    updatedAt: listener.updatedAt,
    revokedAt: listener.revokedAt || null,
    reason: listener.reason || null,
  };
}

export function normalizedMailboxThreadFilter(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (Object.keys(source).some((key) => !listenerFilterKeys.has(key))) throw policyError("mailbox_listener_filter_invalid", 400);
  const filter = {};
  for (const key of ["fromIncludes", "subjectIncludes"]) {
    if (source[key] === undefined || source[key] === null || source[key] === "") continue;
    const value = lower(source[key]).slice(0, 200);
    if (!value) throw policyError("mailbox_listener_filter_invalid", 400);
    filter[key] = value;
  }
  for (const key of ["hasAttachments", "verificationOnly"]) {
    if (source[key] === undefined || source[key] === null) continue;
    if (typeof source[key] !== "boolean") throw policyError("mailbox_listener_filter_invalid", 400);
    filter[key] = source[key];
  }
  return filter;
}

export function mailboxThreadFilterKey(filter = {}) {
  return hash(JSON.stringify(filter));
}

export function matchesMailboxThreadFilter(listener = {}, message = {}) {
  const filter = listener.filter || {};
  if (filter.fromIncludes && !lower(message.headers?.from).includes(filter.fromIncludes)) return false;
  if (filter.subjectIncludes && !lower(message.headers?.subject).includes(filter.subjectIncludes)) return false;
  if (filter.hasAttachments === true && !(message.attachments || []).length) return false;
  if (filter.hasAttachments === false && (message.attachments || []).length) return false;
  if (filter.verificationOnly === true && !(message.verificationCandidates || []).length) return false;
  if (filter.verificationOnly === false && (message.verificationCandidates || []).length) return false;
  return true;
}

export function mailboxThreadPayload(mailbox = {}, message = {}) {
  const from = clean(message.headers?.from).slice(0, 500);
  const subject = clean(message.headers?.subject).slice(0, 500);
  const snippet = clean(message.snippet).slice(0, 500);
  return {
    text: [
      `[Mailbox message for ${mailbox.address}]`,
      from ? `From: ${from}` : "",
      subject ? `Subject: ${subject}` : "",
      "",
      snippet || "(No text body was supplied.)",
    ].filter((line, index) => line || index === 3).join("\n"),
    from,
    subject,
    messageId: clean(message.headers?.messageId).slice(0, 500),
    attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
  };
}

export function mailboxThreadDeliveryId(resourceId, messageKey, listenerId, generation) {
  return `mbd-${hash(`${resourceId}:${messageKey}:${listenerId}:${generation}`).slice(0, 48)}`;
}

export function mailboxThreadQuarantineId(resourceId, messageKey) {
  return mailboxThreadDeliveryId(resourceId, messageKey, "unrouted", 0);
}

export function mailboxThreadSystemPrincipal(mailbox = {}) {
  return { kind: "system", userId: mailbox.ownerUserId || "system" };
}

export function requireMailboxThreadPolicyMode(env = process.env) {
  if (threadResourceAccessMode("mailbox", env) === "off") throw policyError("mailbox_listener_policy_mode_required", 409);
}
