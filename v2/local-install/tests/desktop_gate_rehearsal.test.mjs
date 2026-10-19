// Test-only policy proposal, never an operational restoration command.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.env.DESKTOP_GATE_SOURCE;
if (!source || !path.isAbsolute(source)) throw new Error('isolated DESKTOP_GATE_SOURCE required');
const { DesktopLeaseStore } = await import(pathToFileURL(path.join(source, 'packages/browsers/src/desktop-lease-store.js')));
const { validateLeaseState } = await import(pathToFileURL(path.join(source, 'packages/browsers/src/desktop-lease-state.js')));
const now = new Date().toISOString();
const legacy = () => ({ fencingCounter: 7, retained: { synthetic: true }, desktopLeases: [{
  id: 'synthetic-lease', desktopSlug: 'synthetic-desktop', ownerUserId: 'synthetic-owner',
  threadId: 'synthetic-thread', fencingToken: 'synthetic-token', fencingVersion: 7,
  mode: 'exclusive', acquiredAt: now, heartbeatAt: now,
  expiresAt: new Date(Date.parse(now) + 60_000).toISOString(), releasedAt: null,
  metadata: { retained: true },
}] });
const binding = (lease) => ({ desktopSlug: lease.desktopSlug, ownerUserId: lease.ownerUserId,
  threadId: lease.threadId, leaseId: lease.id, fencingVersion: lease.fencingVersion,
  fencingToken: lease.fencingToken });

function revokedRecoveryProposal(state) {
  validateLeaseState(state, state.lockIdentity);
  const copy = structuredClone(state);
  for (const lease of copy.desktopLeases) {
    if (!lease.releasedAt) Object.assign(lease, {
      releasedAt: now, updatedAt: now, releaseReason: 'offline-restore-revoked',
    });
  }
  delete copy.lockIdentity;
  validateLeaseState(copy, undefined);
  return copy;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-adoption-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'original', 'leases.json');
  await fs.mkdir(path.dirname(file), { mode: 0o700 });
  const bytes = `${JSON.stringify(legacy())}\n`;
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  return { root, file, bytes, store: new DesktopLeaseStore(file) };
}
test('legacy adoption preserves authority/history and repeated init is byte-stable', async (t) => {
  const { file, store } = await fixture(t);
  await store.init();
  const bytes = await fs.readFile(file, 'utf8');
  const { lockIdentity, ...retained } = JSON.parse(bytes);
  assert.ok(lockIdentity);
  assert.deepEqual(retained, legacy());
  assert.equal(await store.withCurrentLeaseAction(binding(retained.desktopLeases[0]), () => 'local'), 'local');
  await store.init();
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});
test('copied JSON and lock refuse new inode without altering evidence', async (t) => {
  const { root, file, store } = await fixture(t);
  await store.init();
  const restored = path.join(root, 'restored', 'leases.json');
  await fs.mkdir(path.dirname(restored), { mode: 0o700 });
  await fs.copyFile(file, restored);
  await fs.copyFile(`${file}.lock`, `${restored}.lock`);
  const before = await fs.readFile(restored);
  await assert.rejects(new DesktopLeaseStore(restored).init(), /lock_identity_changed/);
  assert.deepEqual(await fs.readFile(restored), before);
});
test('offline revoke proposal preserves backup, refuses old binding, requires fresh generation', async (t) => {
  const { root, file, store } = await fixture(t);
  await store.init();
  const backup = await fs.readFile(file);
  const state = JSON.parse(backup);
  const output = revokedRecoveryProposal(state);
  assert.equal(output.fencingCounter, state.fencingCounter);
  assert.equal(output.desktopLeases[0].fencingToken, state.desktopLeases[0].fencingToken);
  assert.deepEqual(output.retained, state.retained);
  const restored = path.join(root, 'revoked', 'leases.json');
  await fs.mkdir(path.dirname(restored), { mode: 0o700 });
  await fs.writeFile(restored, JSON.stringify(output), { flag: 'wx', mode: 0o600 });
  const fresh = new DesktopLeaseStore(restored);
  await fresh.init();
  let called = false;
  await assert.rejects(fresh.withCurrentLeaseAction(binding(state.desktopLeases[0]), () => { called = true; }));
  assert.equal(called, false);
  const acquired = await fresh.acquire({ desktopSlug: 'synthetic-desktop', ownerUserId: 'synthetic-owner',
    threadId: 'new-synthetic-thread', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(acquired.lease.fencingVersion, 8);
  assert.notEqual(acquired.lease.fencingToken, state.desktopLeases[0].fencingToken);
  assert.deepEqual(await fs.readFile(file), backup);
});
test('legacy mkdir lock is not stolen or removed', async (t) => {
  const { file, bytes, store } = await fixture(t);
  await fs.mkdir(`${file}.lock`);
  await assert.rejects(store.init(), /lock_path_invalid/);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.ok((await fs.stat(`${file}.lock`)).isDirectory());
});
