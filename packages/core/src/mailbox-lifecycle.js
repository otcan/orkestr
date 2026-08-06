import { appendEvent } from "../../storage/src/store.js";
import { cleanLower, mailboxError, nowIso, publicMailbox } from "./mailbox-normalization.js";
import {
  closedStatuses,
  createMailbox,
  getMailbox,
  idempotencyKey,
  mailboxForPrincipal,
  operationResult,
  readMailboxStore,
  recordOperation,
  replaceMailbox,
  writeMailboxStore,
} from "./mailboxes.js";

async function publicMailboxById(mailboxId, env = process.env) {
  const mailbox = await getMailbox(mailboxId, env);
  if (!mailbox) throw mailboxError("mailbox_not_found", 404);
  return publicMailbox(mailbox, env);
}

export async function verifyMailboxForPrincipal(mailboxId, input = {}, principal = {}, env = process.env) {
  const mailbox = await mailboxForPrincipal(mailboxId, principal, env);
  const key = idempotencyKey(input);
  const store = await readMailboxStore(env);
  const prior = operationResult(store, "mailbox.verify", key);
  if (prior?.mailboxId) return publicMailboxById(prior.mailboxId, env);

  const now = nowIso();
  const state = cleanLower(input.state || (input.verified === false ? "verification-pending" : "verified"));
  const verified = ["verified", "active", "complete", "completed"].includes(state);
  const next = await replaceMailbox(mailbox, {
    status: verified ? "active" : "verification-pending",
    verification: {
      ...mailbox.verification,
      state: verified ? "verified" : "pending",
      provider: input.provider || mailbox.verification.provider,
      requestedAt: mailbox.verification.requestedAt || now,
      verifiedAt: verified ? (input.verifiedAt || now) : mailbox.verification.verifiedAt,
      lastError: verified ? "" : input.lastError || mailbox.verification.lastError,
      attemptCount: Number(mailbox.verification.attemptCount || 0) + 1,
    },
  }, env);

  const latest = await readMailboxStore(env);
  await writeMailboxStore(recordOperation(latest, "mailbox.verify", key, { mailboxId: next.id }), env);
  await appendEvent({
    type: "mailbox_verification_updated",
    mailboxId: next.id,
    ownerUserId: next.ownerUserId,
    state: next.verification.state,
  }, env).catch(() => {});
  return publicMailbox(next, env);
}

export async function deleteMailboxForPrincipal(mailboxId, input = {}, principal = {}, env = process.env) {
  const mailbox = await mailboxForPrincipal(mailboxId, principal, env);
  const key = idempotencyKey(input);
  const store = await readMailboxStore(env);
  const prior = operationResult(store, "mailbox.delete", key);
  if (prior?.mailboxId) return publicMailboxById(prior.mailboxId, env);
  if (closedStatuses.has(mailbox.status)) return publicMailbox(mailbox, env);

  const now = nowIso();
  const next = await replaceMailbox(mailbox, {
    status: "deleted",
    deletedAt: mailbox.deletedAt || now,
    lifecycle: {
      ...mailbox.lifecycle,
      state: "deleted",
      propagationState: "pending",
      propagationStartedAt: now,
    },
  }, env);

  const latest = await readMailboxStore(env);
  await writeMailboxStore(recordOperation(latest, "mailbox.delete", key, { mailboxId: next.id }), env);
  await appendEvent({
    type: "mailbox_deleted",
    mailboxId: next.id,
    ownerUserId: next.ownerUserId,
    targetType: next.target.type,
    tenantVmId: next.target.tenantVmId || "",
  }, env).catch(() => {});
  return publicMailbox(next, env);
}

export async function rotateMailboxForPrincipal(mailboxId, input = {}, principal = {}, env = process.env) {
  const mailbox = await mailboxForPrincipal(mailboxId, principal, env);
  const key = idempotencyKey(input);
  const store = await readMailboxStore(env);
  const prior = operationResult(store, "mailbox.rotate", key);
  if (prior?.mailboxId) {
    return {
      oldMailbox: await publicMailboxById(mailbox.id, env),
      mailbox: await publicMailboxById(prior.mailboxId, env),
    };
  }
  if (closedStatuses.has(mailbox.status)) throw mailboxError("mailbox_not_rotatable", 409);

  const now = nowIso();
  const oldMailbox = await replaceMailbox(mailbox, {
    status: "rotated",
    rotatedAt: now,
    lifecycle: {
      ...mailbox.lifecycle,
      state: "rotated",
      propagationState: "pending",
      propagationStartedAt: now,
    },
  }, env);
  const next = await createMailbox({
    ownerUserId: mailbox.ownerUserId,
    displayName: input.displayName || mailbox.displayName,
    purpose: input.purpose || mailbox.purpose,
    suffix: input.suffix,
    status: input.status || "verification-pending",
    target: mailbox.target,
    targetSelection: mailbox.targetSelection,
    source: mailbox.source,
    verification: { state: "pending", provider: mailbox.verification.provider, requestedAt: now },
    idempotencyKey: key ? `${key}-create` : "",
  }, env);

  const latest = await readMailboxStore(env);
  await writeMailboxStore(recordOperation(latest, "mailbox.rotate", key, { mailboxId: next.id }), env);
  await appendEvent({
    type: "mailbox_rotated",
    mailboxId: oldMailbox.id,
    newMailboxId: next.id,
    ownerUserId: next.ownerUserId,
    targetType: next.target.type,
    tenantVmId: next.target.tenantVmId || "",
  }, env).catch(() => {});
  return { oldMailbox: publicMailbox(oldMailbox, env), mailbox: publicMailbox(next, env) };
}
