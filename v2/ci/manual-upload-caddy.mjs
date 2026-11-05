// Loopback-only disposable Caddy, no public listener or production reload.
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {stop} from './manual-upload-system.mjs';
export async function caddyProxy(dir,unit,upstream){
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const config={admin:{disabled:true},apps:{http:{servers:{acceptance:{listen:[`127.0.0.1:${port}`],routes:[{handle:[{handler:'reverse_proxy',upstreams:[{dial:new URL(upstream).host}],flush_interval:-1}]}]}}}}};
  const path=join(dir,'source/caddy.json');await writeFile(path,JSON.stringify(config),{mode:0o600});
  const args=['-n','/usr/bin/systemd-run','--quiet','--pipe','--wait','--collect',`--unit=${unit}`,`--uid=${process.getuid()}`,`--gid=${process.getgid()}`,'--property=MemoryMax=256M','--property=CPUQuota=100%','--property=NoNewPrivileges=yes','--property=TimeoutStopSec=5s','/usr/bin/env','-i','PATH=/usr/bin:/bin',`HOME=${join(dir,'source')}`,'/usr/bin/caddy','run','--config',path];
  const child=spawn('sudo',args,{stdio:['ignore','ignore','pipe']});child.stderr.resume();
  const origin=`http://127.0.0.1:${port}`;
  for(let n=0;;n++){try{if((await fetch(origin)).ok)break;}catch{}if(n>100||child.exitCode!==null)throw Error('Disposable Caddy startup failed');await new Promise(resolve=>setTimeout(resolve,100));}
  return{origin,config,close:()=>stop(unit)};
}
