// Sample only the disposable units' process trees; no cmdline/environment read.
import {root,unitStats} from './manual-upload-system.mjs';
export function rssSampler(units){
  const roots=Object.fromEntries(Object.entries(units).map(([name,unit])=>[name,Number(unitStats(unit).MainPID)]));
  const peak=Object.fromEntries(Object.keys(roots).map(name=>[name,{sampled_tree_rss_peak_bytes:0,main_vm_hwm_bytes:0,largest_sample_process_count:0}]));
  const sample=()=>{
    const values=JSON.parse(root('/usr/bin/python3',['-I','-S','-B','-c',`import sys,json
from pathlib import Path
out={}
for name,pid in json.loads(sys.argv[1]).items():
 pending=[pid];seen=set();rss=0;hwm=0
 while pending and len(seen)<1024:
  current=pending.pop()
  if current in seen:continue
  seen.add(current)
  try:
   p=Path('/proc',str(current));fields={line.split(':')[0]:line.split(':',1)[1].strip().split()[0] for line in (p/'status').read_text().splitlines() if line.startswith(('VmRSS:','VmHWM:'))}
   rss+=int(fields.get('VmRSS',0))*1024
   if current==pid:hwm=int(fields.get('VmHWM',0))*1024
   pending.extend(map(int,(p/'task'/str(current)/'children').read_text().split()))
  except (FileNotFoundError,ProcessLookupError):pass
 out[name]={'rss':rss,'hwm':hwm,'processes':len(seen)}
print(json.dumps(out))`,JSON.stringify(roots)]));
    for(const[name,value]of Object.entries(values)){const p=peak[name];p.sampled_tree_rss_peak_bytes=Math.max(p.sampled_tree_rss_peak_bytes,value.rss);p.main_vm_hwm_bytes=Math.max(p.main_vm_hwm_bytes,value.hwm);p.largest_sample_process_count=Math.max(p.largest_sample_process_count,value.processes);}
  };
  let failures=0;const safeSample=()=>{try{sample();}catch{failures++;}};
  safeSample();const timer=setInterval(safeSample,500);timer.unref();
  return()=>{clearInterval(timer);safeSample();return{interval_ms:500,sampling_failures:failures,metrics:peak,note:'sampled sum of process RSS, shared pages may be counted more than once; distinct from page-cache-inclusive cgroup MemoryPeak'};};
}
