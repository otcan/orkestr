import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopLeaseStore } from "../packages/browsers/src/desktop-lease-store.js";
import { validateLeaseState } from "../packages/browsers/src/desktop-lease-state.js";
import { prepareLegacyCohort, normalizeLegacyAdoption } from "../packages/browsers/src/desktop-lease-legacy.js";
import { prepared, legacyState, revokedAt, sha } from "./fixtures/desktop-lease-legacy-state.js";

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-legacy-adoption-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "leases.json"), result = prepared();
  await fs.writeFile(file, result.bytes, { mode: 0o600 });
  const store = new DesktopLeaseStore(file, { legacyAdoption: result.adoption });
  return { root, file, store, ...result };
}
const binding = (row) => ({ desktopSlug: row.desktopSlug, ownerUserId: row.ownerUserId,
  threadId: row.threadId, leaseId: row.id, fencingVersion: row.fencingVersion, fencingToken: row.fencingToken });

test("pure preparer preserves all history and unrelated fields; only unreleased records are retired", () => {
  const before = legacyState(), clone = structuredClone(before), result = prepared(before);
  assert.deepEqual(before, clone);
  assert.deepEqual(result.state.desktopLeases[1], before.desktopLeases[1]);
  assert.deepEqual(result.state.unrelated, before.unrelated);
  assert.deepEqual(result.state.desktopLeases[0], { ...before.desktopLeases[0],
    releasedAt: revokedAt, releaseReason: "legacy_history_retired", updatedAt: revokedAt });
  assert.equal(result.state.fencingCounter, 8);
  assert.equal(result.adoption.cohort.generationFloor, 8);
  assert.equal(result.adoption.preparedSha256, sha(result.bytes));
  assert.equal(result.adoption.sourceSha256, sha(result.original));
  assert.throws(() => validateLeaseState(before), /state_invalid/);
  assert.throws(() => validateLeaseState(result.state), /legacy_adoption_invalid/);
  validateLeaseState(result.state, undefined, result.adoption);
});

test("adopt, reopen, fresh same-thread acquisition and old binding refusal retain immutable history", async (t) => {
  const { file, store, state, adoption } = await setup(t);
  await store.init();
  assert.deepEqual(await store.readAll({ includeReleased: true }), state.desktopLeases);
  assert.deepEqual(await store.readAll(), []);
  const old = state.desktopLeases[0];
  await assert.rejects(store.withCurrentLeaseAction(binding(old), () => assert.fail("retired action entered")), /action_revoked/);
  assert.equal((await store.heartbeat(old.desktopSlug, old.threadId, old.ownerUserId, old.fencingToken)).ok, false);
  assert.equal((await store.release(old.desktopSlug, { threadId: old.threadId, force: true })).ok, false);
  const reopened = new DesktopLeaseStore(file, { legacyAdoption: adoption });
  await reopened.init();
  const next = await reopened.acquire({ ...old, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(next.renewed, false);
  assert.notEqual(next.lease.id, old.id); assert.notEqual(next.lease.fencingToken, old.fencingToken);
  assert.equal(next.lease.fencingVersion, 9); assert.equal(next.lease.releasedAt, null);
  assert.deepEqual((await reopened.readAll({ includeReleased: true })).slice(1), state.desktopLeases);
  await reopened.withCurrentLeaseAction(binding(next.lease), () => {});
  await assert.rejects(reopened.withCurrentLeaseAction(binding(old), () => assert.fail("retired action entered")), /action_revoked/);
  const saved = await fs.readFile(file);
  await assert.rejects(new DesktopLeaseStore(file).init(), /legacy_adoption_invalid/);
  assert.deepEqual(await fs.readFile(file), saved);
});

test("cohort edits, removal, unrelease, marker forgery and counter rollback never publish", async (t) => {
  const { file, store } = await setup(t); await store.init();
  const original = await fs.readFile(file);
  const changes = [
    (s) => { s.desktopLeases.pop(); },
    (s) => { s.desktopLeases[0].metadata.retained[0] = "changed"; },
    (s) => { s.unrelated.nonfinite = Infinity; },
    (s) => { s.desktopLeases[0].fencingToken = "changed"; },
    (s) => { s.desktopLeases[0].fencingVersion += 1; },
    (s) => { s.desktopLeases[0].releasedAt = null; },
    (s) => { s.desktopLeases.push({ ...s.desktopLeases[0] }); },
    (s) => { s.desktopLeases.push({ ...s.desktopLeases[0], id: "unadopted-old-row" }); },
    (s) => { delete s.legacyRetiredCohort; },
    (s) => { s.legacyRetiredCohort.retiredIds.push("invented"); },
    (s) => { s.legacyRetiredCohort.retiredSha256 = "0".repeat(64); },
    (s) => { s.fencingCounter -= 1; },
  ];
  for (const change of changes) {
    await assert.rejects(store.mutateState(change), /desktop_lease_/);
    assert.deepEqual(await fs.readFile(file), original);
  }
});

test("new generations stay unique above floor; initialization requires exact prepared bytes", async (t) => {
  const { file, store, bytes, adoption } = await setup(t);
  await fs.writeFile(file, Buffer.concat([bytes, Buffer.from(" ")]));
  const wrong = await fs.readFile(file);
  await assert.rejects(store.init(), /legacy_adoption_invalid/);
  assert.deepEqual(await fs.readFile(file), wrong);
  await fs.writeFile(file, bytes); await store.init();
  await store.acquire({ desktopSlug: "fresh", threadId: "thread" });
  const original = await fs.readFile(file);
  await assert.rejects(store.mutateState((s) => { s.desktopLeases.push({ ...s.desktopLeases[0], id: "duplicate-version", releasedAt: revokedAt }); }), /state_invalid/);
  await assert.rejects(store.mutateState((s) => { s.desktopLeases[0].fencingVersion = adoption.cohort.generationFloor; }), /state_invalid/);
  await assert.rejects(store.mutateState((s) => { s.fencingCounter -= 1; }), /generation_regressed/);
  assert.deepEqual(await fs.readFile(file), original);
});

test("forged matching lock identity cannot skip first exact-byte adoption", async (t) => {
  const { file, store, state } = await setup(t);
  await assert.rejects(new DesktopLeaseStore(file).init(), /legacy_adoption_invalid/);
  const lock = await fs.stat(`${file}.lock`, { bigint: true });
  assert.equal(lock.size, 0n);
  const changed = structuredClone(state);
  changed.lockIdentity = `${lock.dev}:${lock.ino}`;
  changed.fencingCounter += 1;
  changed.desktopLeases.unshift({ ...changed.desktopLeases[0], id: "unapproved-first-write",
    fencingVersion: changed.fencingCounter });
  const raw = JSON.stringify(changed); await fs.writeFile(file, raw);
  await assert.rejects(store.init(), /legacy_adoption_invalid/);
  assert.equal(await fs.readFile(file, "utf8"), raw);
  assert.equal((await fs.stat(`${file}.lock`)).size, 0);
});

test("copied initialized lock evidence cannot rebind, while same-store backup restore preserves cohort", async (t) => {
  const { root, file, store, adoption } = await setup(t); await store.init();
  const snapshot = await fs.readFile(file);
  const copied = path.join(root, "copied.json"); await fs.writeFile(copied, snapshot);
  await assert.rejects(new DesktopLeaseStore(copied, { legacyAdoption: adoption }).init(), /lock_identity_changed/);
  assert.deepEqual(await fs.readFile(copied), snapshot);
  await fs.writeFile(file, snapshot);
  await new DesktopLeaseStore(file, { legacyAdoption: adoption }).init();
  assert.deepEqual(await fs.readFile(file), snapshot);
});

test("adopted state parses duplicate keys strictly instead of hiding changes in JSON.parse", async (t) => {
  const { file, store } = await setup(t); await store.init();
  const original = await fs.readFile(file, "utf8");
  const duplicate = original.replace('"fencingCounter": 8', '"fencingCounter": 7, "fencingCounter": 8');
  assert.notEqual(duplicate, original);
  await fs.writeFile(file, duplicate);
  await assert.rejects(store.readAll({ includeReleased: true }), /state_invalid/);
  await assert.rejects(store.init(), /state_invalid/);
  assert.equal(await fs.readFile(file, "utf8"), duplicate);
});

test("preparation refuses initialized state, malformed structure and exhausted generations", () => {
  for (const change of [
    (s) => { s.lockIdentity = "old"; }, (s) => { s.legacyRetiredCohort = {}; },
    (s) => { delete s.desktopLeases[0].fencingToken; },
    (s) => { s.desktopLeases[1].releasedAt = null; },
    (s) => { s.fencingCounter = Number.MAX_SAFE_INTEGER - 1; },
    (s) => { s.desktopLeases[1].id = s.desktopLeases[0].id; },
    (s) => { s.unrelated.bad = Infinity; },
  ]) {
    const state = legacyState(); change(state); const snapshot = structuredClone(state);
    assert.throws(() => prepareLegacyCohort(state, { sourceSha256: "1".repeat(64), revokedAt }), /desktop_lease_/);
    assert.deepEqual(state, snapshot);
  }
  const receipt = prepared().adoption;
  assert.throws(() => normalizeLegacyAdoption({ ...receipt, permissive: true }), /legacy_adoption_invalid/);
  assert.throws(() => normalizeLegacyAdoption({ ...receipt, preparedSha256: "invalid" }), /legacy_adoption_invalid/);
});
