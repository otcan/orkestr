import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDesktopShare, listDesktopShares } from '../packages/core/src/desktop-shares.js';
import { DesktopLeaseStore } from '../packages/browsers/src/desktop-lease-store.js';
import { userPrincipal } from '../packages/core/src/principal.js';

test('share-if-absent admits exactly one concurrent viewer without superseding it', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-desk-cas-'));
  const env = { ORKESTR_HOME: home, ORKESTR_DESKTOP_SHARE_BASE_DOMAIN: 'desktop.example.test' };
  const principal = userPrincipal({ id: 'alice', role: 'user' });
  try {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
      createDesktopShare({ desktopSlug: 'desk', principal, threadId: 'thread-one', ifAbsent: true, env })));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    for (const result of results.filter(x => x.status === 'rejected'))
      assert.match(result.reason.message, /desktop_share_already_exists/);
    const { shares: listed } = await listDesktopShares({ ownerUserId: 'alice', desktopSlug: 'desk', env });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'pending');
    assert.equal(listed[0].shareGeneration, 1);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('viewing borrows the same-thread worker lease without changing authority or expiry', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-desk-borrow-'));
  try {
    const store = new DesktopLeaseStore(path.join(home, 'leases.json'));
    await store.init();
    const original = { desktopSlug: 'desk', ownerUserId: 'alice', threadId: 'thread-one',
      acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString() };
    await store.acquire(original);
    const before = await store.readState();
    const borrowed = await store.acquire({ ...original, expiresAt: new Date(Date.now() + 60000).toISOString() }, { reuseExisting: true });
    assert.equal(borrowed.borrowed, true);
    assert.deepEqual(await store.readState(), before);
    const foreign = await store.acquire({ ...original, threadId: 'another-thread' }, { reuseExisting: true });
    assert.equal(foreign.ok, false);
    assert.deepEqual(await store.readState(), before);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
