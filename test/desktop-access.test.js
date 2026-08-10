import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authorizeDesktopAccess,
  advanceDesktopResourceGeneration,
  backfillThreadDesktopGrants,
  desktopAccessMode,
  listThreadDesktopGrants,
  setThreadDesktopGrants,
} from "../packages/core/src/desktop-access.js";
import { readThreadResourcePolicy } from "../packages/core/src/thread-resource-grants.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import { whereAmI } from "../packages/core/src/whereiam.js";
import { listBrowserSessions, openVirtualBrowser } from "../packages/browsers/src/browsers.js";
import {
  acquireDesktopLease,
  heartbeatDesktopLease,
  releaseDesktopLease,
} from "../packages/browsers/src/desktop-leases.js";
import {
  approveDesktopShareChallenge,
  createDesktopShare,
  desktopShareStatus,
  listDesktopShares,
  openDesktopShare,
} from "../packages/core/src/desktop-shares.js";

function testEnv(home) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_DESKTOP_ACCESS_MODE: "enforce",
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "linkedin,pa",
    ORKESTR_DESKTOP_CATALOG_JSON: JSON.stringify([
      { slug: "linkedin", label: "LinkedIn" },
      { slug: "pa", label: "PA" },
    ]),
    ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
  };
}

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-access-"));
  const env = testEnv(home);
  const principal = adminPrincipal("admin");
  const threadA = await createThread({ id: "thread-a", ownerUserId: "admin", name: "Thread A", cwd: path.join(home, "a") }, env);
  const threadB = await createThread({ id: "thread-b", ownerUserId: "admin", name: "Thread B", cwd: path.join(home, "b") }, env);
  await advanceDesktopResourceGeneration("linkedin", "admin", { reason: "fixture_desktop_lifecycle_registered" }, env);
  await advanceDesktopResourceGeneration("pa", "admin", { reason: "fixture_desktop_lifecycle_registered" }, env);
  await setThreadDesktopGrants(threadA.id, ["linkedin"], { principal, reason: "test" }, env);
  await setThreadDesktopGrants(threadB.id, ["pa"], { principal, reason: "test" }, env);
  return { home, env, principal, threadA, threadB };
}

function shareParts(value) {
  const parsed = new URL(value);
  return {
    shareId: parsed.pathname.split("/").filter(Boolean).at(-1),
    key: parsed.searchParams.get("key"),
  };
}

test("same-owner threads see and acquire only explicitly granted desktops", async () => {
  const { env, principal, threadA, threadB } = await fixture();

  const inventoryA = await listBrowserSessions(env, { principal, threadId: threadA.id });
  const inventoryB = await listBrowserSessions(env, { principal, threadId: threadB.id });
  assert.deepEqual(inventoryA.sessions.map((item) => item.slug), ["linkedin"]);
  assert.deepEqual(inventoryB.sessions.map((item) => item.slug), ["pa"]);

  await assert.rejects(
    () => acquireDesktopLease("pa", { threadId: threadA.id }, env, { principal }),
    /desktop_grant_required/,
  );
  const acquired = await acquireDesktopLease("linkedin", { threadId: threadA.id }, env, { principal });
  assert.equal(acquired.ok, true);
  assert.match(acquired.lease.fencingToken, /^[0-9a-f-]{36}$/i);

  await assert.rejects(
    () => openVirtualBrowser("linkedin", env, "", { principal, threadId: threadA.id }),
    /lease_fencing_token_required/,
  );
  const opened = await openVirtualBrowser("linkedin", env, "", {
    principal,
    threadId: threadA.id,
    fencingToken: acquired.lease.fencingToken,
  });
  assert.equal(opened.slug, "linkedin");
});

test("scoped enforcement protects both sides of an exact thread and desktop binding", async () => {
  const { env, principal, threadA, threadB } = await fixture();
  const resource = (await readThreadResourcePolicy(env)).resources.find((item) => item.resourceType === "desktop" && item.resourceKey === "linkedin");
  env.ORKESTR_DESKTOP_ACCESS_MODE = "shadow";
  env.ORKESTR_DESKTOP_ENFORCED_BINDINGS_JSON = JSON.stringify([
    { threadId: threadA.id, resourceId: resource.id },
  ]);

  assert.equal(desktopAccessMode(env), "shadow");
  assert.equal(desktopAccessMode(env, { threadId: threadA.id }), "enforce");
  assert.equal(desktopAccessMode(env, { desktopSlug: "linkedin" }), "enforce");
  assert.equal(desktopAccessMode(env, { threadId: threadB.id, desktopSlug: "pa" }), "shadow");

  const exact = await authorizeDesktopAccess({ principal, threadId: threadA.id, desktopSlug: "linkedin", permission: "operate" }, env);
  const protectedThreadDrift = await authorizeDesktopAccess({ principal, threadId: threadA.id, desktopSlug: "pa", permission: "operate" }, env);
  const protectedDesktopDrift = await authorizeDesktopAccess({ principal, threadId: threadB.id, desktopSlug: "linkedin", permission: "operate" }, env);
  const unrelated = await authorizeDesktopAccess({ principal, threadId: threadB.id, desktopSlug: "pa", permission: "operate" }, env);
  assert.equal(exact.allowed, true);
  assert.equal(exact.mode, "enforce");
  assert.equal(protectedThreadDrift.allowed, false);
  assert.equal(protectedThreadDrift.mode, "enforce");
  assert.equal(protectedDesktopDrift.allowed, false);
  assert.equal(protectedDesktopDrift.mode, "enforce");
  assert.equal(unrelated.allowed, true);
  assert.equal(unrelated.mode, "shadow");

  await assert.rejects(
    () => acquireDesktopLease("linkedin", { threadId: threadA.id, mode: "shared" }, env, { principal }),
    /desktop_lease_must_be_exclusive/,
  );
  const unrelatedLease = await acquireDesktopLease("pa", { threadId: threadB.id, ttlMs: 0 }, env, { principal });
  assert.equal(unrelatedLease.ok, true);
  assert.equal(unrelatedLease.lease.expiresAt, null);

  env.ORKESTR_DESKTOP_ENFORCED_BINDINGS_JSON = "not-json";
  assert.equal(desktopAccessMode(env, { threadId: threadB.id, desktopSlug: "pa" }), "enforce");
});

test("desktop enforce grants require lifecycle registration while rollout modes retain catalog compatibility", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-grant-registration-"));
  const env = testEnv(home);
  const principal = adminPrincipal("admin");
  const strictThread = await createThread({ id: "desktop-strict", ownerUserId: "admin", name: "Desktop strict" }, env);
  await assert.rejects(
    () => setThreadDesktopGrants(strictThread.id, ["unregistered-desktop"], { principal, reason: "must_be_lifecycle_registered" }, env),
    /thread_resource_not_registered/,
  );
  await advanceDesktopResourceGeneration("registered-desktop", "admin", { reason: "desktop_lifecycle_started" }, env);
  const registered = await setThreadDesktopGrants(strictThread.id, ["registered-desktop"], { principal, reason: "lifecycle_registered" }, env);
  assert.equal(registered.grants.length, 1);

  for (const mode of ["shadow", "off"]) {
    env.ORKESTR_DESKTOP_ACCESS_MODE = mode;
    const legacyThread = await createThread({ id: `desktop-${mode}`, ownerUserId: "admin", name: `Desktop ${mode}` }, env);
    const legacy = await setThreadDesktopGrants(legacyThread.id, [`legacy-${mode}-desktop`], { principal, reason: "rollout_catalog_compatibility" }, env);
    assert.equal(legacy.grants.length, 1);
  }
});

test("a scoped enforced thread cannot create a grant from shadow catalog compatibility", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-scoped-registration-"));
  const env = { ...testEnv(home), ORKESTR_DESKTOP_ACCESS_MODE: "shadow" };
  const principal = adminPrincipal("admin");
  const thread = await createThread({ id: "scoped-strict", ownerUserId: "admin", name: "Scoped strict" }, env);
  env.ORKESTR_DESKTOP_ENFORCED_BINDINGS_JSON = JSON.stringify([
    { threadId: thread.id, resourceId: "local:admin:not-registered" },
  ]);
  await assert.rejects(
    () => setThreadDesktopGrants(thread.id, ["not-registered"], { principal, reason: "scoped_strict" }, env),
    /thread_resource_not_registered/,
  );
});

test("child agents inherit parent grants but cannot widen an explicit child policy", async () => {
  const { env, principal, threadA } = await fixture();
  const inherited = await createThread({
    id: "child-inherited",
    ownerUserId: "admin",
    name: "Inherited child",
    parentThreadId: threadA.id,
    threadKind: "task-agent",
  }, env);
  const restricted = await createThread({
    id: "child-restricted",
    ownerUserId: "admin",
    name: "Restricted child",
    parentThreadId: threadA.id,
    threadKind: "task-agent",
  }, env);
  await setThreadDesktopGrants(restricted.id, ["pa"], { principal, reason: "narrow child" }, env);

  const inheritedLinkedIn = await authorizeDesktopAccess({ principal, threadId: inherited.id, desktopSlug: "linkedin", permission: "operate" }, env);
  const inheritedPa = await authorizeDesktopAccess({ principal, threadId: inherited.id, desktopSlug: "pa", permission: "operate" }, env);
  const restrictedLinkedIn = await authorizeDesktopAccess({ principal, threadId: restricted.id, desktopSlug: "linkedin", permission: "operate" }, env);
  const restrictedPa = await authorizeDesktopAccess({ principal, threadId: restricted.id, desktopSlug: "pa", permission: "operate" }, env);

  assert.equal(inheritedLinkedIn.allowed, true);
  assert.equal(inheritedLinkedIn.reason, "desktop_grant_inherited");
  assert.equal(inheritedPa.allowed, false);
  assert.equal(restrictedLinkedIn.allowed, false);
  assert.equal(restrictedPa.allowed, false);
});

test("lease fencing rejects stale holders after forced takeover", async () => {
  const { env, principal, threadA } = await fixture();
  const first = await acquireDesktopLease("linkedin", { threadId: threadA.id }, env, { principal });
  const replacementThread = await createThread({ id: "thread-replacement", ownerUserId: "admin", name: "Replacement" }, env);
  await setThreadDesktopGrants(replacementThread.id, ["linkedin"], { principal, reason: "replacement" }, env);
  const breakGlassPrincipal = { ...principal, authenticatedAt: new Date().toISOString() };
  const second = await acquireDesktopLease("linkedin", {
    threadId: replacementThread.id,
    force: true,
    reason: "attended takeover",
    breakGlassReason: "attended takeover",
    breakGlassChangeRef: "CHG-DESKTOP-TAKEOVER",
  }, env, {
    principal: breakGlassPrincipal,
    breakGlass: true,
    breakGlassReason: "attended takeover",
    breakGlassChangeRef: "CHG-DESKTOP-TAKEOVER",
  });

  assert.notEqual(first.lease.fencingToken, second.lease.fencingToken);
  assert.ok(second.lease.fencingVersion > first.lease.fencingVersion);
  const staleHeartbeat = await heartbeatDesktopLease("linkedin", threadA.id, env, {
    principal,
    fencingToken: first.lease.fencingToken,
  });
  assert.equal(staleHeartbeat.ok, false);
  assert.equal(staleHeartbeat.reason, "lease_owned_by_other_thread");
  const currentHeartbeat = await heartbeatDesktopLease("linkedin", replacementThread.id, env, {
    principal,
    fencingToken: second.lease.fencingToken,
  });
  assert.equal(currentHeartbeat.ok, true);
  const staleRelease = await releaseDesktopLease("linkedin", {
    principal,
    threadId: replacementThread.id,
    fencingToken: first.lease.fencingToken,
  }, env);
  assert.equal(staleRelease.ok, false);
  assert.equal(staleRelease.reason, "lease_fencing_token_invalid");
});

test("concurrent lease acquisition has exactly one winner", async () => {
  const { env, principal, threadA } = await fixture();
  const contender = await createThread({ id: "thread-contender", ownerUserId: "admin", name: "Contender" }, env);
  await setThreadDesktopGrants(contender.id, ["linkedin"], { principal, reason: "contender" }, env);
  const results = await Promise.all([
    acquireDesktopLease("linkedin", { threadId: threadA.id }, env, { principal }),
    acquireDesktopLease("linkedin", { threadId: contender.id }, env, { principal }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.error === "desktop_leased").length, 1);
});

test("desktop shares are invalidated when their thread grant is replaced", async () => {
  const { env, principal, threadA } = await fixture();
  const created = await createDesktopShare({ desktopSlug: "linkedin", principal, threadId: threadA.id, env });
  const { shareId, key } = shareParts(created.url);
  const opened = await openDesktopShare({ shareId, key, subdomain: created.subdomain, env });
  await approveDesktopShareChallenge(opened.attempt.challenge, { env, approvedBy: threadA.id });
  const ready = await desktopShareStatus({
    shareId,
    key,
    subdomain: created.subdomain,
    browserToken: opened.cookie.value.split(":")[1],
    env,
  });
  assert.equal(ready.approved, true);

  await setThreadDesktopGrants(threadA.id, [], { principal, reason: "revoke" }, env);
  await assert.rejects(
    () => desktopShareStatus({ shareId, key, subdomain: created.subdomain, browserToken: opened.cookie.value.split(":")[1], env }),
    /desktop_grant_required/,
  );
  const lifecycle = await listDesktopShares({ ownerUserId: "admin", threadId: threadA.id, env });
  const invalidated = lifecycle.shares.find((share) => share.id === shareId);
  assert.equal(invalidated?.status, "revoked");
  assert.equal(invalidated?.attempts[0]?.status, "approved");
  assert.ok(invalidated?.attempts[0]?.approvedAt);
  assert.ok(invalidated?.attempts[0]?.expiresAt);
  assert.equal(Object.hasOwn(invalidated?.attempts[0] || {}, "challenge"), false);
});

test("desktop shares are invalidated when the desktop runtime generation advances", async () => {
  const { env, principal, threadA } = await fixture();
  const created = await createDesktopShare({ desktopSlug: "linkedin", principal, threadId: threadA.id, env });
  const { shareId, key } = shareParts(created.url);
  const opened = await openDesktopShare({ shareId, key, subdomain: created.subdomain, env });
  await approveDesktopShareChallenge(opened.attempt.challenge, { env, approvedBy: threadA.id });

  await advanceDesktopResourceGeneration("linkedin", "admin", { reason: "test_restart" }, env);

  await assert.rejects(
    () => desktopShareStatus({ shareId, key, subdomain: created.subdomain, browserToken: opened.cookie.value.split(":")[1], env }),
    /desktop_share_generation_changed/,
  );
});

test("break-glass desktop shares require session-backed recent auth and retain the exact audited reference", async () => {
  const { env, principal } = await fixture();
  const breakGlassThread = await createThread({ id: "thread-break-glass", ownerUserId: "admin", name: "Break glass" }, env);
  await advanceDesktopResourceGeneration("linkedin", "admin", { reason: "register_for_break_glass" }, env);
  const request = {
    desktopSlug: "linkedin", principal, threadId: breakGlassThread.id, breakGlass: true,
    breakGlassReason: "incident", breakGlassChangeRef: "CHG-DESKTOP-1", env,
  };
  await assert.rejects(() => createDesktopShare(request), /desktop_break_glass_requirements_missing/);

  const authenticatedPrincipal = { ...principal, authenticatedAt: new Date().toISOString() };
  const created = await createDesktopShare({ ...request, principal: authenticatedPrincipal });
  const ttlMs = Date.parse(created.share.expiresAt) - Date.parse(created.share.createdAt);
  assert.equal(ttlMs <= 5 * 60_000 + 1_000, true);
  const { shareId, key } = shareParts(created.url);
  const opened = await openDesktopShare({ shareId, key, subdomain: created.subdomain, env });
  assert.equal(opened.ok, true);
  const audit = (await readThreadResourcePolicy(env)).policyAuditOutbox.find((item) =>
    item.action === "break_glass" && item.changeRef === "CHG-DESKTOP-1" && item.threadId === breakGlassThread.id,
  );
  assert.ok(audit);
  assert.equal(audit.resourceType, "desktop");
  assert.equal(audit.permission, "share");
});

test("whereiam desktop inventory is keyed and filtered by thread policy revision", async () => {
  const { env, threadA, threadB } = await fixture();
  await fs.mkdir(threadA.cwd, { recursive: true });
  await fs.mkdir(threadB.cwd, { recursive: true });

  const whereA = await whereAmI({ threadId: threadA.id, cwd: threadA.cwd }, env);
  const whereB = await whereAmI({ threadId: threadB.id, cwd: threadB.cwd }, env);
  assert.deepEqual(whereA.desktops.desktops.map((item) => item.slug), ["linkedin"]);
  assert.deepEqual(whereB.desktops.desktops.map((item) => item.slug), ["pa"]);
  assert.equal(whereA.desktops.access.mode, "enforce");
  assert.notEqual(whereA.desktops.access.threadId, whereB.desktops.access.threadId);

  const grants = await listThreadDesktopGrants(threadA.id, adminPrincipal("admin"), env);
  assert.deepEqual(grants.grants.map((grant) => grant.desktopSlug), ["linkedin"]);
});

test("migration backfills only explicit desktop metadata and quarantines name-only guesses", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-access-migration-"));
  const env = testEnv(home);
  const principal = adminPrincipal("admin");
  await createThread({
    id: "explicit-thread",
    ownerUserId: "admin",
    name: "General",
    executor: { metadata: { desktopSlug: "pa" } },
  }, env);
  await createThread({ id: "linkedin-name-only", ownerUserId: "admin", name: "LinkedIn Jobs" }, env);

  const dryRun = await backfillThreadDesktopGrants({ principal, dryRun: true }, env);
  assert.deepEqual(dryRun.planned.map((item) => item.threadId), ["explicit-thread"]);
  assert.deepEqual(dryRun.ambiguous.map((item) => item.threadId), ["linkedin-name-only"]);

  await advanceDesktopResourceGeneration("pa", "admin", { reason: "migration_desktop_lifecycle_registered" }, env);
  const applied = await backfillThreadDesktopGrants({ principal, dryRun: false }, env);
  assert.deepEqual(applied.applied, [{ threadId: "explicit-thread", desktopSlugs: ["pa"] }]);
  const explicit = await authorizeDesktopAccess({ principal, threadId: "explicit-thread", desktopSlug: "pa", permission: "discover" }, env);
  const guessed = await authorizeDesktopAccess({ principal, threadId: "linkedin-name-only", desktopSlug: "linkedin", permission: "discover" }, env);
  assert.equal(explicit.allowed, true);
  assert.equal(guessed.allowed, false);
});
