import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import { advanceDesktopResourceGeneration, setThreadDesktopGrants } from "../packages/core/src/desktop-access.js";
import {
  readThreadResourcePolicy,
} from "../packages/core/src/thread-resource-grants.js";
import { mutateThreadResourcePolicy } from "../packages/core/src/thread-resource-policy-access.js";
import { acquireDesktopLease, releaseDesktopLease } from "../packages/browsers/src/desktop-leases.js";
import { desktopLeaseStore } from "../packages/browsers/src/desktop-lease-store.js";
import {
  consumeDesktopCapability,
  issueDesktopCapability,
} from "../packages/browsers/src/desktop-capability-broker.js";
import { operateManagedDesktop } from "../packages/browsers/src/desktop-operator.js";
import { listBrowserSessions } from "../packages/browsers/src/browsers.js";
import { listEvents } from "../packages/storage/src/store.js";

function attestation(resource, { visibleOnly = false } = {}) {
  return {
    status: "verified",
    attestationId: "attestation-opaque-fixture",
    canonicalAccountRefHash: "a".repeat(64),
    isolationEvidenceHash: "b".repeat(64),
    resourceId: resource.id,
    ownerUserId: resource.ownerUserId,
    boundaryId: resource.boundaryId,
    verifier: "private-overlay-verifier",
    verifiedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isolationAttested: true,
    requiresVisibleNoVnc: visibleOnly,
    brokerVersion: "desktop-broker.v1",
  };
}

async function fixture({ visibleOnly = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-capability-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_DESKTOP_ACCESS_MODE: "enforce",
    ORKESTR_BROWSER_DESKTOP_MODE: "disabled",
    ORKESTR_DESKTOP_CATALOG_JSON: JSON.stringify([{ slug: "linkedin", label: "LinkedIn" }]),
  };
  const principal = adminPrincipal("admin");
  const thread = await createThread({ id: "capability-thread", ownerUserId: "admin", name: "Capability thread" }, env);
  await advanceDesktopResourceGeneration("linkedin", "admin", { reason: "fixture_registered" }, env);
  await setThreadDesktopGrants(thread.id, ["linkedin"], { principal, reason: "fixture_grant" }, env);
  const resource = (await readThreadResourcePolicy(env)).resources.find((item) => item.resourceType === "desktop" && item.resourceKey === "linkedin");
  env.ORKESTR_DESKTOP_ACCOUNT_ATTESTATIONS_JSON = JSON.stringify({ [resource.id]: attestation(resource, { visibleOnly }) });
  const acquired = await acquireDesktopLease("linkedin", {
    threadId: thread.id,
    runId: "fixture-runtime",
    mode: "exclusive",
    ttlMs: 60_000,
  }, env, { principal });
  assert.equal(acquired.ok, true);
  return { env, principal, thread, resource, lease: acquired.lease };
}

test("desktop capability resolves one exact grant, redacts bearer state, and rejects replay", async () => {
  const { env, principal, thread, resource, lease } = await fixture();
  const issued = await issueDesktopCapability({
    principal,
    threadId: thread.id,
    fencingToken: lease.fencingToken,
    audience: "managed-desktop-operator",
    scope: "observe",
  }, env);
  assert.equal(issued.desktop.slug, "linkedin");
  assert.equal(issued.desktop.resourceId, resource.id);
  const stored = await readThreadResourcePolicy(env);
  assert.equal(JSON.stringify(stored.resourceSessions).includes(issued.capability), false);

  const consumed = await consumeDesktopCapability({
    principal,
    capability: issued.capability,
    desktopSlug: "linkedin",
    threadId: thread.id,
    audience: "managed-desktop-operator",
    scope: "observe",
  }, env);
  assert.equal(consumed.desktop.resourceId, resource.id);
  await assert.rejects(
    () => consumeDesktopCapability({ principal, capability: issued.capability, desktopSlug: "linkedin", threadId: thread.id, audience: "managed-desktop-operator", scope: "observe" }, env),
    /desktop_capability_replayed/,
  );
  const events = await listEvents(env);
  const allow = events.find((event) => event.type === "desktop_broker_decision" && event.reason === "desktop_capability_consumed");
  assert.ok(allow);
  assert.equal(JSON.stringify(allow).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(allow).includes(issued.capability), false);
});

test("desktop capability is single-use under concurrent replay and cannot be retargeted", async () => {
  const { env, principal, thread, lease } = await fixture();
  const issued = await issueDesktopCapability({ principal, threadId: thread.id, fencingToken: lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, env);
  await assert.rejects(
    () => consumeDesktopCapability({ principal, capability: issued.capability, desktopSlug: "other-desktop", threadId: thread.id, audience: "managed-desktop-operator", scope: "observe" }, env),
    /desktop_capability_target_mismatch/,
  );
  const concurrent = await Promise.allSettled([
    consumeDesktopCapability({ principal, capability: issued.capability, desktopSlug: "linkedin", threadId: thread.id, audience: "managed-desktop-operator", scope: "observe" }, env),
    consumeDesktopCapability({ principal, capability: issued.capability, desktopSlug: "linkedin", threadId: thread.id, audience: "managed-desktop-operator", scope: "observe" }, env),
  ]);
  assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((item) => item.status === "rejected").length, 1);
});

test("desktop capability rejects missing or forged caller bindings without consuming the bearer", async () => {
  const { env, principal, thread, lease } = await fixture();
  const issued = await issueDesktopCapability({ principal, threadId: thread.id, fencingToken: lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, env);
  const base = { principal, capability: issued.capability, desktopSlug: "linkedin", threadId: thread.id, audience: "managed-desktop-operator", scope: "observe" };
  await assert.rejects(() => consumeDesktopCapability({ ...base, threadId: "other-thread" }, env), /desktop_capability_thread_denied/);
  await assert.rejects(() => consumeDesktopCapability({ ...base, principal: { userId: "other", role: "user" } }, env), /desktop_capability_principal_denied/);
  await assert.rejects(() => consumeDesktopCapability({ ...base, audience: "other-audience" }, env), /desktop_capability_scope_denied/);
  await assert.rejects(() => consumeDesktopCapability({ ...base, scope: "visible_interaction" }, env), /desktop_capability_scope_denied/);
  const consumed = await consumeDesktopCapability(base, env);
  assert.equal(consumed.desktop.threadId, thread.id);
});

test("desktop capability rejects a bearer when the live lease runtime changes", async () => {
  const { env, principal, thread, lease } = await fixture();
  const issued = await issueDesktopCapability({ principal, threadId: thread.id, fencingToken: lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, env);
  const renewed = await acquireDesktopLease("linkedin", {
    threadId: thread.id,
    runId: "replacement-runtime",
    mode: "exclusive",
    ttlMs: 60_000,
  }, env, { principal });
  assert.equal(renewed.ok, true);
  await assert.rejects(
    () => consumeDesktopCapability({ principal, capability: issued.capability, desktopSlug: "linkedin", threadId: thread.id, audience: "managed-desktop-operator", scope: "observe" }, env),
    /desktop_capability_runtime_denied/,
  );
});

test("capability issuance and consumption fail closed for attestation and lease changes", async () => {
  const { env, principal, thread, resource, lease } = await fixture();
  env.ORKESTR_DESKTOP_ACCOUNT_ATTESTATIONS_JSON = "{}";
  await assert.rejects(
    () => issueDesktopCapability({ principal, threadId: thread.id, fencingToken: lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, env),
    /desktop_account_attestation_required/,
  );
  env.ORKESTR_DESKTOP_ACCOUNT_ATTESTATIONS_JSON = JSON.stringify({ [resource.id]: { ...attestation(resource), expiresAt: new Date(Date.now() - 1_000).toISOString() } });
  await assert.rejects(
    () => issueDesktopCapability({ principal, threadId: thread.id, fencingToken: lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, env),
    /desktop_account_attestation_invalid/,
  );
  env.ORKESTR_DESKTOP_ATTESTATION_MAX_AGE_MS = "invalid";
  env.ORKESTR_DESKTOP_ACCOUNT_ATTESTATIONS_JSON = JSON.stringify({ [resource.id]: {
    ...attestation(resource),
    verifiedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } });
  await assert.rejects(
    () => issueDesktopCapability({ principal, threadId: thread.id, fencingToken: lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, env),
    /desktop_account_attestation_invalid/,
  );
  delete env.ORKESTR_DESKTOP_ATTESTATION_MAX_AGE_MS;
  env.ORKESTR_DESKTOP_ACCOUNT_ATTESTATIONS_JSON = JSON.stringify({ [resource.id]: attestation(resource) });
  const issued = await issueDesktopCapability({ principal, threadId: thread.id, fencingToken: lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, env);
  await releaseDesktopLease("linkedin", { principal, threadId: thread.id, fencingToken: lease.fencingToken, reason: "fixture_revoked" }, env);
  await assert.rejects(
    () => consumeDesktopCapability({ principal, capability: issued.capability, desktopSlug: "linkedin", threadId: thread.id, audience: "managed-desktop-operator", scope: "observe" }, env),
    /desktop_lease_required/,
  );
  await assert.rejects(
    () => acquireDesktopLease("linkedin", { threadId: thread.id, mode: "sharedRead" }, env, { principal }),
    /desktop_lease_must_be_exclusive/,
  );
});

test("enforce leases fail closed for malformed expiry, future heartbeat, and stale heartbeats with invalid config", async () => {
  let current = await fixture();
  await desktopLeaseStore(current.env).mutateState((state) => {
    state.desktopLeases[0].expiresAt = "not-a-timestamp";
  });
  await assert.rejects(
    () => issueDesktopCapability({ principal: current.principal, threadId: current.thread.id, fencingToken: current.lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, current.env),
    /desktop_lease_expiry_invalid/,
  );

  current = await fixture();
  current.env.ORKESTR_DESKTOP_LEASE_STALE_MS = "invalid";
  await desktopLeaseStore(current.env).mutateState((state) => {
    state.desktopLeases[0].heartbeatAt = new Date(Date.now() - 16 * 60_000).toISOString();
  });
  await assert.rejects(
    () => issueDesktopCapability({ principal: current.principal, threadId: current.thread.id, fencingToken: current.lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, current.env),
    /desktop_lease_heartbeat_stale/,
  );

  current = await fixture();
  await desktopLeaseStore(current.env).mutateState((state) => {
    state.desktopLeases[0].heartbeatAt = new Date(Date.now() + 2 * 60_000).toISOString();
  });
  await assert.rejects(
    () => issueDesktopCapability({ principal: current.principal, threadId: current.thread.id, fencingToken: current.lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, current.env),
    /desktop_lease_heartbeat_invalid/,
  );
});

test("capabilities expire and fail closed when their exact grant is replaced or becomes ambiguous", async () => {
  let current = await fixture();
  const expired = await issueDesktopCapability({ principal: current.principal, threadId: current.thread.id, fencingToken: current.lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, current.env);
  await mutateThreadResourcePolicy((state) => {
    const session = state.resourceSessions.find((item) => item.resourceId === current.resource.id && item.state === "active");
    session.expiresAt = new Date(Date.now() - 1_000).toISOString();
    return { ok: true, skipPolicyEpoch: true };
  }, current.env);
  await assert.rejects(
    () => consumeDesktopCapability({ principal: current.principal, capability: expired.capability, desktopSlug: "linkedin", threadId: current.thread.id, audience: "managed-desktop-operator", scope: "observe" }, current.env),
    /desktop_capability_expired/,
  );

  current = await fixture();
  const revoked = await issueDesktopCapability({ principal: current.principal, threadId: current.thread.id, fencingToken: current.lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, current.env);
  await setThreadDesktopGrants(current.thread.id, [], { principal: current.principal, reason: "fixture_revoked" }, current.env);
  await assert.rejects(
    () => consumeDesktopCapability({ principal: current.principal, capability: revoked.capability, desktopSlug: "linkedin", threadId: current.thread.id, audience: "managed-desktop-operator", scope: "observe" }, current.env),
    /desktop_capability_resource_stale/,
  );

  current = await fixture();
  await advanceDesktopResourceGeneration("gmail", "admin", { reason: "fixture_registered" }, current.env);
  await setThreadDesktopGrants(current.thread.id, ["linkedin", "gmail"], { principal: current.principal, reason: "fixture_ambiguous" }, current.env);
  await assert.rejects(
    () => issueDesktopCapability({ principal: current.principal, threadId: current.thread.id, fencingToken: current.lease.fencingToken, audience: "managed-desktop-operator", scope: "observe" }, current.env),
    /desktop_grant_ambiguous/,
  );
});

test("attested external desktops reject CDP writes before browser connection", async () => {
  const { env, principal, thread, lease } = await fixture({ visibleOnly: true });
  const issued = await issueDesktopCapability({ principal, threadId: thread.id, fencingToken: lease.fencingToken, audience: "managed-desktop-operator", scope: "visible_interaction" }, env);
  await assert.rejects(
    () => operateManagedDesktop("linkedin", { operation: "click", text: "Send" }, env, {
      principal,
      threadId: thread.id,
      fencingToken: lease.fencingToken,
      desktopCapability: issued.capability,
    }),
    /desktop_visible_novnc_interaction_required/,
  );
});

test("normal browser-session projection redacts direct desktop endpoints", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-redaction-"));
  const browserctl = path.join(home, "browserctl.js");
  await fs.writeFile(browserctl, `#!/usr/bin/env node
console.log(JSON.stringify({ ok: true, sessions: [{ slug: "desktop", status: "running", cdp_url: "http://127.0.0.1:9999", desk_url: "http://127.0.0.1:6080", profile_path: "/private/profile", debugPort: 9999, localControl: { cdpUrl: "http://127.0.0.1:9999", profilePath: "/private/profile" } }] }));
`);
  await fs.chmod(browserctl, 0o755);
  const payload = await listBrowserSessions({ ORKESTR_HOME: home, ORKESTR_BROWSERCTL_PATH: browserctl }, { publicProjection: true });
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].endpointRedacted, true);
  assert.equal(JSON.stringify(payload.sessions[0]).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(payload.sessions[0]).includes("/private/profile"), false);
});
