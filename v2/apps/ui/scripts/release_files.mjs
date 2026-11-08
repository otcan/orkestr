// Bounded, byte-pinned snapshot reads. No request-selected paths or symlinks.
import {constants} from 'node:fs';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {assetPath,LIMITS,requireValue,sha,TYPES} from './release_contract.mjs';

const identity=s=>[s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeNs,s.ctimeNs].map(String).join(':');
export async function directory(path){
  requireValue(isAbsolute(path),'absolute UI directory required');
  const stat=await lstat(path,{bigint:true});requireValue(stat.isDirectory()&&!stat.isSymbolicLink(),'UI directory must not be an alias');
  return realpath(resolve(path));
}
export async function readFile(path,limit){
  const before=await lstat(path,{bigint:true});
  requireValue(before.isFile()&&before.nlink===1n&&before.size<=BigInt(limit),'bounded single-link regular file required');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    requireValue(identity(await file.stat({bigint:true}))===identity(before),'UI input replaced');
    const bytes=Buffer.alloc(Number(before.size));let at=0;
    while(at<bytes.length){const part=await file.read(bytes,at,bytes.length-at,at);requireValue(part.bytesRead>0,'UI input truncated');at+=part.bytesRead;}
    requireValue(identity(await file.stat({bigint:true}))===identity(before)&&identity(await lstat(path,{bigint:true}))===identity(before),'UI input changed');
    return bytes;
  }finally{await file.close();}
}
export async function inventory(path){
  const root=await directory(path),files={},directories=new Map();let total=0;
  async function walk(relative='',depth=0){
    requireValue(depth<LIMITS.depth,'UI directory depth exceeded');
    const path=join(root,relative),stat=await lstat(path,{bigint:true});
    requireValue(stat.isDirectory()&&!stat.isSymbolicLink(),'UI directory alias refused');directories.set(path,identity(stat));
    for(const name of (await readdir(path)).sort()){
      const key=relative?`${relative}/${name}`:name;
      requireValue(!name.startsWith('.')&&!/[\\%]/.test(name),'hidden or aliased UI input');
      const selected=join(root,key),info=await lstat(selected,{bigint:true});
      if(info.isDirectory())await walk(key,depth+1);
      else{
        assetPath(key);const bytes=await readFile(selected,LIMITS.file);total+=bytes.length;
        requireValue(Object.keys(files).length<LIMITS.files&&total<=LIMITS.total,'UI inventory limit exceeded');
        files[key]={sha256:sha(bytes),bytes:bytes.length,content_type:TYPES[name.split('.').at(-1)]};
      }
    }
  }
  await walk();
  for(const [path,stamp]of directories)requireValue(identity(await lstat(path,{bigint:true}))===stamp,'UI directory changed');
  return {root,files};
}
