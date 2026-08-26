import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopAccessWarnings } from "../packages/browsers/src/desktop-access-warnings.js";
import { acquireDesktopLease, attachDesktopStateToSessions } from "../packages/browsers/src/desktop-leases.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";

async function fixture(extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-warning-"));
  return {
    ORKESTR_HOME: home,
    ORKESTR_DESKTOP_ACCESS_MODE: "shadow",
    ORKESTR_DESKTOP_LEASE_STALE_MS: "5",
    ...extra,
  };
}

test("expired running desktop produces structured lease and lifecycle warnings", () => {
  const warnings = desktopAccessWarnings({
    desktopSlug: "example-desk",
    threadId: "thread-next",
    operation: "connect",
    attemptId: "connect-1",
    session: { slug: "example-desk", status: "running" },
    lease: {
      id: "lease-old",
      desktopSlug: "example-desk",
      threadId: "thread-old",
      ownerThreadLabel: "Previous worker",
      expired: true,
      stale: true,
      stealable: true,
      ownerThreadExists: true,
    },
  });

  assert.deepEqual(warnings.map((warning) => warning.code), [
    "desktop_lease_expired",
    "desktop_lease_stale",
    "desktop_lease_owned_by_other_thread",
    "desktop_auto_stop_risk",
  ]);
  assert.equal(warnings.every((warning) => warning.attemptId === "connect-1"), true);
  assert.equal(warnings[0].blocking, true);
  assert.equal(warnings[0].lease.threadId, "thread-old");
  assert.equal(Object.prototype.hasOwnProperty.call(warnings[0].lease, "fencingToken"), false);
});

test("session inventory shows an expired lease warning before a user clicks connect", async () => {
  const env = await fixture();
  const thread = await createThread({ id: "warning-inventory-thread", ownerUserId: "admin", name: "Inventory thread" }, env);
  await acquireDesktopLease("example-desk", { threadId: thread.id, ttlMs: 1 }, env, { principal: adminPrincipal() });
  await new Promise((resolve) => setTimeout(resolve, 12));

  const [session] = await attachDesktopStateToSessions([{
    slug: "example-desk",
    status: "running",
    desktopAccess: { mode: "shadow", granted: true, shadowDenied: false, threadId: thread.id },
  }], env, { principal: adminPrincipal(), threadId: thread.id });

  assert.equal(session.lease.expired, true);
  assert.equal(session.warnings.some((warning) => warning.code === "desktop_lease_expired"), true);
  assert.equal(session.warnings.some((warning) => warning.code === "desktop_auto_stop_risk"), true);
});

test("a rejected lock attempt returns warnings only in its API result", async () => {
  const env = await fixture();
  const owner = await createThread({ id: "warning-owner", ownerUserId: "admin", name: "Lease owner" }, env);
  const contender = await createThread({ id: "warning-contender", ownerUserId: "admin", name: "Lease contender" }, env);
  await acquireDesktopLease("example-desk", { threadId: owner.id, ttlMs: 1 }, env, { principal: adminPrincipal() });
  await new Promise((resolve) => setTimeout(resolve, 12));

  const result = await acquireDesktopLease("example-desk", {
    threadId: contender.id,
    attemptId: "lock-attempt-1",
  }, env, { principal: adminPrincipal() });

  assert.equal(result.ok, false);
  assert.equal(result.warnings.some((warning) => warning.code === "desktop_lease_expired"), true);
  assert.equal(result.warnings.some((warning) => warning.code === "desktop_lease_owned_by_other_thread"), true);

  assert.equal(result.attemptId, "lock-attempt-1");
  assert.equal((await listThreadMessages(contender.id, env)).some((message) => message.source === "desktop-access-warning"), false);
});

test("a stopped desktop automatically releases an expired stealable lease and reserves it for the requester", async () => {
  const env = await fixture({ ORKESTR_DESKTOP_LEASE_STALE_MS: "60000" });
  const owner = await createThread({ id: "recovery-owner", ownerUserId: "admin", name: "Recovery owner" }, env);
  const requester = await createThread({ id: "recovery-requester", ownerUserId: "admin", name: "Recovery requester" }, env);
  await acquireDesktopLease("example-desk", { threadId: owner.id, ttlMs: 1 }, env, { principal: adminPrincipal() });
  await new Promise((resolve) => setTimeout(resolve, 12));

  const result = await acquireDesktopLease("example-desk", {
    threadId: requester.id,
    attemptId: "auto-recovery-1",
  }, env, {
    principal: adminPrincipal(),
    allowStoppedLeaseRecovery: true,
    desktopState: "stopped",
  });

  assert.equal(result.ok, true);
  assert.equal(result.autoRecovered, true);
  assert.deepEqual(result.recovery, {
    performed: true,
    reason: "expired_stopped_auto_recovery",
    desktopState: "stopped",
    previousLeaseId: result.previousLease.id,
    previousThreadId: owner.id,
  });
  assert.equal(result.lease.threadId, requester.id);
  assert.equal(result.previousLease.releaseReason, "expired_stopped_auto_recovery");
  assert.equal(result.warnings.some((warning) => warning.code === "desktop_lease_auto_recovered"), true);
  assert.equal(result.warnings.some((warning) => warning.blocking), false);
});

test("automatic lease recovery refuses running desktops and healthy stopped leases", async () => {
  const env = await fixture({ ORKESTR_DESKTOP_LEASE_STALE_MS: "60000" });
  const owner = await createThread({ id: "protected-owner", ownerUserId: "admin", name: "Protected owner" }, env);
  const requester = await createThread({ id: "protected-requester", ownerUserId: "admin", name: "Protected requester" }, env);
  await acquireDesktopLease("running-desk", { threadId: owner.id, ttlMs: 1 }, env, { principal: adminPrincipal() });
  await acquireDesktopLease("healthy-desk", { threadId: owner.id, ttlMs: 60_000 }, env, { principal: adminPrincipal() });
  await new Promise((resolve) => setTimeout(resolve, 12));

  const running = await acquireDesktopLease("running-desk", { threadId: requester.id }, env, {
    principal: adminPrincipal(),
    allowStoppedLeaseRecovery: true,
    desktopState: "running",
  });
  const healthy = await acquireDesktopLease("healthy-desk", { threadId: requester.id }, env, {
    principal: adminPrincipal(),
    allowStoppedLeaseRecovery: true,
    desktopState: "stopped",
  });

  assert.equal(running.ok, false);
  assert.equal(running.lease.threadId, owner.id);
  assert.equal(healthy.ok, false);
  assert.equal(healthy.lease.threadId, owner.id);
});
