import { appendEvent } from "../../storage/src/store.js";
import { ensureConnectorInboxEvent, markConnectorInboxEvent } from "../../connectors/src/connector-inbox.js";
import { enqueueMailboxThreadDeliveries } from "./mailbox-thread-delivery.js";
import { normalizeMailbox, publicMailbox } from "./mailbox-normalization.js";
import { adminPrincipal } from "./principal.js";
import { policyError } from "./policy.js";
import { readMailboxStore, writeMailboxStore } from "./mailboxes.js";
import {
  readThreadResourcePolicy,
  registerThreadResource,
  setThreadResourceGrants,
  threadResourceId,
} from "./thread-resource-grants.js";
import { getThread } from "./threads.js";

const clean = (value = "") => String(value || "").trim();

function assertRelayTarget(input = {}, env = process.env) {
  const expected = clean(env.ORKESTR_TENANT_VM_ID || env.ORKESTR_INSTANCE_ID);
  const supplied = clean(input.tenantVmId);
  if (!supplied) throw policyError("mailbox_vm_relay_target_required", 400);
  if (expected && supplied !== expected) throw policyError("mailbox_vm_relay_target_mismatch", 403);
}

async function upsertMailboxMirror(source = {}, env = process.env) {
  const mailbox = normalizeMailbox({
    ...source,
    targetType: "main",
    target: { type: "main", ownerUserId: source.ownerUserId },
    source: "vm-relay",
    status: source.status || "active",
  }, env);
  const store = await readMailboxStore(env);
  const existing = store.mailboxes.find((item) => normalizeMailbox(item, env).id === mailbox.id);
  if (existing) {
    const current = normalizeMailbox(existing, env);
    if (current.ownerUserId !== mailbox.ownerUserId || current.address !== mailbox.address) {
      throw policyError("mailbox_vm_relay_identity_conflict", 409);
    }
  }
  await writeMailboxStore({
    ...store,
    mailboxes: [...store.mailboxes.filter((item) => normalizeMailbox(item, env).id !== mailbox.id), mailbox],
  }, env);
  return mailbox;
}

async function ensureReadGrant(mailbox, threadId, env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw policyError("mailbox_vm_relay_thread_not_found", 409);
  if (clean(thread.ownerUserId) !== clean(mailbox.ownerUserId)) {
    throw policyError("mailbox_vm_relay_thread_owner_mismatch", 403);
  }
  const principal = adminPrincipal(env.ORKESTR_ADMIN_USER_ID || mailbox.ownerUserId);
  await registerThreadResource({
    resourceType: "mailbox",
    resourceId: mailbox.id,
    resourceKey: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    status: "active",
  }, { principal, source: "vm_mailbox_relay" }, env);
  const state = await readThreadResourcePolicy(env);
  const active = (state.grants || []).filter((grant) =>
    grant.threadId === threadId && grant.resourceType === "mailbox" && !grant.revokedAt
  );
  const resourceId = threadResourceId("mailbox", mailbox.id, mailbox.ownerUserId, env);
  if (active.some((grant) => grant.resourceId === resourceId && grant.permissions?.includes("read"))) return;
  const entries = active.map((grant) => ({
    resourceId: grant.resourceKey,
    resourceKey: grant.resourceKey,
    permissions: grant.permissions,
    expiresAt: grant.expiresAt || undefined,
  }));
  entries.push({ resourceId: mailbox.id, resourceKey: mailbox.id, permissions: ["discover", "read"] });
  await setThreadResourceGrants(threadId, "mailbox", entries, {
    principal,
    source: "vm_mailbox_relay",
    reason: "mailbox_targeted_to_tenant_vm",
  }, env);
}

export async function ingestVmMailboxRelay(input = {}, env = process.env) {
  assertRelayTarget(input, env);
  const idempotencyKey = clean(input.idempotencyKey);
  const threadId = clean(input.threadId || env.ORKESTR_MAILBOX_RELAY_THREAD_ID);
  if (!idempotencyKey) throw policyError("mailbox_vm_relay_idempotency_required", 400);
  if (!threadId) throw policyError("mailbox_vm_relay_thread_required", 409);
  const mailbox = await upsertMailboxMirror(input.mailbox || {}, env);
  await ensureReadGrant(mailbox, threadId, env);
  const inbox = await ensureConnectorInboxEvent({
    id: idempotencyKey,
    connector: "mailbox",
    accountId: mailbox.id,
    conversationId: mailbox.id,
    payload: input.message || {},
  }, env);
  if (inbox.event.state === "routed") {
    return { ok: true, action: "deduped", mailbox: publicMailbox(mailbox, env), threadId, idempotencyKey };
  }
  const delivery = await enqueueMailboxThreadDeliveries({
    mailbox,
    message: input.message || {},
    idempotencyKey,
  }, env);
  await markConnectorInboxEvent(idempotencyKey, {
    state: "routed",
    result: { threadId, deliveryIds: delivery.deliveryIds, sourceId: delivery.routeSource?.source?.id || "" },
  }, env);
  await appendEvent({
    type: "mailbox_vm_relay_received",
    mailboxId: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    tenantVmId: clean(input.tenantVmId),
    threadId,
    idempotencyKey,
  }, env).catch(() => {});
  return {
    ok: true,
    action: inbox.created ? "mailbox_vm_relay_stored" : "mailbox_vm_relay_recovered",
    mailbox: publicMailbox(mailbox, env),
    threadId,
    idempotencyKey,
    delivery,
  };
}
