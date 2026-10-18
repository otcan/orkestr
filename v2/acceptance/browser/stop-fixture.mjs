// Filesystem barriers for the reviewed synthetic owned_execution_peer.py only.
// Runner owns server configuration, lease, process cleanup and artifact hashes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export async function stopFixture({workspace}) {
  const root=await fs.realpath(workspace),temp=await fs.realpath(os.tmpdir());
  assert(root.startsWith(temp+path.sep+'orkestr-v2-browser-'),'temporary_browser_workspace_required');
  assert.equal(await fs.readFile(path.join(root,'browser-stop.marker'),'utf8'),'synthetic-browser-stop-v1\n');
  const file=async(name,text)=>{
    const target=path.join(root,name);
    try{assert((await fs.lstat(target)).isFile(),'regular_fixture_barrier_required');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    await fs.writeFile(target,text,{flag:'w'});
  };
  const trace=async()=>{
    const target=path.join(root,'synthetic-peer.jsonl');
    assert((await fs.lstat(target)).isFile(),'regular_trace_required');
    const bytes=await fs.readFile(target);assert(bytes.length<=65536,'trace_bound');
    return bytes.toString().trim().split('\n').filter(Boolean).map(line=>{
      const {kind,pid}=JSON.parse(line);assert(typeof kind==='string'&&Number.isSafeInteger(pid)&&pid>1);
      return {kind,pid};
    });
  };
  return {
    configure:async mode=>{assert(['terminal','ack-only'].includes(mode));
      // Configure before launching the fresh owned server/peer. Never change mode in flight.
      await fs.access(path.join(root,'synthetic-peer.jsonl')).then(()=>assert.fail('peer_already_started'),error=>{if(error.code!=='ENOENT')throw error;});
      await file('stop-mode',mode);
    },
    releaseTerminal:()=>file('release-stop',''),
    trace,
    waitPeerGone:async signal=>{
      const rows=await trace();const pids=[...new Set(rows.map(row=>row.pid))];
      assert.equal(pids.length,1,'one_owned_synthetic_peer_required');
      const deadline=performance.now()+8000;
      while(performance.now()<deadline){
        signal.throwIfAborted();
        try{process.kill(pids[0],0);}catch(error){if(error.code==='ESRCH')return;throw error;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw Error('owned_synthetic_peer_not_reaped');
    },
  };
}
