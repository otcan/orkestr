// Public UI bytes and compatibility only. Backend approval and publication
// authority belong to the operator; this module never contacts a live service.
import {createHash} from 'node:crypto';

export const LIMITS = Object.freeze({file:8*1024*1024,total:64*1024*1024,files:4096,depth:16});
export const TYPES = Object.freeze({html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json',wasm:'application/wasm',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',ico:'image/x-icon',webp:'image/webp',woff:'font/woff',woff2:'font/woff2'});
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function requireValue(value,reason){if(!value)throw Error(reason);}
export function canonical(value){
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const encoded = value => Buffer.from(canonical(value)+'\n');
export function keys(value,names){
  requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...names].sort().join('|'),'unknown or missing document fields');
}
const digest=(value,length)=>typeof value==='string'&&new RegExp(`^[0-9a-f]{${length}}$`).test(value);
export function source(value){requireValue(digest(value,40),'exact UI/backend source commit required');return value;}
function list(value,check,max){
  requireValue(Array.isArray(value)&&value.length<=max&&value.every(check)&&new Set(value).size===value.length,'invalid compatibility list');
  requireValue(value.join('|')===[...value].sort().join('|'),'compatibility lists must be sorted');
}
const feature=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,95}$/.test(value);
export function requirements(value){
  keys(value,['api_contract_version','required_server_features']);
  requireValue(Number.isSafeInteger(value.api_contract_version)&&value.api_contract_version>=0,'invalid API contract version');
  list(value.required_server_features,feature,64);return value;
}
export function assetPath(value){
  requireValue(typeof value==='string'&&value.length<=512&&/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value),'invalid UI asset path');
  const parts=value.split('/');
  requireValue(parts.length<=LIMITS.depth&&parts.every(part=>part&&part!=='.'&&part!=='..'&&!part.startsWith('.'))&&!['api','_ui'].includes(parts[0]),'reserved or traversing UI asset path');
  requireValue(Object.hasOwn(TYPES,value.split('.').at(-1)),'unsupported UI asset type');return value;
}
export function validateManifest(value){
  keys(value,['format','ui_source_commit','backend_compatibility','entrypoints','assets']);
  requireValue(value.format==='orkestr-ui-release-v1','unsupported UI release format');source(value.ui_source_commit);
  const c=value.backend_compatibility;
  keys(c,['api_contract_version','source_commits','required_server_features']);
  requirements({api_contract_version:c.api_contract_version,required_server_features:c.required_server_features});
  list(c.source_commits,v=>digest(v,40),32);requireValue(c.source_commits.length>0,'explicit compatible backend sources required');
  keys(value.entrypoints,['module','wasm']);
  requireValue(value.entrypoints.module==='orkestr_v2_ui.js'&&value.entrypoints.wasm==='orkestr_v2_ui_bg.wasm','unsupported UI bootstrap entrypoints');
  requireValue(value.assets&&typeof value.assets==='object'&&!Array.isArray(value.assets),'invalid asset inventory');
  const files=Object.entries(value.assets);let total=0;
  requireValue(files.length>0&&files.length<=LIMITS.files,'UI asset count exceeded');
  for(const [name,pin]of files){
    assetPath(name);keys(pin,['sha256','bytes','content_type']);
    requireValue(digest(pin.sha256,64)&&Number.isSafeInteger(pin.bytes)&&pin.bytes>=0&&pin.bytes<=LIMITS.file,'invalid or oversized UI asset');
    requireValue(pin.content_type===TYPES[name.split('.').at(-1)],'UI MIME mismatch');total+=pin.bytes;
  }
  requireValue(total<=LIMITS.total,'UI snapshot size exceeded');
  for(const name of ['index.html',value.entrypoints.module,value.entrypoints.wasm])requireValue(Object.hasOwn(value.assets,name),'incomplete UI release');
  return value;
}
export function backendProfile(value){
  keys(value,['format','source_commit','server_sha256','code_subject_sha256','api_contract_version','features']);
  requireValue(value.format==='orkestr-ui-backend-profile-v1','invalid backend profile');source(value.source_commit);
  requireValue(digest(value.server_sha256,64)&&digest(value.code_subject_sha256,64),'exact backend byte identity required');
  requirements({api_contract_version:value.api_contract_version,required_server_features:value.features});return value;
}
export function compatible(manifest,approved,observed){
  validateManifest(manifest);backendProfile(approved);backendProfile(observed);
  requireValue(canonical(approved)===canonical(observed),'qualified backend identity changed');
  const c=manifest.backend_compatibility;
  requireValue(c.source_commits.includes(observed.source_commit),'backend source is not approved for this UI');
  requireValue(c.api_contract_version===observed.api_contract_version,'backend API contract mismatch');
  requireValue(c.required_server_features.every(feature=>observed.features.includes(feature)),'required backend feature missing');
  return sha(encoded(approved));
}
