import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,writeFile,symlink,link,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compatible,encoded,LIMITS,requirements,sha,validateManifest} from '../scripts/release_contract.mjs';
import {createManifest,prepareSnapshot} from '../scripts/ui_release.mjs';

const SOURCE='a'.repeat(40),BACKEND='b'.repeat(40);
const required={api_contract_version:0,required_server_features:[]};
const profile={format:'orkestr-ui-backend-profile-v1',source_commit:BACKEND,server_sha256:'c'.repeat(64),code_subject_sha256:'d'.repeat(64),api_contract_version:0,features:[]};
async function fixture(t){
  const root=await realpath(await mkdtemp(join(tmpdir(),'orkestr-ui-release-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bundle=join(root,'bundle');await mkdir(bundle);
  for(const [name,bytes]of Object.entries({'index.html':'<!doctype html><div id="main"></div>','orkestr_v2_ui.js':'export default async()=>{};','orkestr_v2_ui_bg.wasm':Buffer.from([0,97,115,109,1,0,0,0]),'encrypted_upload.js':'export const nativeDescribe=()=>{};'}))await writeFile(join(bundle,name),bytes);
  const manifest=await createManifest(bundle,SOURCE,[BACKEND],required);
  return {root,bundle,manifest,prepare:(changes={})=>prepareSnapshot({bundle,manifest,approvedBackend:profile,observedBackend:profile,output:join(root,'snapshot'),...changes})};
}

test('snapshot pins a complete namespace and emits only public bytes without selecting it',async t=>{
  const f=await fixture(t),plan=await f.prepare();
  assert.equal(plan.release_id,sha(encoded(f.manifest)));assert.equal(plan.selected,false);assert.equal(plan.live_configuration_changed,false);
  const output=join(f.root,'snapshot');assert.deepEqual((await readdir(output)).sort(),['_ui','index.html']);
  const html=await readFile(join(output,'index.html'),'utf8');
  assert.match(html,new RegExp(`content="/_ui/${plan.release_id}/"`));
  for(const name of ['orkestr_v2_ui.js','orkestr_v2_ui_bg.wasm'])assert.ok(html.includes(`${plan.asset_prefix}${name}?v=${f.manifest.assets[name].sha256.slice(0,16)}`));
  for(const [name,pin]of Object.entries(f.manifest.assets))assert.equal(sha(await readFile(join(output,'_ui',plan.release_id,name))),pin.sha256);
  assert.equal(sha(Buffer.from(html)),plan.bootstrap_sha256);
  assert.equal(plan.backend_profile_sha256,sha(encoded(profile)));
});

test('incomplete, changed, added and removed assets fail before creating output',async t=>{
  for(const change of ['bytes','added','removed'])await t.test(change,async t=>{
    const f=await fixture(t);
    if(change==='bytes')await writeFile(join(f.bundle,'encrypted_upload.js'),'changed content');
    if(change==='added')await writeFile(join(f.bundle,'unexpected.js'),'extra');
    if(change==='removed')await rm(join(f.bundle,'index.html'));
    await assert.rejects(f.prepare(),/inventory/);
    await assert.rejects(readFile(join(f.root,'snapshot','index.html')),/ENOENT/);
  });
});

test('aliases, hardlinks, hidden files and unknown types are refused',async t=>{
  for(const kind of ['symlink','hardlink','hidden','unknown','root-alias'])await t.test(kind,async t=>{
    const f=await fixture(t);let bundle=f.bundle;
    if(kind==='symlink')await symlink(join(f.bundle,'index.html'),join(f.bundle,'alias.html'));
    if(kind==='hardlink')await link(join(f.bundle,'index.html'),join(f.bundle,'alias.html'));
    if(kind==='hidden')await writeFile(join(f.bundle,'.private'),'synthetic');
    if(kind==='unknown')await writeFile(join(f.bundle,'unknown.txt'),'synthetic');
    if(kind==='root-alias'){bundle=join(f.root,'alias');await symlink(f.bundle,bundle);}
    await assert.rejects(createManifest(bundle,SOURCE,[BACKEND],required));
  });
});

test('strict document fields, paths, MIME, count and size limits fail closed',async t=>{
  const {manifest}=await fixture(t);
  for(const path of ['../x.js','api/x.js','_ui/x.js','a//x.js','a/%2e.js','a/../x.js','.cache/x.js','a\\x.js','x.js?x','x.js#x','/x.js']){
    const value=structuredClone(manifest);value.assets[path]=value.assets['encrypted_upload.js'];assert.throws(()=>validateManifest(value));
  }
  for(const value of [
    {...manifest,extra:true},
    {...manifest,backend_compatibility:{...manifest.backend_compatibility,extra:true}},
    {...manifest,entrypoints:{...manifest.entrypoints,module:'other.js'}},
    {...manifest,ui_source_commit:'moving-branch'},
  ])assert.throws(()=>validateManifest(value));
  const badMime=structuredClone(manifest);badMime.assets['index.html'].content_type='application/javascript';assert.throws(()=>validateManifest(badMime),/MIME/);
  const tooBig=structuredClone(manifest);tooBig.assets['index.html'].bytes=LIMITS.file+1;assert.throws(()=>validateManifest(tooBig),/oversized/);
  const tooMany=structuredClone(manifest);for(let i=0;i<LIMITS.files;i++)tooMany.assets[`file${i}.js`]={...manifest.assets['encrypted_upload.js']};assert.throws(()=>validateManifest(tooMany),/count/);
  const total=structuredClone(manifest);for(let i=0;i<8;i++)total.assets[`big${i}.js`]={...manifest.assets['encrypted_upload.js'],bytes:LIMITS.file};assert.throws(()=>validateManifest(total),/snapshot size/);
});

test('oversized on-disk files are rejected without reading them into memory',async t=>{
  const f=await fixture(t);await truncate(join(f.bundle,'encrypted_upload.js'),LIMITS.file+1);
  await assert.rejects(createManifest(f.bundle,SOURCE,[BACKEND],required),/bounded/);
});

test('exact qualified backend tuple and API requirements guard snapshot preparation',async t=>{
  const f=await fixture(t);
  for(const field of ['source_commit','server_sha256','code_subject_sha256']){
    const observed={...profile,[field]:'e'.repeat(field==='source_commit'?40:64)};
    await assert.rejects(f.prepare({observedBackend:observed}),/backend identity changed/);
  }
  const other={...profile,source_commit:'f'.repeat(40)};
  await assert.rejects(f.prepare({approvedBackend:other,observedBackend:other}),/backend source/);
  const v1={...profile,api_contract_version:1};await assert.rejects(f.prepare({approvedBackend:v1,observedBackend:v1}),/API contract/);
  const quota=structuredClone(f.manifest);quota.backend_compatibility.required_server_features=['provider_quotas_v1'];
  assert.throws(()=>compatible(quota,profile,profile),/feature missing/);
  const supported={...profile,features:['provider_quotas_v1']};
  // Capability presence is distinct from the quota data's ready/unavailable state.
  assert.equal(compatible(quota,supported,supported),sha(encoded(supported)));
});

test('an existing output and input-contained output are never overwritten',async t=>{
  const f=await fixture(t),output=join(f.root,'snapshot');await mkdir(output);await writeFile(join(output,'sentinel'),'keep');
  await assert.rejects(f.prepare(),/EEXIST/);assert.equal(await readFile(join(output,'sentinel'),'utf8'),'keep');
  await assert.rejects(f.prepare({output:join(f.bundle,'snapshot')}),/outside/);
});

test('CLI rejects noncanonical or duplicate-key manifests and never selects a release',async t=>{
  const f=await fixture(t),manifest=join(f.root,'manifest.json'),approval=join(f.root,'backend.json');
  await writeFile(approval,encoded(profile));
  await writeFile(manifest,JSON.stringify(f.manifest,null,2));
  const cli=fileURLToPath(new URL('../scripts/ui_release.mjs',import.meta.url));
  const args=[cli,'snapshot','--bundle',f.bundle,'--manifest',manifest,'--approved-backend',approval,'--observed-backend',approval,'--output',join(f.root,'snapshot')];
  await assert.rejects(promisify(execFile)(process.execPath,args),/canonical UI manifest/);
  await writeFile(manifest,encoded(f.manifest).toString().replace('{','{"format":"wrong",'));
  await assert.rejects(promisify(execFile)(process.execPath,args),/canonical UI manifest/);
  await writeFile(manifest,encoded(f.manifest));
  const {stdout}=await promisify(execFile)(process.execPath,args);assert.equal(JSON.parse(stdout).selected,false);
});

test('the checked-in release requirements pass the release contract (sorted, unique, known fields)',async()=>{
  const file=fileURLToPath(new URL('../release_requirements.json',import.meta.url));
  const value=JSON.parse(await readFile(file,'utf8'));
  assert.doesNotThrow(()=>requirements(value));
  assert.deepEqual(value.required_server_features,[...value.required_server_features].sort());
});
