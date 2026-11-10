// Source-only authority regression. No browser or manager/acquisition API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { desktopLeaseStore } from '../../../packages/browsers/src/desktop-lease-store.js';
import { assertDesktopLeaseForOperation } from '../../../packages/browsers/src/desktop-leases.js';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-authority-synthetic-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DESKTOP_ACCESS_MODE: 'enforce',
    ORKESTR_DESKTOP_LEASE_STALE_MS: '60000',
    ORKESTR_ADMIN_USER_ID: 'synthetic-owner',
  };
  const now = Date.now();
  const lease = {
    id: 'synthetic-lease', desktopSlug: 'synthetic-desktop',
    ownerUserId: 'synthetic-owner', threadId: 'synthetic-thread',
    mode: 'exclusive', fencingToken: 'synthetic-fence', fencingVersion: 7,
    acquiredAt: new Date(now - 1000).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3600000).toISOString(), releasedAt: null,
  };
  const store = desktopLeaseStore(env);
  const write = async (patch = {}) => store.writeState({
    fencingCounter: 7, desktopLeases: [{ ...lease, ...patch }],
  });
  const options = {
    threadId: lease.threadId, ownerUserId: lease.ownerUserId,
    fencingToken: lease.fencingToken,
    expectedLeaseId: lease.id, expectedFencingVersion: lease.fencingVersion,
  };
  const check = (patch = {}) => assertDesktopLeaseForOperation(lease.desktopSlug, env, { ...options, ...patch });
  await write();
  return { write, check, lease };
}

test('current exact synthetic snapshot passes; released snapshot cannot act after reopen', async t => {
  const f = await fixture(t);
  assert.equal((await f.check()).id, f.lease.id);
  await f.write({ releasedAt: new Date().toISOString() });
  await assert.rejects(f.check(), { message: 'desktop_lease_required' });
});

test('expired and stale unreleased snapshots refuse', async t => {
  const f = await fixture(t);
  await f.write({ expiresAt: new Date(Date.now() - 1).toISOString() });
  await assert.rejects(f.check(), { message: 'desktop_lease_expired' });
  await f.write({ heartbeatAt: new Date(Date.now() - 120000).toISOString() });
  await assert.rejects(f.check(), { message: 'desktop_lease_heartbeat_stale' });
});

test('replacement identity, generation and token each invalidate prior authority', async t => {
  const f = await fixture(t);
  for (const [patch, message] of [
    [{ id: 'replacement-lease' }, 'desktop_lease_replaced'],
    [{ fencingVersion: 8 }, 'desktop_lease_replaced'],
    [{ fencingToken: 'replacement-fence' }, 'lease_fencing_token_invalid'],
  ]) {
    await f.write(patch);
    await assert.rejects(f.check(), { message });
  }
});

test('foreign owner/thread and nonexclusive mode refuse', async t => {
  const f = await fixture(t);
  await f.write({ ownerUserId: 'foreign-owner' });
  await assert.rejects(f.check(), { message: 'desktop_lease_required' });
  await f.write({ threadId: 'foreign-thread' });
  await assert.rejects(f.check(), { message: 'desktop_lease_owned_by_other_thread' });
  await f.write({ mode: 'viewOnly' });
  await assert.rejects(f.check(), { message: 'desktop_lease_must_be_exclusive' });
});

test('invalid dates and far-future heartbeat never restore authority', async t => {
  const f = await fixture(t);
  for (const [patch, message] of [
    [{ expiresAt: 'invalid' }, 'desktop_lease_expiry_invalid'],
    [{ heartbeatAt: 'invalid' }, 'desktop_lease_heartbeat_invalid'],
    [{ heartbeatAt: new Date(Date.now() + 120000).toISOString() }, 'desktop_lease_heartbeat_invalid'],
  ]) {
    await f.write(patch);
    await assert.rejects(f.check(), { message });
  }
});

test('a successful read is not continuing authority after subsequent revocation', async t => {
  const f = await fixture(t);
  const snapshot = await f.check();
  await f.write({ releasedAt: new Date().toISOString() });
  assert.equal(snapshot.releasedAt, null); // retained object does not update
  await assert.rejects(f.check(), { message: 'desktop_lease_required' });
});
