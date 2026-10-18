// Private stdio control of a test-only Store fixture. Never an HTTP endpoint.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function fixtureDriver({executable, db, username, conversation, context}) {
  const parent=await fs.realpath(path.dirname(db));
  const temporary=await fs.realpath(os.tmpdir());
  assert(parent.startsWith(temporary+path.sep+'orkestr-v2-browser-'),'isolated_synthetic_home_required');
  assert.equal(await fs.readFile(path.join(parent,'browser-fixture.marker'),'utf8'),'synthetic-browser-fixture-v1\n');
  assert((await fs.lstat(db)).isFile(),'regular_fixture_db_required');
  assert(username.startsWith('synthetic-'));
  const owned=await fixtureProcess({executable,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',
    ORKESTR_V2_BROWSER_FIXTURE_DB:db,ORKESTR_V2_BROWSER_FIXTURE_USERNAME:username,
    ORKESTR_V2_BROWSER_FIXTURE_CONVERSATION:conversation}});
  const command=owned.command;
  return {
    completed:()=>command({action:'completed'}),
    progress:()=>command({action:'progress'}),
    advanceRevision:()=>command({action:'advanceRevision'}),
    revokeBrowserSession:async()=>{
      const cookie=(await context.cookies()).find(c=>c.name==='orkestr_v2_session');
      assert(cookie,'owned_browser_cookie_required');
      return command({action:'revokeBrowserSession',browser_token:cookie.value});
    },
    close:owned.close,
  };
}

// Test-only process owner, exported for deterministic failure-path regressions.
export async function fixtureProcess({executable,env,deadlineMs=15000,graceMs=2000}) {
  assert(Number.isInteger(deadlineMs)&&deadlineMs>0&&deadlineMs<=15000);
  assert(Number.isInteger(graceMs)&&graceMs>0&&graceMs<=2000);
  const child=spawn(executable,['--exact','fixture_driver::browser_fixture_driver','--ignored','--nocapture','--test-threads=1'],
    {stdio:['pipe','pipe','pipe'],env});
  let pending,closed=false,cleanup,buffer=Buffer.alloc(0);
  // 'close' follows exit AND stdio closure, including failed spawn.
  const reaped=new Promise(resolve=>child.once('close',resolve));
  const close=()=>cleanup??=(async()=>{
    closed=true;
    if(pending){clearTimeout(pending.timer);pending.reject(new Error('synthetic_fixture_driver_failed'));pending=null;}
    child.stdin.destroy();
    child.kill('SIGTERM');
    const force=setTimeout(()=>child.kill('SIGKILL'),graceMs);
    try{await reaped;}finally{clearTimeout(force);child.stdout.destroy();child.stderr.destroy();}
  })();
  const fail=()=>{void close();};
  const next=()=>new Promise((resolve,reject)=>{
    if(pending||closed){reject(new Error('fixture_command_not_serial'));return;}
    pending={resolve,reject,timer:setTimeout(fail,deadlineMs)};
  });
  child.stdout.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    let end;
    while((end=buffer.indexOf(10))!==-1){
      if(end>8192){fail();return;}
      const line=buffer.subarray(0,end).toString('utf8');buffer=buffer.subarray(end+1);
      if(!line.startsWith('FIXTURE '))continue;
      if(!pending||closed){fail();return;}
      try{
        const value=JSON.parse(line.slice(8));const current=pending;pending=null;
        clearTimeout(current.timer);current.resolve(value);
      }catch{fail();return;}
    }
    if(buffer.length>8192)fail();
  });
  child.stderr.on('data',()=>{}); // Never forward credential-bearing diagnostics.
  child.stdin.on('error',fail);child.stdout.on('error',fail);
  child.on('error',fail);child.on('exit',fail);
  try{
    const ready=await next();assert.equal(ready.ready,true);
  }catch{
    await close();throw new Error('synthetic_fixture_driver_failed');
  }
  return {close,command:async action=>{
    try{
      const reply=next();
      child.stdin.write(JSON.stringify(action)+'\n');
      return await reply;
    }catch{
      await close();throw new Error('synthetic_fixture_driver_failed');
    }
  }};
}
