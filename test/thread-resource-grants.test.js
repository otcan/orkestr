import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread, getThread } from "../packages/core/src/threads.js";
import {
  advanceThreadResourceGeneration,
  authorizeThreadResourceAccess,
  listThreadResourceGrants,
  setThreadResourceGrants,
  threadResourceId,
} from "../packages/core/src/thread-resource-grants.js";
import { readThreadResourcePolicyState } from "../packages/core/src/thread-resource-policy-store.js";
import { resolveTargetInstance, requireResolvedTargetInstance } from "../packages/core/src/target-resolver.js";
import { listEvents } from "../packages/storage/src/store.js";

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

test("an empty child snapshot remains denied after a later parent grant", async () => {
  const { env, principal, parent } = await fixture();
  const child = await createThread({ id: "empty-child", ownerUserId: "admin", name: "Empty child", parentThreadId: parent.id }, env);
  const state = await readThreadResourcePolicyState(env);
  const marker = state.policies.find((policy) => policy.threadId === child.id && policy.resourceType === "oxrm");
  assert.equal(marker?.inheritanceMode, "snapshot_ceiling");

  await setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "later-xrm", permissions: ["read"] }], { principal }, env);
  const decision = await authorizeThreadResourceAccess({ principal, threadId: child.id, resourceType: "oxrm", resourceId: "later-xrm", permission: "read" }, env);
  assert.equal(decision.granted, false);
});

test("declared child scope intersects the parent snapshot at creation", async () => {
  const { env, principal, parent } = await fixture();
  await setThreadResourceGrants(parent.id, "oxrm", [
    { resourceId: "xrm-a", permissions: ["read"] },
    { resourceId: "xrm-b", permissions: ["read"] },
  ], { principal }, env);
  const child = await createThread({
    id: "scoped-child", ownerUserId: "admin", name: "Scoped child", parentThreadId: parent.id,
    resourceGrants: [{ resourceType: "oxrm", resourceId: "xrm-a", permissions: ["read"] }],
  }, env);
  const allowed = await authorizeThreadResourceAccess({ principal, threadId: child.id, resourceType: "oxrm", resourceId: "xrm-a", permission: "read" }, env);
  const denied = await authorizeThreadResourceAccess({ principal, threadId: child.id, resourceType: "oxrm", resourceId: "xrm-b", permission: "read" }, env);
  assert.equal(allowed.granted, true);
  assert.equal(denied.granted, false);
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

test("shadow target resolution preserves legacy candidates and records the would-deny", async () => {
  const { env, principal, parent } = await fixture();
  env.ORKESTR_OXRM_ACCESS_MODE = "shadow";
  const result = await resolveTargetInstance({
    targetType: "oxrm", threadId: parent.id, explicitTargetId: "legacy-xrm", principal,
    action: "oxrm.skill.execute",
    candidates: [{ id: "legacy-xrm", type: "oxrm", ownerUserId: "admin", status: "active", eligible: true }],
  }, env);
  assert.equal(result.ok, true);
  assert.equal(result.selectedTarget.id, "legacy-xrm");
  const events = await listEvents(env, 20);
  assert.equal(events.some((event) => event.type === "thread_resource_access_shadow_denied" && event.resourceType === "oxrm"), true);
});

test("grant mutations reject unknown permissions and idempotent replays do not advance epochs", async () => {
  const { env, principal, parent } = await fixture();
  await assert.rejects(
    () => setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-a", permissions: ["read", "admin"] }], { principal }, env),
    /thread_resource_permissions_invalid/,
  );
  await assert.rejects(
    () => setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-a", permissions: ["*"] }], { principal }, env),
    /thread_resource_permissions_invalid/,
  );
  await assert.rejects(
    () => setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-a", permissions: [] }], { principal }, env),
    /thread_resource_permissions_invalid/,
  );
  const first = await setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-a", permissions: ["read"] }], { principal, idempotencyKey: "same-request" }, env);
  const before = await readThreadResourcePolicyState(env);
  const replay = await setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-a", permissions: ["read"] }], { principal, idempotencyKey: "same-request" }, env);
  const after = await readThreadResourcePolicyState(env);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.policyRevision, first.policyRevision);
  assert.equal(after.revision, before.revision);
});

test("resource identities bind native IDs to the owning boundary", async () => {
  const { home, env, principal } = await fixture();
  const alice = await createThread({ id: "alice-thread", ownerUserId: "alice", name: "Alice" }, env);
  const bob = await createThread({ id: "bob-thread", ownerUserId: "bob", name: "Bob" }, env);
  await setThreadResourceGrants(alice.id, "oxrm", [{ resourceId: "shared-native", permissions: ["read"] }], { principal }, env);
  await setThreadResourceGrants(bob.id, "oxrm", [{ resourceId: "shared-native", permissions: ["read"] }], { principal }, env);
  const aliceGrant = await listThreadResourceGrants(alice.id, "oxrm", principal, env);
  const bobGrant = await listThreadResourceGrants(bob.id, "oxrm", principal, env);
  assert.notEqual(aliceGrant.grants[0].resourceId, bobGrant.grants[0].resourceId);
  assert.equal(aliceGrant.grants[0].resourceId, threadResourceId("oxrm", "shared-native", "alice", env));
  const crossOwner = await authorizeThreadResourceAccess({ principal, threadId: alice.id, resourceType: "oxrm", resourceId: "shared-native", ownerUserId: "bob", permission: "read" }, env);
  assert.equal(crossOwner.granted, false);

  const vmEnv = { ...env, ORKESTR_HOME: home, ORKESTR_TENANT_VM_ID: "vm-b" };
  await setThreadResourceGrants(alice.id, "oxrm", [{ resourceId: "boundary-native", permissions: ["read"] }], { principal }, vmEnv);
  const crossBoundary = await authorizeThreadResourceAccess({ principal, threadId: alice.id, resourceType: "oxrm", resourceId: "boundary-native", boundaryId: "vm-b", permission: "read" }, env);
  assert.equal(crossBoundary.granted, false);
});

test("simultaneous CAS grant updates have one winner", async () => {
  const { env, principal, parent } = await fixture();
  const results = await Promise.allSettled([
    setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-a", permissions: ["read"] }], { principal, expectedPolicyRevision: 0 }, env),
    setThreadResourceGrants(parent.id, "oxrm", [{ resourceId: "xrm-b", permissions: ["read"] }], { principal, expectedPolicyRevision: 0 }, env),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && /thread_resource_policy_revision_conflict/.test(result.reason?.message)).length, 1);
});

test("child creation fails closed before the child becomes discoverable when policy capture fails", async () => {
  const { env, parent } = await fixture();
  const blocked = { ...env, ORKESTR_THREAD_RESOURCE_POLICY_STORE: "json" };
  await assert.rejects(
    () => createThread({ id: "held-child", ownerUserId: "admin", name: "Held", parentThreadId: parent.id }, blocked),
    /thread_resource_policy_transactional_store_required/,
  );
  assert.equal(await getThread("held-child", env), null);
});

test("break-glass requires recent authentication and a change reference", async () => {
  const { env, principal, parent } = await fixture();
  await advanceThreadResourceGeneration("desktop", "desk-a", "admin", {}, env);
  const missing = await authorizeThreadResourceAccess({ principal, threadId: parent.id, resourceType: "desktop", resourceKey: "desk-a", permission: "operate", breakGlass: true, breakGlassReason: "incident" }, env);
  assert.equal(missing.granted, false);
  const allowed = await authorizeThreadResourceAccess({
    principal, threadId: parent.id, resourceType: "desktop", resourceKey: "desk-a", permission: "operate", breakGlass: true,
    breakGlassReason: "incident", breakGlassChangeRef: "CHG-123", recentAuthAt: new Date().toISOString(),
  }, env);
  assert.equal(allowed.breakGlass, true);
  assert.match(allowed.breakGlassExpiresAt, /T/);
});

test("break-glass denies when its required audit cannot be persisted", async () => {
  const { home, env, principal, parent } = await fixture();
  await advanceThreadResourceGeneration("desktop", "desk-a", "admin", {}, env);
  await fs.rm(path.join(home, "events.jsonl"), { force: true });
  await fs.mkdir(path.join(home, "events.jsonl"));
  await assert.rejects(
    () => authorizeThreadResourceAccess({ principal, threadId: parent.id, resourceType: "desktop", resourceKey: "desk-a", permission: "operate", breakGlass: true, breakGlassReason: "incident", breakGlassChangeRef: "CHG-1", recentAuthAt: new Date().toISOString() }, env),
    /thread_resource_break_glass_audit_unavailable/,
  );
});
