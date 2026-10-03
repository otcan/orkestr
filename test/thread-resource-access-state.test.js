// Access decisions read a narrow slice of the resource policy store (they run
// for every desktop asset and websocket). The slice must match the full state
// for everything a decision reads, and grant changes must apply immediately.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import { authorizeThreadResourceAccess, registerThreadResource, setThreadResourceGrants } from "../packages/core/src/thread-resource-grants.js";
import { readThreadResourceAccessState, readThreadResourcePolicyState, withThreadResourcePolicyTransaction } from "../packages/core/src/thread-resource-policy-store.js";
import { normalizeThreadResourcePolicyState } from "../packages/core/src/thread-resource-policy-model.js";

test("the access slice matches the full policy state and skips the heavy tables", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-resource-access-state-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_DESKTOP_ACCESS_MODE: "enforce" };
  const principal = adminPrincipal("admin");
  const thread = await createThread({ id: "access-thread", ownerUserId: "admin", name: "Access" }, env);
  await createThread({ id: "other-thread", ownerUserId: "admin", name: "Other" }, env);
  for (const slug of ["example-desk", "second-desk"]) {
    await registerThreadResource({ resourceType: "desktop", resourceKey: slug, ownerUserId: "admin", status: "active" }, { principal }, env);
  }
  await setThreadResourceGrants(thread.id, "desktop", [{ resourceKey: "example-desk", permissions: ["operate", "share"] }], { principal }, env);
  await withThreadResourcePolicyTransaction((state) => {
    state.mailboxDeliveries.push({
      id: "delivery", dedupeKey: "delivery", resourceType: "mailbox", resourceId: "mail-resource", mailboxId: "mailbox", listenerId: null,
      listenerGeneration: 0, threadId: null, state: "pending", epoch: 1, attemptCount: 0, maxAttempts: 5, nextAttemptAt: null, claimToken: null,
      claimExpiresAt: null, grantRevision: 0, policyRevision: state.revision, resourceGeneration: 1, messageKey: "key", payload: {}, reason: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deliveredAt: null,
    });
    return { state };
  }, env);

  const full = normalizeThreadResourcePolicyState(await readThreadResourcePolicyState(env), env);
  const slice = normalizeThreadResourcePolicyState(await readThreadResourceAccessState(env), env);
  for (const key of ["revision", "policies", "resources", "grants", "ceilings"]) assert.deepEqual(slice[key], full[key], key);
  assert.ok(full.mailboxDeliveries.length > 0 && full.policyAuditOutbox.length > 0);
  assert.deepEqual(slice.mailboxDeliveries, []);
  assert.deepEqual(slice.policyAuditOutbox, []);

  const decide = (threadId, desktop) => authorizeThreadResourceAccess({ principal, threadId, resourceType: "desktop", resourceKey: desktop, permission: "operate" }, env);
  assert.equal((await decide(thread.id, "example-desk")).allowed, true);
  assert.equal((await decide(thread.id, "second-desk")).reason, "desktop_grant_required");
  assert.equal((await decide("other-thread", "example-desk")).reason, "desktop_grant_required");

  // Revocation applies to the very next decision (nothing is cached).
  await setThreadResourceGrants(thread.id, "desktop", [], { principal }, env);
  assert.equal((await decide(thread.id, "example-desk")).reason, "desktop_grant_required");
});
