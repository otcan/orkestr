// Opt-in SIGKILL of only the disposable candidate unit during preparation.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {root,stop,workerEvidence,WORKER,GROUP} from './manual-upload-system.mjs';

export async function crashRecovery({dir,page,unit,backend,provider,receipt,restart,expected}){
  assert.ok(provider.startsWith(join(dir,'exports')+'/'));
  root('/usr/bin/unlink',[provider]); // Only the known published test receipt.
  const request=()=>page.evaluate(async id=>{
    const path=`/api/v2/conversations/${window.session.global_conversation_id}/encrypted-uploads/${id}/attachment`;
    try{const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-orkestr-csrf':window.session.csrf_token},body:'{}'});return{status:response.status,receipt:response.ok?await response.json():null};}
    catch{return{status:0};}
  },receipt.manifest_id);
  const pending=request();let orphan;
  for(let attempt=0;attempt<300;attempt++){
    const found=JSON.parse(root('/usr/bin/python3',['-I','-S','-B','-c',String.raw`import json,sys,re
from pathlib import Path
out=[]
for p in Path(sys.argv[1]).glob('*/*'):
 if re.fullmatch(r'\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp',p.name):
  m=p.lstat()
  if m.st_size>1048576:out.append({'path':str(p),'mode':m.st_mode&511,'bytes':m.st_size})
print(json.dumps(out))`,join(dir,'exports')]));
    if(found.length){assert.equal(found.length,1);orphan=found[0];stop(unit,'SIGKILL');break;}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(orphan,'Preparation finished before a private temp could be killed');
  assert.equal(orphan.mode,0o600);
  await pending;await new Promise(resolve=>backend.exitCode!==null?resolve():backend.once('exit',resolve));
  const denied=root('/usr/bin/setpriv',[`--reuid=${WORKER}`,`--regid=${GROUP}`,'--clear-groups','/usr/bin/python3','-I','-S','-B','-c',`import sys
try:open(sys.argv[1],'rb')
except PermissionError:print('denied')
else:raise SystemExit('worker read private orphan')`,orphan.path]);
  assert.equal(denied.trim(),'denied');
  await restart();
  root('/usr/bin/python3',['-I','-S','-B','-c',"from pathlib import Path;import sys;assert not Path(sys.argv[1]).exists()",orphan.path]);
  const rebuilt=await request();assert.equal(rebuilt.status,200);assert.ok(rebuilt.receipt.note.includes(expected));
  const rebuiltPath=/local file ([^\]]+)/.exec(rebuilt.receipt.note)?.[1];assert.ok(rebuiltPath);
  const worker=workerEvidence(dir,rebuiltPath);assert.equal(worker.sha256,expected);
  return{sigkill_during_plaintext_preparation:true,orphan_mode:orphan.mode,orphan_bytes:orphan.bytes,worker_private_temp_denied:true,startup_orphan_removed:true,reconstructed_worker:worker};
}
