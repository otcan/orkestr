// Numeric identities and root operations are confined to a fresh test directory
// and uniquely named transient units. Never changes passwd, groups or sudoers.
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {mkdtemp,chmod,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export const SERVICE=62001,WORKER=62002,GROUP=62003;
export function root(command,args=[]){return execFileSync('sudo',['-n',command,...args],{encoding:'utf8',env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'},maxBuffer:64*1024});}
export async function scratch(){
  for(const[database,id]of[['passwd',SERVICE],['passwd',WORKER],['group',GROUP]]){if(spawnSync('getent',[database,String(id)]).status!==2)throw Error('Acceptance identity is registered');}
  for(const id of[SERVICE,WORKER]){const check=spawn('pgrep',['-u',String(id)]);const code=await new Promise(resolve=>check.once('exit',resolve));if(code!==1)throw Error('Acceptance identity already in use');}
  const dir=await mkdtemp(join(tmpdir(),'orkestr-browser-upload-'));await chmod(dir,0o755);
  for(const name of['source','home','exports','bin'])root('/usr/bin/mkdir',['-m','700',join(dir,name)]);
  root('/usr/bin/chown',[`0:${GROUP}`,dir]);
  root('/usr/bin/chown',[`${process.getuid()}:${process.getgid()}`,join(dir,'source')]);
  for(const name of['home','exports'])root('/usr/bin/chown',[`${SERVICE}:${GROUP}`,join(dir,name)]);
  root('/usr/bin/chmod',['750',join(dir,'exports')]);root('/usr/bin/chmod',['755',join(dir,'bin')]);
  return dir;
}
export function startBackend({binary,dir,unit,bind,origin,bootstrap}){
  const env=['PATH=/usr/bin:/bin','LANG=C.UTF-8',`ORKESTR_V2_HOME=${join(dir,'home')}`,`ORKESTR_V2_BIND=${bind}`,`ORKESTR_V2_ORIGIN=${origin}`,`ORKESTR_V2_BOOTSTRAP_TOKEN=${bootstrap}`,`ORKESTR_V2_ATTACHMENT_EXPORT_DIR=${join(dir,'exports')}`];
  const args=['--quiet','--pipe','--wait','--collect',`--unit=${unit}`,'--property=MemoryMax=3G','--property=CPUQuota=200%','--property=TasksMax=128','--property=NoNewPrivileges=yes','/usr/bin/setpriv',`--reuid=${SERVICE}`,`--regid=${GROUP}`,'--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','/usr/bin/env','-i',...env,binary];
  const process=spawn('sudo',['-n','/usr/bin/systemd-run',...args],{stdio:['ignore','ignore','pipe']});process.stderr.resume();return process;
}
export async function chromeLauncher(dir,unit,chrome){
  const path=join(dir,'source/chrome-launcher.sh');
  const quoted="'"+chrome.replace(/'/g,"'\\''")+"'";
  await writeFile(path,`#!/bin/sh\nexec sudo -n /usr/bin/systemd-run --quiet --pipe --wait --collect --unit=${unit} --uid=${process.getuid()} --gid=${process.getgid()} --property=MemoryMax=2G --property=CPUQuota=200% --property=TasksMax=256 ${quoted} "$@"\n`,{mode:0o700});return path;
}
export function unitStats(unit){
  const text=root('/usr/bin/systemctl',['show',unit,'--property=MemoryPeak','--property=MemoryMax','--property=CPUUsageNSec','--property=MainPID']);
  return Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line=>line.split('=')));
}
export function stop(unit,signal){try{root('/usr/bin/systemctl',signal?['kill',`--signal=${signal}`,'--kill-whom=main',unit]:['stop',unit]);}catch{/* Already stopped/collected. */}}
export function workerEvidence(dir,path){
  return JSON.parse(root('/usr/bin/setpriv',[`--reuid=${WORKER}`,`--regid=${GROUP}`,'--clear-groups','/usr/bin/python3','-I','-S','-B','-c',`import os,sys,json,hashlib
h=hashlib.sha256();n=0
with open(sys.argv[1],'rb') as f:
 while True:
  b=f.read(1048576)
  if not b:break
  h.update(b);n+=len(b)
denied=[]
for p in sys.argv[2:]:
 try:
  with open(p,'rb') as f:f.read(1)
 except PermissionError:denied.append(True)
 else:denied.append(False)
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'bytes':n,'sha256':h.hexdigest(),'core_and_ingest_key_denied':denied}))`,path,join(dir,'home/core.sqlite3'),join(dir,'home/keys/attachment-ingest.age')]));
}
export function cleanup(dir){root('/usr/bin/python3',['-I','-S','-B','-c',`from pathlib import Path
import shutil,sys
p=Path(sys.argv[1]);assert p.parent==Path('/tmp') and p.name.startswith('orkestr-browser-upload-') and not p.is_symlink()
shutil.rmtree(p)`,dir]);}
