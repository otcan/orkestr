// The SQLite policy store caches its parsed state between writes. A revoke
// must still apply to the very next decision, whether it was written by this
// process, by a write that keeps the policy revision, or by another process.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import { authorizeThreadResourceAccess, registerThreadResource, setThreadResourceGrants } from "../packages/core/src/thread-resource-grants.js";
import { readThreadResourceAccessState, readThreadResourcePolicyState, withThreadResourcePolicyTransaction } from "../packages/core/src/thread-resource-policy-store.js";

const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const principal = adminPrincipal("admin");

async function fixture(t, name) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-policy-cache-${name}-`));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_DESKTOP_ACCESS_MODE: "enforce" };
  const thread = await createThread({ id: "cache-thread", ownerUserId: "admin", name: "Cache" }, env);
  await registerThreadResource({ resourceType: "desktop", resourceKey: "example-desk", ownerUserId: "admin", status: "active" }, { principal }, env);
  await setThreadResourceGrants(thread.id, "desktop", [{ resourceKey: "example-desk", permissions: ["operate"] }], { principal }, env);
  const decide = async () => (await authorizeThreadResourceAccess({ principal, threadId: thread.id, resourceType: "desktop", resourceKey: "example-desk", permission: "operate" }, env)).allowed;
  // Warm both cached views so a stale entry would be served if invalidation failed.
  assert.equal(await decide(), true);
  await readThreadResourcePolicyState(env);
  return { home, env, thread, decide };
}

function activeGrants(state) {
  return state.grants.filter((grant) => !grant.revokedAt);
}

test("reads reuse a frozen parsed state and transactions get a mutable copy", async (t) => {
  const { env } = await fixture(t, "reuse");
  const first = await readThreadResourcePolicyState(env);
  assert.equal(await readThreadResourcePolicyState(env), first);
  assert.equal(await readThreadResourceAccessState(env), await readThreadResourceAccessState(env));
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.grants[0]));
  await withThreadResourcePolicyTransaction((state) => {
    assert.equal(Object.isFrozen(state.grants[0]), false);
    state.grants[0].permissions.push("share");
    return { state, persist: false };
  }, env);
  assert.deepEqual((await readThreadResourcePolicyState(env)).grants[0].permissions, ["operate"]);
});

test("a revoke in this process applies to the next decision", async (t) => {
  const { env, thread, decide } = await fixture(t, "local");
  await setThreadResourceGrants(thread.id, "desktop", [], { principal }, env);
  assert.equal(await decide(), false);
  assert.equal(activeGrants(await readThreadResourcePolicyState(env)).length, 0);
});

test("a write that keeps the policy revision still invalidates the cache", async (t) => {
  const { env, decide } = await fixture(t, "same-revision");
  const before = await readThreadResourcePolicyState(env);
  await withThreadResourcePolicyTransaction((state) => {
    for (const grant of state.grants) grant.revokedAt = new Date().toISOString();
    return { state };
  }, env);
  const after = await readThreadResourcePolicyState(env);
  assert.equal(after.revision, before.revision);
  assert.equal(activeGrants(after).length, 0);
  assert.equal(await decide(), false);
});

test("a revoke committed by another process applies to the next decision", async (t) => {
  const { home, env, thread, decide } = await fixture(t, "cross-process");
  const childEnv = { ...process.env, ...env };
  // Another Orkestr process revoking through the store API.
  const revoke = `
    const { adminPrincipal } = await import(${JSON.stringify(path.join(repo, "packages/core/src/principal.js"))});
    const { setThreadResourceGrants } = await import(${JSON.stringify(path.join(repo, "packages/core/src/thread-resource-grants.js"))});
    await setThreadResourceGrants(${JSON.stringify(thread.id)}, "desktop", [], { principal: adminPrincipal("admin") }, process.env);
  `;
  await run(process.execPath, ["--no-warnings", "--input-type=module", "-e", revoke], { env: childEnv });
  assert.equal(await decide(), false);

  // Re-grant here, then revoke from a raw connection that leaves the revision untouched.
  await setThreadResourceGrants(thread.id, "desktop", [{ resourceKey: "example-desk", permissions: ["operate"] }], { principal }, env);
  assert.equal(await decide(), true);
  const revision = (await readThreadResourcePolicyState(env)).revision;
  const rawRevoke = `
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(path.join(home, "thread-resource-policy.sqlite"))});
    db.exec("update orkestr_thread_resource_grants set revoked_at = '2026-01-01T00:00:00.000Z' where revoked_at is null");
    db.close();
  `;
  await run(process.execPath, ["--no-warnings", "--input-type=module", "-e", rawRevoke], { env: childEnv });
  assert.equal(await decide(), false);
  const state = await readThreadResourcePolicyState(env);
  assert.equal(state.revision, revision);
  assert.equal(activeGrants(state).length, 0);
});
