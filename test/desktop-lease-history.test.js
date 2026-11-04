import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopLeaseStore } from '../packages/browsers/src/desktop-lease-store.js';
import { prepared } from './fixtures/desktop-lease-legacy-state.js';

test('every writer archives before pruning while preserving adopted history and current fences', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-history-writer-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const file = path.join(root, 'leases.json'), initial = prepared(), archiveDir = path.join(root, 'archive');
  await fs.writeFile(file, initial.bytes);
  const store = new DesktopLeaseStore(file, {legacyAdoption:initial.adoption,
    historyRetention:{archiveDir,keepReleased:2,threshold:5}});
  await store.init(); const lockIdentity = (await store.readState()).lockIdentity;
  const expected = new Set(initial.state.desktopLeases.map(row => row.id));
  for (let i=0;i<30;i++) {
    const got = await store.acquire({desktopSlug:'desk',ownerUserId:'owner',threadId:'worker',id:`lease-${i}`});
    assert.equal(got.ok,true); expected.add(`lease-${i}`);
    const active = await store.activeLease('desk','owner');
    assert.equal(active.id,`lease-${i}`);
    await store.release('desk',{ownerUserId:'owner',threadId:'worker',fencingToken:active.fencingToken});
  }
  const after = await store.readState();
  assert.ok(after.desktopLeases.length<=5);
  assert.equal(after.fencingCounter, initial.state.fencingCounter+30);
  assert.equal(after.lockIdentity,lockIdentity);
  assert.deepEqual(after.legacyRetiredCohort, initial.state.legacyRetiredCohort);
  for(const old of initial.state.desktopLeases) assert.deepEqual(after.desktopLeases.find(x=>x.id===old.id),old);
  const observed = new Set(after.desktopLeases.map(row=>row.id));
  for(const name of await fs.readdir(archiveDir)) {
    const archive = JSON.parse(await fs.readFile(path.join(archiveDir,name)));
    archive.desktopLeases.forEach(row=>observed.add(row.id));
    assert.equal((await fs.stat(path.join(archiveDir,name))).mode & 0o777,0o400);
  }
  assert.deepEqual(observed,expected);
});

test('an unsafe archive directory fails closed before changing live state or a current fence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'desktop-history-failure-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'leases.json'), archiveDir=path.join(root,'archive');
  await fs.mkdir(archiveDir,{mode:0o755});
  const store = new DesktopLeaseStore(file,{historyRetention:{archiveDir,keepReleased:1,threshold:2}});
  await store.init();
  for(let i=0;i<2;i++) { const result=await store.acquire({desktopSlug:`desk-${i}`,threadId:'worker'});
    await store.release(`desk-${i}`,{threadId:'worker',fencingToken:result.lease.fencingToken}); }
  const before=await fs.readFile(file);
  await assert.rejects(store.acquire({desktopSlug:'another',threadId:'worker'}),/desktop_lease_history_archive_refused/);
  assert.deepEqual(await fs.readFile(file),before);
});
