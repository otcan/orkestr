import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixtureProcess} from './fixture-driver.mjs';

async function childCase(body,run) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'orkestr-v2-browser-process-'));
  const executable=path.join(root,'child');const pidFile=path.join(root,'pid');
  await fs.writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.PID_FILE,String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n${body}\n`,{mode:0o700});
  try{
    await run({executable,env:{PID_FILE:pidFile},deadlineMs:1000,graceMs:30});
    const pid=Number(await fs.readFile(pidFile,'utf8'));
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'child must be reaped before rejection/close');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
for(const [name,body] of [
  ['wrong readiness',`console.log('FIXTURE {"ready":false}');`],
  ['malformed readiness',`console.log('FIXTURE {');`],
  ['oversized unterminated readiness',`process.stdout.write('FIXTURE '+ 'x'.repeat(9000));`],
  ['missing readiness',``],
])test(name,()=>childCase(body,async options=>{
  await assert.rejects(fixtureProcess(options),/synthetic_fixture_driver_failed/);
}));
test('malformed command reply terminates and reaps child',()=>childCase(
  `console.log('FIXTURE {"ready":true}');process.stdin.on('data',()=>console.log('FIXTURE invalid'));`,
  async options=>{const owned=await fixtureProcess(options);await assert.rejects(owned.command({action:'progress'}));await owned.close();}
));
test('closed stdin is handled and child reaped',()=>childCase(
  `console.log('FIXTURE {"ready":true}');process.stdin.destroy();`,
  async options=>{const owned=await fixtureProcess(options);await assert.rejects(owned.command({action:'progress'}));await owned.close();}
));
test('explicit close is idempotent and escalates ignored TERM',()=>childCase(
  `console.log('FIXTURE {"ready":true}');`,
  async options=>{const owned=await fixtureProcess(options);await Promise.all([owned.close(),owned.close()]);}
));
test('failed spawn is cleaned up',async()=>{
  await assert.rejects(fixtureProcess({executable:'/nonexistent/synthetic-fixture-driver',env:{},deadlineMs:1000,graceMs:30}));
});
