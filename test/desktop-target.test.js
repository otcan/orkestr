import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDesktopTargetResolver, desktopSessionPort } from "../dist/server/apps/server/src/desktop-target.js";

const principal = { kind: "user", userId: "alice", role: "user" };
const scope = { threadId: "thread-a", fencingToken: "fixture-fence" };
const env = { ORKESTR_HOME: "/fixture/alice" };
const decision = { ownerUserId: "alice", boundaryId: "fixture", resourceId: "desk-a", policyRevision: 1, grantRevision: 1, resourceGeneration: 1 };
const allow = async () => ({ ...decision });

test("6/16/44 concurrent assets and dependency waves share one lookup without sharing authorization", async (t) => {
  let reads = 0;
  let checks = 0;
  const resolve = createDesktopTargetResolver({
    authorize: async () => { checks++; return { ...decision }; }, requireCapability: () => false,
    readTarget: async () => { reads++; await delay(60); return { web_port: 6100 }; },
  });
  for (const count of [6, 16, 44, 6]) {
    const before = reads;
    const start = performance.now();
    assert.deepEqual(await Promise.all(Array.from({ length: count }, () => resolve("desk", principal, scope, env))), Array(count).fill(6100));
    assert.equal(reads - before, 1);
    assert.ok(performance.now() - start < 500, "batch should cost one lookup, not count times lookup");
    t.diagnostic(`${count} requests: ${Math.round(performance.now() - start)}ms, 1 target read`);
  }
  assert.equal(checks, 2 * (6 + 16 + 44 + 6));
});

test("routing work is partitioned by owner, thread, boundary, grant, generation, share and fence", async () => {
  let reads = 0;
  const resolve = createDesktopTargetResolver({
    authorize: async ({ principal: p }) => ({ ...decision, ...p.binding }), requireCapability: () => false,
    validateShare: async () => {},
    readTarget: async () => { reads++; await delay(30); return { web_port: 6100 }; },
  });
  const cases = [
    [principal, scope, env], [{ ...principal, userId: "bob" }, scope, env],
    [principal, { ...scope, threadId: "thread-b" }, env],
    [principal, scope, { ...env, ORKESTR_TENANT_VM_ID: "other" }],
    [{ ...principal, binding: { policyRevision: 2 } }, scope, env],
    [{ ...principal, binding: { grantRevision: 2 } }, scope, env],
    [{ ...principal, binding: { resourceGeneration: 2 } }, scope, env],
    [principal, { ...scope, fencingToken: "new-fence" }, env],
    [principal, { ...scope, desktopShare: { id: "share", shareGeneration: 1 }, shareAttemptId: "attempt" }, env],
    [principal, { ...scope, desktopShare: { id: "share", shareGeneration: 2 }, shareAttemptId: "attempt" }, env],
    [principal, { ...scope, desktopShare: { id: "share", shareGeneration: 1 }, shareAttemptId: "other" }, env],
  ];
  await Promise.all(cases.map(([p, s, e]) => resolve("desk", p, s, e)));
  assert.equal(reads, cases.length);
});

test("no completed port/error cache: changed ports are fresh and failures retry", async () => {
  let port = 6100;
  let fail = false;
  let reads = 0;
  const resolve = createDesktopTargetResolver({ authorize: allow, requireCapability: () => false,
    readTarget: async () => { reads++; if (fail) throw Error("offline"); return { webPort: port }; },
  });
  assert.equal(await resolve("desk", principal, scope, env), 6100);
  port = 6200;
  assert.equal(await resolve("desk", principal, scope, env), 6200);
  fail = true;
  await assert.rejects(resolve("desk", principal, scope, env), /offline/);
  fail = false;
  assert.equal(await resolve("desk", principal, scope, env), 6200);
  assert.equal(reads, 4);
});

test("an unauthorized concurrent caller cannot join an authorized lookup", async () => {
  let reads = 0;
  const resolve = createDesktopTargetResolver({ requireCapability: () => false,
    authorize: async ({ principal: caller }) => {
      if (caller.source === "denied-session") throw Error("access_denied");
      return { ...decision };
    },
    readTarget: async () => { reads++; await delay(40); return { web_port: 6100 }; },
  });
  const allowed = resolve("desk", principal, scope, env);
  await delay(5);
  await assert.rejects(resolve("desk", { ...principal, source: "denied-session" }, scope, env), /access_denied/);
  assert.equal(await allowed, 6100);
  assert.equal(reads, 1);
});

test("revocation or generation change while a lookup is running fails closed", async () => {
  for (const mode of ["revoked", "generation"]) {
    let changed = false;
    const resolve = createDesktopTargetResolver({ requireCapability: () => false,
      authorize: async () => {
        if (changed && mode === "revoked") throw Error("grant_revoked");
        return { ...decision, resourceGeneration: changed ? 2 : 1 };
      },
      readTarget: async () => { changed = true; return { web_port: 6100 }; },
    });
    await assert.rejects(resolve("desk", principal, scope, env), /grant_revoked|desktop_target_binding_changed/);
  }
});

test("capability, grant revision and share expiry are not bypassed by coalescing", async () => {
  let reads = 0;
  const resolve = createDesktopTargetResolver({ authorize: allow, requireCapability: () => true,
    readTarget: async () => { reads++; return { web_port: 6100 }; },
    validateShare: async () => { throw Error("share_expired"); },
  });
  await assert.rejects(resolve("desk", principal, scope, env), /desktop_brokered_share_required/);
  const shared = { ...scope, desktopShare: { id: "share", shareGeneration: 1 }, shareAttemptId: "attempt" };
  await assert.rejects(resolve("desk", principal, { ...shared, grantRevision: 2 }, env), /desktop_share_grant_changed/);
  assert.equal(reads, 0);
  await assert.rejects(resolve("desk", principal, shared, env), /share_expired/);
});

test("lookup timeouts abort bounded work, clear failures and bound pending keys", async () => {
  let observedSignal;
  let hang = true;
  const resolve = createDesktopTargetResolver({ authorize: allow, requireCapability: () => false, maxPending: 1,
    readTarget: async (_, __, { signal }) => {
      observedSignal = signal;
      if (hang) await delay(250);
      return { web_port: 6100 };
    },
  });
  const timedEnv = { ...env, ORKESTR_DESKTOP_PROXY_LOOKUP_TIMEOUT_MS: "100" };
  const pending = resolve("desk", principal, scope, timedEnv);
  const rejection = assert.rejects(pending, /desktop_lookup_timeout/);
  await delay(10);
  await assert.rejects(resolve("other", principal, scope, timedEnv), /desktop_lookup_busy/);
  await rejection;
  assert.equal(observedSignal.aborted, true);
  hang = false;
  assert.equal(await resolve("desk", principal, scope, timedEnv), 6100);
  await delay(160); // Late completion cannot repopulate a port cache.
  assert.equal(await resolve("desk", principal, scope, timedEnv), 6100);
});

test("routing ports are validated including legacy upstream URLs", () => {
  assert.equal(desktopSessionPort({ upstream: "http://127.0.0.1:6100" }), 6100);
  assert.equal(desktopSessionPort({ upstream: "127.0.0.1:6100" }), 6100);
  assert.equal(desktopSessionPort({ upstream: "http://127.0.0.1:80/" }), 80);
  for (const value of [0, -1, 65536, "invalid", 1.5]) assert.throws(() => desktopSessionPort({ web_port: value }), /desktop_not_running/);
});
