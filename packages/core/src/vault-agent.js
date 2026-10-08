import { appendEvent } from "../../storage/src/store.js";
import { getThread } from "./threads.js";
import { normalizeUserId } from "./users.js";
import {
  assertVaultOwner,
  consumeVaultRateLimit,
  itemGrantedToThread,
  resolveAgentThread,
  vaultError,
} from "./vault-access.js";
import { issueCodeInStore } from "./vault-service.js";
import { findItem, mutateVault, nowIso, openRecord, randomId, readVault } from "./vault-store.js";

// Agent (thread) access and owner TOTP approvals.
//
// Agents only see items granted to their thread in the thread owner's vault.
// Username/password reads are automatic but rate limited and audited without
// values. Authenticator codes need a per-use owner approval: one approval
// releases exactly one code.

export const APPROVAL_TTL_MS = 5 * 60 * 1000;
const AGENT_FIELDS = new Set(["username", "password"]);

function clean(value) {
  return String(value ?? "").trim();
}

async function event(type, ownerUserId, fields = {}, env = process.env) {
  await appendEvent({ type, ownerUserId, ...fields }, env).catch(() => {});
}

function agentItemView(record = {}) {
  return {
    id: clean(record.id),
    name: clean(record.name),
    url: clean(record.url),
    domain: clean(record.domain),
    tags: Array.isArray(record.tags) ? record.tags : [],
    hasPassword: record.hasPassword === true,
    hasTotp: record.hasTotp === true,
  };
}

/** Finds a granted item by id, exact name or domain (case-insensitive). */
export function findGrantedItem(store, itemRef = "", threadId = "") {
  const ref = clean(itemRef);
  if (!ref) throw vaultError("vault_item_required", 400);
  const granted = store.items.filter((item) => itemGrantedToThread(item, threadId));
  const byId = granted.find((item) => item.id === ref);
  if (byId) return byId;
  const lowered = ref.toLowerCase();
  const matches = granted.filter((item) => clean(item.name).toLowerCase() === lowered || clean(item.domain) === lowered);
  if (matches.length > 1) throw vaultError("vault_item_ambiguous", 409);
  if (!matches.length) throw vaultError("vault_item_not_found", 404);
  return matches[0];
}

export async function agentListItems(threadRef, env = process.env) {
  const thread = await resolveAgentThread(threadRef, env);
  const store = await readVault(thread.ownerUserId, env);
  return {
    threadId: thread.threadId,
    items: store.items.filter((item) => itemGrantedToThread(item, thread.threadId)).map(agentItemView),
  };
}

/**
 * Returns the requested credential fields for a granted item. Audited per
 * field (no values) and rate limited per item + thread.
 */
export async function agentReadSecret(threadRef, itemRef, fields = ["username", "password"], env = process.env) {
  const requested = [...new Set((Array.isArray(fields) ? fields : [fields]).map(clean).filter(Boolean))];
  if (!requested.length || requested.some((field) => !AGENT_FIELDS.has(field))) throw vaultError("vault_field_invalid", 400);
  const thread = await resolveAgentThread(threadRef, env);
  const owner = thread.ownerUserId;
  const item = findGrantedItem(await readVault(owner, env), itemRef, thread.threadId);
  await consumeVaultRateLimit("agentRead", `${owner}:${item.id}:${thread.threadId}`, env);
  const payload = await mutateVault(owner, async (store) => {
    const record = findItem(store, item.id);
    if (!itemGrantedToThread(record, thread.threadId)) throw vaultError("vault_item_not_found", 404);
    record.lastUsedAt = nowIso();
    return openRecord(owner, record, env);
  }, env);
  const result = { itemId: item.id };
  for (const field of requested) {
    result[field] = String(payload[field] || "");
    await event("vault_secret_read", owner, { itemId: item.id, threadId: thread.threadId, field, principalKind: "agent" }, env);
  }
  return result;
}

function approvalStatus(approval = {}, nowMs = Date.now()) {
  const status = clean(approval.status) || "pending";
  if ((status === "pending" || status === "approved") && !(Date.parse(approval.expiresAt) > nowMs)) return "expired";
  return status;
}

function publicApproval(approval = {}, store = null, nowMs = Date.now()) {
  const item = store?.items?.find((entry) => entry.id === approval.itemId);
  return {
    id: approval.id,
    itemId: approval.itemId,
    itemName: clean(item?.name) || null,
    threadId: approval.threadId,
    threadName: clean(approval.threadName) || approval.threadId,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    status: approvalStatus(approval, nowMs),
  };
}

function agentApprovalView(approval, store, nowMs = Date.now()) {
  const { itemName, ...rest } = publicApproval(approval, store, nowMs);
  return rest;
}

/**
 * Agent TOTP request. With `approvalId` it checks/consumes that approval;
 * otherwise it consumes an approved approval, reports a pending one, or
 * creates a new pending approval. Returns `{ status, approval, code? ... }`.
 */
export async function agentRequestTotp(threadRef, itemRef, options = {}, env = process.env) {
  const thread = await resolveAgentThread(threadRef, env);
  const owner = thread.ownerUserId;
  const item = findGrantedItem(await readVault(owner, env), itemRef, thread.threadId);
  if (!item.hasTotp) throw vaultError("vault_totp_not_configured", 404);
  const approvalId = clean(options?.approvalId);
  const outcome = await mutateVault(owner, async (store) => {
    const nowMs = Date.now();
    const record = findItem(store, item.id);
    if (!itemGrantedToThread(record, thread.threadId)) throw vaultError("vault_item_not_found", 404);
    const mine = store.approvals.filter((entry) => entry.itemId === item.id && entry.threadId === thread.threadId);
    let approval = approvalId ? mine.find((entry) => entry.id === approvalId) : null;
    if (approvalId && !approval) throw vaultError("vault_approval_not_found", 404);
    if (!approval) {
      approval = mine.find((entry) => approvalStatus(entry, nowMs) === "approved") ||
        mine.find((entry) => approvalStatus(entry, nowMs) === "pending") || null;
    }
    if (approval && approvalStatus(approval, nowMs) === "approved") {
      const code = await issueCodeInStore(owner, store, item.id, env);
      approval.status = "consumed";
      approval.consumedAt = nowIso(nowMs);
      return { status: "issued", approval: agentApprovalView(approval, store, nowMs), ...code };
    }
    if (approval) return { status: approvalStatus(approval, nowMs), approval: agentApprovalView(approval, store, nowMs) };
    await consumeVaultRateLimit("agentTotp", `${owner}:${thread.threadId}`, env);
    const created = {
      id: randomId("vap"),
      itemId: item.id,
      threadId: thread.threadId,
      threadName: thread.threadName,
      status: "pending",
      createdAt: nowIso(nowMs),
      expiresAt: nowIso(nowMs + APPROVAL_TTL_MS),
    };
    store.approvals.push(created);
    return { status: "pending", created: true, approval: agentApprovalView(created, store, nowMs) };
  }, env);
  const fields = { itemId: item.id, threadId: thread.threadId, approvalId: outcome.approval.id };
  if (outcome.created) await event("vault_totp_requested", owner, fields, env);
  if (outcome.status === "issued") await event("vault_totp_issued", owner, fields, env);
  const { created, ...result } = outcome;
  return result;
}

export async function listVaultApprovals(principal, env = process.env) {
  const owner = assertVaultOwner(principal);
  const store = await readVault(owner, env);
  const nowMs = Date.now();
  const approvals = store.approvals
    .map((approval) => publicApproval(approval, store, nowMs))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  for (const approval of approvals) {
    if (approval.threadName !== approval.threadId) continue;
    const thread = await getThread(approval.threadId, env).catch(() => null);
    if (thread?.name) approval.threadName = thread.name;
  }
  return { approvals };
}

/** Owner decision on a pending approval: "approve" or "deny". */
export async function decideVaultApproval(principal, approvalId, decision, env = process.env) {
  const owner = assertVaultOwner(principal);
  if (decision !== "approve" && decision !== "deny") throw vaultError("vault_approval_decision_invalid", 400);
  const result = await mutateVault(owner, async (store) => {
    const nowMs = Date.now();
    const approval = store.approvals.find((entry) => entry.id === clean(approvalId));
    if (!approval) throw vaultError("vault_approval_not_found", 404);
    const status = approvalStatus(approval, nowMs);
    if (status !== "pending") throw vaultError(status === "expired" ? "vault_approval_expired" : "vault_approval_not_pending", 409);
    approval.status = decision === "approve" ? "approved" : "denied";
    approval.decidedAt = nowIso(nowMs);
    approval.decidedBy = normalizeUserId(principal.userId);
    // An approval gives the agent a fresh, short window to fetch its one code.
    if (decision === "approve") approval.expiresAt = nowIso(nowMs + APPROVAL_TTL_MS);
    return publicApproval(approval, store, nowMs);
  }, env);
  await event(decision === "approve" ? "vault_totp_approved" : "vault_totp_denied", owner, {
    itemId: result.itemId,
    threadId: result.threadId,
    approvalId: result.id,
  }, env);
  return { approval: result };
}
