import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import {
  advanceThreadResourceGeneration,
  authorizeThreadResourceAccess,
  registerThreadResource,
  setThreadResourceGrants,
  threadResourceWritePlan,
  readThreadResourcePolicy,
} from "../packages/core/src/thread-resource-grants.js";
import { createMailboxThreadListener } from "../packages/core/src/mailbox-thread-delivery.js";
import { claimThreadResourcePolicyAuditOutbox, markThreadResourcePolicyAuditOutboxDelivered } from "../packages/core/src/thread-resource-policy-audit-outbox.js";
import { backfillExplicitThreadResources, explicitThreadResourceBackfillPlan } from "../packages/core/src/thread-resource-backfill.js";
import { threadResourcePolicyDoctorReport } from "../packages/core/src/thread-resource-policy-doctor.js";
import { withThreadResourcePolicyTransaction } from "../packages/core/src/thread-resource-policy-store.js";

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-resource-policy-operations-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_DESKTOP_ACCESS_MODE: "enforce",
    ORKESTR_OXRM_ACCESS_MODE: "enforce",
    ORKESTR_MAILBOX_ACCESS_MODE: "enforce",
  };
  const principal = adminPrincipal("admin");
  const thread = await createThread({ id: "policy-thread", ownerUserId: "admin", name: "Policy" }, env);
  return { home, env, principal, thread };
}

test("resource policy doctor reports only aggregate diagnostics and evidence-only backfill", async () => {
  const { env, principal, thread } = await fixture();
  await registerThreadResource({ resourceType: "oxrm", resourceId: "xrm-live", ownerUserId: "admin", status: "active" }, { principal }, env);
  await setThreadResourceGrants(thread.id, "oxrm", [{ resourceId: "xrm-live", permissions: ["read"] }], { principal }, env);
  await createThread({
    id: "explicit-backfill", ownerUserId: "admin", name: "Do not infer xrm from this name",
    executor: { metadata: {
      resourceResources: [{ resourceType: "oxrm", resourceId: "xrm-explicit" }],
      resourceGrants: [{ resourceType: "oxrm", resourceId: "xrm-explicit", permissions: ["read"] }],
    } },
  }, env);
  await createThread({
    id: "ambiguous-backfill", ownerUserId: "admin", name: "Mailbox name is not evidence",
    executor: { metadata: { resourceGrants: [{ resourceType: "mailbox", resourceId: "mail-explicit" }] } },
  }, env);
  await createThread({ id: "name-only", ownerUserId: "admin", name: "xrm-name-only mailbox-name-only" }, env);
  await withThreadResourcePolicyTransaction((state) => {
    state.mailboxDeliveries.push({
      id: "stale-delivery", dedupeKey: "stale-delivery", resourceType: "mailbox", resourceId: "mail-resource",
      mailboxId: "mailbox", listenerId: null, listenerGeneration: 0, threadId: null, state: "dead-letter",
      epoch: 1, attemptCount: 5, maxAttempts: 5, nextAttemptAt: null, claimToken: null, claimExpiresAt: null,
      grantRevision: 0, policyRevision: state.revision, resourceGeneration: 1, messageKey: "hashed-key",
      payload: {}, reason: "test", createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(), deliveredAt: null,
    });
    return { state };
  }, env);

  const plan = await explicitThreadResourceBackfillPlan(env);
  assert.equal(plan.plannedResources.some((item) => item.nativeId === "xrm-explicit"), true);
  assert.equal(plan.plannedResources.some((item) => item.threadId === "ambiguous-backfill"), false);
  assert.equal(plan.plannedResources.some((item) => item.threadId === "name-only"), false);
  assert.equal(plan.ambiguous.some((item) => item.reason === "explicit_grant_permissions_missing_or_invalid"), true);
  const report = await threadResourcePolicyDoctorReport(env);
  assert.equal(report.health, "healthy");
  assert.equal(report.counts.resources.oxrm, 1);
  assert.equal(report.queue.deadLetter, 1);
  assert.equal(report.evidence.ambiguous, 1);
  assert.equal(report.evidence.unregistered, 1);
  assert.equal(report.evidence.plannedResources, 1);
  assert.equal(JSON.stringify(report).includes("xrm-live"), false);
  assert.equal(JSON.stringify(report).includes("mail-explicit"), false);
  await assert.rejects(
    () => readThreadResourcePolicy({ ...env, ORKESTR_THREAD_RESOURCE_POLICY_STORE: "postgres://audit-token@private.example.test" }),
    /thread_resource_policy_store_mode_invalid/,
  );
  const redactedBackend = await threadResourcePolicyDoctorReport({ ...env, ORKESTR_THREAD_RESOURCE_POLICY_STORE: "postgres://audit-token@private.example.test" });
  assert.equal(redactedBackend.backend, "invalid");
  assert.equal(redactedBackend.health, "unavailable");
  assert.equal(JSON.stringify(redactedBackend).includes("audit-token"), false);
  const state = await readThreadResourcePolicy(env);
  assert.equal(state.policyAuditOutbox.some((item) => item.action === "resource_registered"), true);
  assert.equal(state.policyAuditOutbox.some((item) => item.action === "grants_replaced"), true);
});

test("doctor does not initialize disabled policy storage and only flags invalid listener epochs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-resource-policy-doctor-off-"));
  const offEnv = {
    ORKESTR_HOME: home,
    ORKESTR_DESKTOP_ACCESS_MODE: "off",
    ORKESTR_OXRM_ACCESS_MODE: "off",
    ORKESTR_MAILBOX_ACCESS_MODE: "off",
  };
  const disabled = await threadResourcePolicyDoctorReport(offEnv);
  assert.equal(disabled.health, "not_initialized");
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.coverage.resourceSessions, "unsupported");
  assert.equal(disabled.stale.sessions, 0);
  assert.equal(await fs.stat(path.join(home, "thread-resource-policy.sqlite")).then(() => true, () => false), false);

  const { env, principal, thread } = await fixture();
  const mailbox = { id: "doctor-mailbox", ownerUserId: "admin", target: { type: "main" } };
  await registerThreadResource({ resourceType: "mailbox", resourceId: mailbox.id, ownerUserId: "admin", status: "active" }, { principal }, env);
  await setThreadResourceGrants(thread.id, "mailbox", [{ resourceId: mailbox.id, permissions: ["subscribe"] }], { principal }, env);
  const listener = await createMailboxThreadListener({ mailbox, threadId: thread.id, principal }, env);
  await withThreadResourcePolicyTransaction((state) => {
    const live = state.mailboxListeners.find((item) => item.id === listener.listener.id);
    live.updatedAt = new Date(Date.now() - (7 * 24 * 60 * 60_000)).toISOString();
    return { state };
  }, env);
  const valid = await threadResourcePolicyDoctorReport(env);
  assert.equal(valid.stale.listeners, 0);
  await advanceThreadResourceGeneration("mailbox", mailbox.id, "admin", { principal }, env);
  const invalid = await threadResourcePolicyDoctorReport(env);
  assert.equal(invalid.stale.listeners, 1);
});

test("doctor evaluates inherited listener grants through child deny-all policy without side effects", async () => {
  const { env, principal } = await fixture();
  const parent = await createThread({ id: "listener-parent", ownerUserId: "admin", name: "Parent" }, env);
  const mailbox = { id: "inherited-listener-mailbox", ownerUserId: "admin", target: { type: "main" } };
  await registerThreadResource({ resourceType: "mailbox", resourceId: mailbox.id, ownerUserId: "admin", status: "active" }, { principal }, env);
  await setThreadResourceGrants(parent.id, "mailbox", [{ resourceId: mailbox.id, permissions: ["subscribe"] }], { principal }, env);
  const child = await createThread({ id: "listener-child", ownerUserId: "admin", name: "Child", parentThreadId: parent.id }, env);
  const listener = await createMailboxThreadListener({ mailbox, threadId: child.id, principal }, env);
  assert.ok(listener.listener.id);

  await setThreadResourceGrants(child.id, "mailbox", [], { principal }, env);
  const before = await readThreadResourcePolicy(env);
  const report = await threadResourcePolicyDoctorReport(env);
  const after = await readThreadResourcePolicy(env);
  assert.equal(report.stale.listeners, 1);
  assert.equal(after.revision, before.revision);
  assert.equal(after.policyAuditOutbox.length, before.policyAuditOutbox.length);
});

test("audit outbox preserves old rows across policy mutations and supports claim delivery", async () => {
  const { env, principal } = await fixture();
  const oldRows = Array.from({ length: 2001 }, (_, index) => ({
    id: `old-audit-${index}`, action: "historic_policy_mutation", resourceType: "oxrm", outcome: "allowed",
    actorUserId: "admin", reason: "historic", expiresAt: null, policyRevision: 1, state: "pending",
    claimToken: null, claimExpiresAt: null, deliveredAt: null, createdAt: new Date(1_700_000_000_000 + index).toISOString(),
  }));
  await withThreadResourcePolicyTransaction((state) => ({ state, auditOutboxUpserts: oldRows }), env);
  await registerThreadResource({ resourceType: "mailbox", resourceId: "audit-followup", ownerUserId: "admin", status: "active" }, { principal }, env);
  const preserved = await readThreadResourcePolicy(env);
  assert.equal(preserved.policyAuditOutbox.some((item) => item.id === "old-audit-0"), true);
  assert.equal(preserved.policyAuditOutbox.some((item) => item.id === "old-audit-2000"), true);
  assert.equal(preserved.policyAuditOutbox.length > 2001, true);

  const claimed = await claimThreadResourcePolicyAuditOutbox({ limit: 1 }, env);
  assert.equal(claimed.records.length, 1);
  const marked = await markThreadResourcePolicyAuditOutboxDelivered({ claimToken: claimed.claimToken, ids: claimed.records[0].id }, env);
  assert.equal(marked.delivered, 1);
  const report = await threadResourcePolicyDoctorReport(env);
  assert.equal(report.outbox.delivered, 1);
  assert.equal(report.outbox.pending > 0, true);
});

test("explicit resource backfill applies only registered metadata evidence", async () => {
  const { env, principal } = await fixture();
  const thread = await createThread({
    id: "apply-backfill", ownerUserId: "admin", name: "Unrelated name",
    executor: { metadata: {
      resourceResources: [{ resourceType: "oxrm", resourceId: "xrm-apply" }, { resourceType: "mailbox", resourceId: "mail-apply" }],
      resourceGrants: [
        { resourceType: "oxrm", resourceId: "xrm-apply", permissions: ["read"] },
        { resourceType: "mailbox", resourceId: "mail-apply", permissions: ["subscribe"] },
      ],
    } },
  }, env);
  const applied = await backfillExplicitThreadResources({ principal, dryRun: false }, env);
  assert.equal(applied.appliedResources.length, 2);
  assert.equal(applied.appliedGrants.length, 2);
  const decision = await authorizeThreadResourceAccess({ principal, threadId: thread.id, resourceType: "oxrm", resourceId: "xrm-apply", permission: "read" }, env);
  assert.equal(decision.granted, true);
  const mailboxDecision = await authorizeThreadResourceAccess({ principal, threadId: thread.id, resourceType: "mailbox", resourceId: "mail-apply", permission: "subscribe" }, env);
  assert.equal(mailboxDecision.granted, true);
});

test("unsupported legacy policy write modes fail closed and advertise only real rollback", async () => {
  const { env, principal } = await fixture();
  const plan = threadResourceWritePlan("mailbox", { ...env, ORKESTR_MAILBOX_WRITE_MODE: "legacy" });
  assert.equal(plan.effective, "unsupported");
  assert.equal(plan.rollback.supported, true);
  assert.equal(plan.rollback.preservesUnifiedRecords, true);
  await assert.rejects(
    () => registerThreadResource({ resourceType: "oxrm", resourceId: "xrm-blocked", ownerUserId: "admin" }, { principal }, { ...env, ORKESTR_OXRM_WRITE_MODE: "dual" }),
    /thread_resource_legacy_write_mode_unsupported/,
  );
  await assert.rejects(
    () => registerThreadResource({ resourceType: "oxrm", resourceId: "xrm-invalid", ownerUserId: "admin" }, { principal }, { ...env, ORKESTR_OXRM_WRITE_MODE: "unexpected" }),
    /thread_resource_legacy_write_mode_unsupported/,
  );
});
