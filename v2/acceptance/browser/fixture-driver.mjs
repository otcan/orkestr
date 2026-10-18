// Private stdio control of a test-only Store fixture. Never an HTTP endpoint.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createInterface} from 'node:readline';

export async function fixtureDriver({executable, db, username, conversation, context}) {
  const parent=await fs.realpath(path.dirname(db));
  const temporary=await fs.realpath(os.tmpdir());
  assert(parent.startsWith(temporary+path.sep+'orkestr-v2-browser-'),'isolated_synthetic_home_required');
  assert.equal(await fs.readFile(path.join(parent,'browser-fixture.marker'),'utf8'),'synthetic-browser-fixture-v1\n');
  assert((await fs.lstat(db)).isFile(),'regular_fixture_db_required');
  assert(username.startsWith('synthetic-'));
  const child=spawn(executable,['--exact','fixture_driver::browser_fixture_driver','--ignored','--nocapture','--test-threads=1'],{
    stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',
      ORKESTR_V2_BROWSER_FIXTURE_DB:db,ORKESTR_V2_BROWSER_FIXTURE_USERNAME:username,
      ORKESTR_V2_BROWSER_FIXTURE_CONVERSATION:conversation},
  });
  let pending, closed=false;
  const fail=()=>{closed=true;if(pending){clearTimeout(pending.timer);pending.reject(new Error('synthetic_fixture_driver_failed'));pending=null;}};
  const next=()=>new Promise((resolve,reject)=>{
    assert(!pending&&!closed,'fixture_command_not_serial');
    const timer=setTimeout(()=>{fail();child.kill('SIGTERM');},15000);
    pending={resolve,reject,timer};
  });
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    if(!line.startsWith('FIXTURE '))return;
    if(!pending||line.length>8192){fail();return;}
    try{const value=JSON.parse(line.slice(8));const current=pending;pending=null;clearTimeout(current.timer);current.resolve(value);}
    catch{fail();}
  });
  child.stderr.on('data',()=>{}); // Do not forward potentially credential-bearing panic diagnostics.
  child.on('error',fail);child.on('exit',fail);
  const ready=await next();assert.equal(ready.ready,true);
  const command=async action=>{const reply=next();child.stdin.write(JSON.stringify(action)+'\n');return reply;};
  return {
    completed:()=>command({action:'completed'}),
    progress:()=>command({action:'progress'}),
    advanceRevision:()=>command({action:'advanceRevision'}),
    revokeBrowserSession:async()=>{
      const cookie=(await context.cookies()).find(c=>c.name==='orkestr_v2_session');
      assert(cookie,'owned_browser_cookie_required');
      return command({action:'revokeBrowserSession',browser_token:cookie.value});
    },
    close:async()=>{
      if(child.exitCode!==null)return;
      const exited=new Promise(resolve=>child.once('exit',resolve));
      child.stdin.end();
      const kill=setTimeout(()=>child.kill('SIGTERM'),2000);
      const force=setTimeout(()=>child.kill('SIGKILL'),4000);
      try{await exited;}finally{clearTimeout(kill);clearTimeout(force);lines.close();}
    },
  };
}
