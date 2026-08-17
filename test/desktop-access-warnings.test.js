import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopAccessWarnings } from "../packages/browsers/src/desktop-access-warnings.js";
import { acquireDesktopLease, attachDesktopStateToSessions } from "../packages/browsers/src/desktop-leases.js";
import { emitDesktopAccessChatWarning } from "../packages/core/src/desktop-access-chat-warning.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";

async function fixture(extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-warning-"));
  return {
    ORKESTR_HOME: home,
    ORKESTR_DESKTOP_ACCESS_MODE: "shadow",
    ORKESTR_DESKTOP_LEASE_STALE_MS: "5",
    ORKESTR_DESKTOP_ACCESS_CHAT_WARNINGS: "1",
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

test("a rejected lock attempt returns warnings and emits only one thread notification per attempt", async () => {
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

  const [first, repeated] = await Promise.all([
    emitDesktopAccessChatWarning({ threadId: contender.id, attemptId: result.attemptId, warnings: result.warnings }, env),
    emitDesktopAccessChatWarning({ threadId: contender.id, attemptId: result.attemptId, warnings: result.warnings }, env),
  ]);
  const messages = (await listThreadMessages(contender.id, env)).filter((message) => message.source === "desktop-access-warning");
  assert.equal(messages.length, 1);
  assert.equal([first.emitted, repeated.emitted].filter(Boolean).length, 1);
  assert.equal(messages[0].desktopAccessWarnings[0].attemptId, "lock-attempt-1");
  assert.match(messages[0].text, /Desktop warning: The lease/);
});

test("desktop warning notifications can be explicitly disabled", async () => {
  const env = await fixture({ ORKESTR_DESKTOP_ACCESS_CHAT_WARNINGS: "0" });
  const thread = await createThread({ id: "warning-disabled", ownerUserId: "admin", name: "Disabled warning" }, env);
  const warnings = desktopAccessWarnings({
    desktopSlug: "example-desk",
    threadId: thread.id,
    operation: "connect",
    attemptId: "disabled-1",
    errorCode: "desktop_lease_required",
  });
  const result = await emitDesktopAccessChatWarning({ threadId: thread.id, attemptId: "disabled-1", warnings }, env);
  assert.deepEqual(result, { eligible: false, emitted: false, reason: "feature_disabled" });
  assert.equal((await listThreadMessages(thread.id, env)).length, 0);
});
