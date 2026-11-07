// Prepares unselected public bytes only. Root-private promotion owns approval,
// current-backend verification, pointer CAS, proxy configuration and rollback.
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {backendProfile,canonical,compatible,encoded,keys,requirements,sha,source,validateManifest} from './release_contract.mjs';
import {inventory,readFile} from './release_files.mjs';

export async function createManifest(bundle,uiSource,backendSources,required){
  source(uiSource);requirements(required);
  const {files}=await inventory(bundle);
  return validateManifest({format:'orkestr-ui-release-v1',ui_source_commit:uiSource,
    backend_compatibility:{...required,source_commits:[...backendSources].sort()},
    entrypoints:{module:'orkestr_v2_ui.js',wasm:'orkestr_v2_ui_bg.wasm'},assets:files});
}
export function bootstrap(manifest,id){
  validateManifest(manifest);
  if(!/^[0-9a-f]{64}$/.test(id))throw Error('invalid UI release identity');
  const base=`/_ui/${id}/`,module=manifest.entrypoints.module,wasm=manifest.entrypoints.wasm;
  return Buffer.from(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><meta name="orkestr-ui-assets" content="${base}"><title>Orkestr</title></head>\n<body><div id="main"></div><script type="module">import init from '${base}${module}?v=${manifest.assets[module].sha256.slice(0,16)}'; await init({module_or_path: '${base}${wasm}?v=${manifest.assets[wasm].sha256.slice(0,16)}'});</script></body></html>\n`);
}
export async function prepareSnapshot({bundle,manifest,approvedBackend,observedBackend,output}){
  validateManifest(manifest);backendProfile(approvedBackend);backendProfile(observedBackend);
  const backend=compatible(manifest,approvedBackend,observedBackend);
  const {root,files}=await inventory(bundle);
  if(canonical(files)!==canonical(manifest.assets))throw Error('UI inventory bytes changed');
  if(!isAbsolute(output))throw Error('absolute unselected output directory required');
  output=resolve(output);
  if(output===root||output.startsWith(root+'/'))throw Error('snapshot output must be outside the input bundle');
  // An existing directory or symlink is always refused. No selector is written.
  await mkdir(output,{mode:0o700});
  const id=sha(encoded(manifest)),prefix=`/_ui/${id}/`,directory=join(output,'_ui',id);
  await mkdir(directory,{recursive:true,mode:0o700});
  for(const [name,pin]of Object.entries(files)){
    const bytes=await readFile(join(root,name),pin.bytes);
    if(sha(bytes)!==pin.sha256)throw Error('UI asset changed before snapshot');
    const target=join(directory,name);await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,bytes,{flag:'wx',mode:0o600});
  }
  // Reject additions/removals, replaced ancestors and concurrent bundle edits.
  if(canonical((await inventory(root)).files)!==canonical(files))throw Error('UI inventory changed during snapshot');
  const html=bootstrap(manifest,id);
  await writeFile(join(output,'index.html'),html,{flag:'wx',mode:0o600});
  return {format:'orkestr-ui-snapshot-plan-v1',release_id:id,ui_source_commit:manifest.ui_source_commit,
    asset_prefix:prefix,asset_count:Object.keys(files).length,bootstrap_sha256:sha(html),
    backend_profile_sha256:backend,selected:false,live_configuration_changed:false};
}
async function document(path){return JSON.parse(await readFile(path,1024*1024));}
async function main(argv){
  const [operation,...args]=argv,options={};
  if(args.length%2)throw Error('expected named arguments');
  for(let i=0;i<args.length;i+=2){const key=args[i].replace(/^--/,'');if(!args[i].startsWith('--')||Object.hasOwn(options,key))throw Error('invalid argument');options[key]=args[i+1];}
  if(operation==='manifest'){
    keys(options,['bundle','source','backend-sources','requirements','output']);
    if(!isAbsolute(options.output)||resolve(options.output).startsWith(resolve(options.bundle)+'/'))throw Error('manifest must be outside the input bundle at an absolute path');
    const value=await createManifest(options.bundle,options.source,options['backend-sources'].split(','),await document(options.requirements));
    await writeFile(options.output,encoded(value),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({manifest_sha256:sha(encoded(value)),selected:false}));
  }else if(operation==='snapshot'){
    keys(options,['bundle','manifest','approved-backend','observed-backend','output']);
    const raw=await readFile(options.manifest,1024*1024),manifest=JSON.parse(raw);
    if(!raw.equals(encoded(manifest)))throw Error('canonical UI manifest required');
    console.log(JSON.stringify(await prepareSnapshot({bundle:options.bundle,manifest,approvedBackend:await document(options['approved-backend']),observedBackend:await document(options['observed-backend']),output:options.output})));
  }else throw Error('expected manifest or snapshot; neither operation publishes a UI');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
