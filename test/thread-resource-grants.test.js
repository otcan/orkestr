import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import {
  authorizeThreadResourceAccess,
  listThreadResourceGrants,
  setThreadResourceGrants,
} from "../packages/core/src/thread-resource-grants.js";
import { requireResolvedTargetInstance } from "../packages/core/src/target-resolver.js";

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-resource-policy-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_DESKTOP_ACCESS_MODE: "enforce",
    ORKESTR_OXRM_ACCESS_MODE: "enforce",
    ORKESTR_MAILBOX_ACCESS_MODE: "enforce",
  };
  const principal = adminPrincipal("admin");
  const parent = await createThread({ id: "parent", ownerUserId: "admin", name: "Parent" }, env);
  const sibling = await createThread({ id: "sibling", ownerUserId: "admin", name: "Sibling" }, env);
  return { home, env, principal, parent, sibling };
}

test("transactional resource policies isolate same-owner threads and persist an explicit empty policy", async () => {
  const { home, env, principal, parent, sibling } = await fixture();
  await setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-a", permissions: ["read", "execute"] }], { principal, idempotencyKey: "policy-a" }, env);
  await setThreadResourceGrants(sibling.id, "oxrm", [{ resourceId: "xrm-b", permissions: ["read"] }], { principal }, env);

  const parentA = await authorizeThreadResourceAccess({ principal, threadId: parent.id, resourceType: "oxrm", resourceId: "xrm-a", permission: "execute" }, env);
  const parentB = await authorizeThreadResourceAccess({ principal, threadId: parent.id, resourceType: "oxrm", resourceId: "xrm-b", permission: "read" }, env);
  const siblingA = await authorizeThreadResourceAccess({ principal, threadId: sibling.id, resourceType: "oxrm", resourceId: "xrm-a", permission: "read" }, env);
  assert.equal(parentA.granted, true);
  assert.equal(parentB.granted, false);
  assert.equal(siblingA.granted, false);

  const first = await listThreadResourceGrants(parent.id, "oxrm", principal, env);
  await setThreadResourceGrants(parent.id, "oxrm", [], { principal, expectedPolicyRevision: first.resourcePolicyRevision }, env);
  const after = await listThreadResourceGrants(parent.id, "oxrm", principal, env);
  assert.equal(after.grants.length, 0);
  assert.equal(after.explicitEmpty, true);
  assert.equal(after.policyRevision > first.policyRevision, true);
  assert.equal((await fs.stat(path.join(home, "thread-resource-policy.sqlite"))).isFile(), true);
  await assert.rejects(
    () => setThreadResourceGrants(parent.id, "oxrm", [], { principal, expectedPolicyRevision: first.resourcePolicyRevision }, env),
    /thread_resource_policy_revision_conflict/,
  );
});

test("child ceilings prevent later widening and parent revocation narrows immediately", async () => {
  const { env, principal, parent } = await fixture();
  await setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-a", permissions: ["read"] }], { principal }, env);
  const child = await createThread({ id: "child", ownerUserId: "admin", name: "Child", parentThreadId: parent.id, threadKind: "task-agent" }, env);

  const inherited = await authorizeThreadResourceAccess({ principal, threadId: child.id, resourceType: "oxrm", resourceId: "xrm-a", permission: "read" }, env);
  assert.equal(inherited.granted, true);
  assert.equal(inherited.reason, "oxrm_grant_inherited");

  await setThreadResourceGrants(parent.id, "oxrm", [
    { resourceId: "xrm-a", permissions: ["read"] },
    { resourceId: "xrm-b", permissions: ["read"] },
  ], { principal }, env);
  const widened = await authorizeThreadResourceAccess({ principal, threadId: child.id, resourceType: "oxrm", resourceId: "xrm-b", permission: "read" }, env);
  assert.equal(widened.granted, false);

  await setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-b", permissions: ["read"] }], { principal }, env);
  const revoked = await authorizeThreadResourceAccess({ principal, threadId: child.id, resourceType: "oxrm", resourceId: "xrm-a", permission: "read" }, env);
  assert.equal(revoked.granted, false);
});

test("oXRM resolution filters to grants before explicit or inferred selection", async () => {
  const { env, principal, parent } = await fixture();
  await setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-a", permissions: ["execute"] }], { principal }, env);
  const candidates = [
    { id: "xrm-a", type: "oxrm", ownerUserId: "admin", status: "active", eligible: true },
    { id: "xrm-b", type: "oxrm", ownerUserId: "admin", status: "active", eligible: true },
  ];
  const inferred = await requireResolvedTargetInstance({ targetType: "oxrm", threadId: parent.id, principal, action: "oxrm.skill.execute", candidates }, env);
  assert.equal(inferred.selectedTarget.id, "xrm-a");
  await assert.rejects(
    () => requireResolvedTargetInstance({ targetType: "oxrm", threadId: parent.id, explicitTargetId: "xrm-b", principal, action: "oxrm.skill.execute", candidates }, env),
    /target_unauthorized/,
  );
});

test("break-glass requires recent authentication and a change reference", async () => {
  const { env, principal, parent } = await fixture();
  const missing = await authorizeThreadResourceAccess({ principal, threadId: parent.id, resourceType: "desktop", resourceId: "desk-a", permission: "operate", breakGlass: true, breakGlassReason: "incident" }, env);
  assert.equal(missing.granted, false);
  const allowed = await authorizeThreadResourceAccess({
    principal, threadId: parent.id, resourceType: "desktop", resourceId: "desk-a", permission: "operate", breakGlass: true,
    breakGlassReason: "incident", breakGlassChangeRef: "CHG-123", recentAuthAt: new Date().toISOString(),
  }, env);
  assert.equal(allowed.breakGlass, true);
  assert.match(allowed.breakGlassExpiresAt, /T/);
});
