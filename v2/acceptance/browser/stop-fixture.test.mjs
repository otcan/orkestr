import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {stopFixture} from './stop-fixture.mjs';
async function isolated(run){const root=await fs.mkdtemp(path.join(os.tmpdir(),'orkestr-v2-browser-stop-'));try{await fs.writeFile(path.join(root,'browser-stop.marker'),'synthetic-browser-stop-v1\n');await run(root,await stopFixture({workspace:root}));}finally{await fs.rm(root,{recursive:true,force:true});}}
test('barriers use existing synthetic peer protocol and cannot reconfigure a live fixture',()=>isolated(async(root,fixture)=>{
  await fixture.configure('terminal');assert.equal(await fs.readFile(path.join(root,'stop-mode'),'utf8'),'terminal');
  await fixture.releaseTerminal();assert.equal(await fs.readFile(path.join(root,'release-stop'),'utf8'),'');
  await fs.writeFile(path.join(root,'synthetic-peer.jsonl'),JSON.stringify({kind:'spawn',pid:process.pid})+'\n');
  await assert.rejects(fixture.configure('ack-only'),/peer_already_started/);
  assert.deepEqual(await fixture.trace(),[{kind:'spawn',pid:process.pid}]);
}));
test('symlink barrier is refused without touching target',()=>isolated(async(root,fixture)=>{
  const target=path.join(root,'untouched');await fs.writeFile(target,'unchanged');
  await fs.symlink(target,path.join(root,'release-stop'));
  await assert.rejects(fixture.releaseTerminal(),/regular_fixture_barrier_required/);
  assert.equal(await fs.readFile(target,'utf8'),'unchanged');
}));
test('missing marker and multi-peer trace are refused',()=>isolated(async(root,fixture)=>{
  await fs.writeFile(path.join(root,'synthetic-peer.jsonl'),'{"kind":"spawn","pid":123}\n{"kind":"spawn","pid":456}\n');
  await assert.rejects(fixture.waitPeerGone(new AbortController().signal),/one_owned_synthetic_peer_required/);
  await fs.rm(path.join(root,'browser-stop.marker'));
  await assert.rejects(stopFixture({workspace:root}));
}));
