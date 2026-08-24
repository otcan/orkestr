import { policyError } from "./policy.js";
import { mailboxSourceIsRetained } from "./mailbox-message-retention.js";
import {
  assertThreadResourceAccess,
  fenceThreadResourcePolicyDelivery,
  recordThreadResourcePolicyAudit,
  threadResourceAccessMode,
  threadResourceId,
} from "./thread-resource-grants.js";

const clean = (value = "") => String(value || "").trim();

function inboxLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.floor(parsed))) : 25;
}

function encodeCursor(source = {}) {
  return Buffer.from(JSON.stringify({ createdAt: clean(source.createdAt), id: clean(source.id) })).toString("base64url");
}

function decodeCursor(value = "") {
  const cursor = clean(value);
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const createdAt = clean(parsed?.createdAt);
    const id = clean(parsed?.id);
    if (!Number.isFinite(Date.parse(createdAt)) || !id) throw new Error("invalid");
    return { createdAt, id };
  } catch {
    throw policyError("mailbox_inbox_cursor_invalid", 400);
  }
}

function compareNewestFirst(left = {}, right = {}) {
  const dateOrder = Date.parse(right.createdAt || "") - Date.parse(left.createdAt || "");
  return dateOrder || String(right.id || "").localeCompare(String(left.id || ""));
}

function sourceAfterCursor(source = {}, cursor = null) {
  if (!cursor) return true;
  const dateOrder = Date.parse(source.createdAt || "") - Date.parse(cursor.createdAt || "");
  return dateOrder < 0 || (dateOrder === 0 && String(source.id || "") < cursor.id);
}

function bodyText(payload = {}) {
  const text = String(payload.text || "");
  const separator = text.indexOf("\n\n");
  return (separator >= 0 ? text.slice(separator + 2) : text).trim().slice(0, 8_000);
}

function publicMailboxInboxMessage(source = {}) {
  const payload = source.payload && typeof source.payload === "object" ? source.payload : {};
  return {
    id: clean(source.id),
    receivedAt: clean(source.createdAt),
    from: clean(payload.from).slice(0, 500),
    subject: clean(payload.subject).slice(0, 500),
    body: bodyText(payload),
    messageId: clean(payload.messageId).slice(0, 500),
    attachmentCount: Math.max(0, Number(payload.attachmentCount || 0) || 0),
    state: clean(source.state),
    suppressionReason: clean(source.suppressionReason).slice(0, 120),
  };
}

function projectSources(state = {}, resourceId = "", cursor = null, limit = 25, env = process.env) {
  const all = (state.mailboxSources || [])
    .filter((source) => source.resourceId === resourceId && mailboxSourceIsRetained(source, env))
    .sort(compareNewestFirst)
    .filter((source) => sourceAfterCursor(source, cursor));
  const sources = all.slice(0, limit);
  return {
    messages: sources.map(publicMailboxInboxMessage),
    nextCursor: all.length > sources.length && sources.length ? encodeCursor(sources.at(-1)) : null,
  };
}

async function auditRead({ decision, principal, outcome, reason = "" } = {}, env = process.env) {
  await recordThreadResourcePolicyAudit({
    action: "mailbox_inbox_read",
    resourceType: "mailbox",
    resourceId: decision.resourceId,
    threadId: decision.threadId,
    permission: "read",
    boundaryId: decision.boundaryId,
    ownerUserId: decision.ownerUserId,
    actorUserId: clean(principal?.userId || "system"),
    outcome,
    reason,
  }, env);
}

// Read-only projection for mail that has already passed the mailbox ingress
// lifecycle. It does not append a thread message, wake a runtime, consume a
// context, or mutate delivery/replay state. `operations` is test-only.
export async function listMailboxInboxMessages({ mailbox, threadId = "", cursor = "", limit, principal = {} } = {}, env = process.env, operations = {}) {
  if (!mailbox?.id || mailbox.target?.type !== "main") throw policyError("mailbox_inbox_main_mailbox_required", 409);
  const selectedThreadId = clean(threadId);
  if (!selectedThreadId) throw policyError("mailbox_inbox_thread_required", 400);
  const mode = threadResourceAccessMode("mailbox", env);
  if (mode === "off") throw policyError("mailbox_inbox_policy_mode_required", 409);
  const resourceId = threadResourceId("mailbox", mailbox.id, mailbox.ownerUserId, env);
  const pageLimit = inboxLimit(limit);
  const decodedCursor = decodeCursor(cursor);
  let decision;
  try {
    decision = await assertThreadResourceAccess({
      resourceType: "mailbox",
      resourceId,
      resourceKey: mailbox.id,
      ownerUserId: mailbox.ownerUserId,
      threadId: selectedThreadId,
      principal,
      permission: "read",
    }, env);
  } catch (error) {
    if (["mailbox_grant_required", "mailbox_thread_scope_required"].includes(clean(error?.message))) {
      throw policyError("mailbox_inbox_read_grant_required", 403);
    }
    throw error;
  }

  // Shadow mode is observational. Raw message data is never a rollout
  // fallback, and the empty response omits counts/cursors that reveal traffic.
  if (mode === "shadow" || decision.shadowDenied) {
    await auditRead({ decision, principal, outcome: "shadow", reason: "content_redacted" }, env);
    return { ok: true, mode, shadowDenied: true, messages: [], nextCursor: null };
  }

  if (typeof operations.beforeRead === "function") await operations.beforeRead();
  const fenced = await fenceThreadResourcePolicyDelivery((state) => {
    const resource = state.resources.find((item) => item.id === resourceId && item.resourceType === "mailbox");
    if (!resource || resource.status !== "active" || resource.retiredAt ||
      Number(state.revision) !== Number(decision.policyRevision) ||
      Number(resource.generation) !== Number(decision.resourceGeneration)) {
      throw policyError("mailbox_inbox_authorization_stale", 403);
    }
    return { result: projectSources(state, resourceId, decodedCursor, pageLimit, env), persist: false };
  }, env);
  await auditRead({ decision, principal, outcome: "allowed", reason: "managed_source_projection" }, env);
  return { ok: true, mode, shadowDenied: false, limit: pageLimit, ...fenced.result };
}
