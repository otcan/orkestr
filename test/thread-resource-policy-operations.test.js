import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import {
  authorizeThreadResourceAccess,
  registerThreadResource,
  setThreadResourceGrants,
  threadResourceWritePlan,
  readThreadResourcePolicy,
} from "../packages/core/src/thread-resource-grants.js";
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
  const redactedBackend = await threadResourcePolicyDoctorReport({ ...env, ORKESTR_THREAD_RESOURCE_POLICY_STORE: "postgres://audit-token@private.example.test" });
  assert.equal(redactedBackend.backend, "sqlite");
  assert.equal(JSON.stringify(redactedBackend).includes("audit-token"), false);
  const state = await readThreadResourcePolicy(env);
  assert.equal(state.policyAuditOutbox.some((item) => item.action === "resource_registered"), true);
  assert.equal(state.policyAuditOutbox.some((item) => item.action === "grants_replaced"), true);
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
