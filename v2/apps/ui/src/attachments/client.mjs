// Attachment routes: Isolation 146bcb4aa6. Core transfer ABI 9cd9268234.
import {referenceFor,verifyBytes} from './integrity.mjs';

// Inert string UTF-8 caps are 4096+1024+128. JSON can expand each input
// byte to six bytes (control escapes). 512/reference covers keys, two UUIDs,
// state and a u64 decimal; 1024 covers each manifest/page envelope.
// Transfer archives retain their independent 68 MiB wire cap.
export const ATTACHMENT_MANIFEST_JSON_LIMIT = 1024 + 128 * (6 * (4096 + 1024 + 128) + 512);
export const ATTACHMENT_PAGE_JSON_LIMIT = 1024 + 16 * ATTACHMENT_MANIFEST_JSON_LIMIT;
export const ATTACHMENT_RECEIPT_JSON_LIMIT = ATTACHMENT_MANIFEST_JSON_LIMIT + 128 * 256 + 1024;

// Sealed objects (application/age) are opened by `open(ciphertext)`, which
// returns the decoded V1 payload {filename,mimetype,bytes}; the bytes are then
// verified against the manifest like a plaintext download.
export function createAttachmentClient({owner,conversation,csrf,current,fetcher=fetch,random=()=>crypto.randomUUID(),hash=bytes=>crypto.subtle.digest('SHA-256',bytes),open=async()=>{throw new Error('File decryption unavailable');}}) {
 const uuid=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if((owner!=null&&!uuid.test(owner))||!uuid.test(conversation)||!csrf)throw new Error('File session unavailable');
 const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
 const root=`/api/v2/conversations/${conversation}`;
 let closed=false,revision=0,pending=null;const active=new Set();
 const check=()=>{if(closed||!current())throw new Error('File selection changed');};
 const scope=m=>({owner_id:owner,conversation_id:conversation,manifest_id:m.manifest_id});
 const identifier=id=>{if(!uuid.test(id))throw new Error('Invalid file reference');return id;};
 async function request(path,{method='GET',body,raw=false,limit=ATTACHMENT_RECEIPT_JSON_LIMIT}={}){
  check();const controller=new AbortController();active.add(controller);const timer=setTimeout(()=>controller.abort(),30000);
  try{
   const encoded=body===undefined?undefined:JSON.stringify(body);
   if(encoded!==undefined&&new TextEncoder().encode(encoded).length>68*1024*1024)throw new Error('File copy exceeds transfer limit');
   const response=await fetcher(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
    headers:method==='GET'?{}:{'Content-Type':'application/json','x-orkestr-csrf':csrf},...(body!==undefined?{body:encoded}:{})});
   check();if(response.status!==200){void response.body?.cancel().catch(()=>{});const error=new Error(response.status===401?'Sign in again to access files':response.status===410?'File removed':response.status===409?'File request changed or unavailable':'File request refused');error.status=response.status;throw error;}
   if(response.redirected||response.headers.get('content-encoding'))throw new Error('Unexpected file representation');
   if(raw)return await raw(response);
   const reader=response.body?.getReader();if(!reader)throw new Error('File response missing');
   let size=0,reads=0,text='';const decoder=new TextDecoder();
   try{while(true){if(++reads>65536)throw new Error('File response read limit');const part=await reader.read();check();if(part.done)break;size+=part.value.byteLength;if(size>limit)throw new Error('File response too large');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
   finally{void reader.cancel().catch(()=>{});}
  }finally{clearTimeout(timer);active.delete(controller);controller.abort();}
 }
 async function list(after=null){
  if(after!==null)identifier(after);
  const page=await request(`${root}/attachment-manifests?${after?`after_id=${after}&`:''}limit=16`,{limit:ATTACHMENT_PAGE_JSON_LIMIT});
  if(!uuid.test(page.owner_id)||page.conversation_id!==conversation||(owner&&page.owner_id!==owner)||page.after_id!==after||!Array.isArray(page.manifests)||page.manifests.length>16)throw new Error('File list scope mismatch');
  owner=page.owner_id;let previous=after;
  for(const m of page.manifests){validate(m);if(previous&&m.manifest_id<=previous)throw new Error('File list cursor mismatch');previous=m.manifest_id;}
  if(page.next_after_id!==null&&(page.manifests.length!==16||page.next_after_id!==previous))throw new Error('File list cursor mismatch');
  return page;
 }
 async function openManifest(id){const m=await request(`${root}/attachment-manifests/${identifier(id)}`,{limit:ATTACHMENT_MANIFEST_JSON_LIMIT});validate(m);if(m.manifest_id!==id)throw new Error("File collection identity mismatch");return m;}
 function validate(m){
  if(!Array.isArray(m.references))throw new Error('File metadata invalid');
  // Validate empty manifests too, using the missing-reference result only after scope checks.
  if(m.references.length)referenceFor(m,scope(m),m.references[0].reference_id);
  else {try{referenceFor(m,scope(m),random());}catch(error){if(error.message!=='Attachment reference missing')throw error;}}
  return m;
 }
 async function validateBundle(bundle){
  const m=bundle?.manifest;if(!m||!Array.isArray(bundle.contents)||bundle.contents.length>128)throw new Error('Invalid file archive');
  const sourceScope={owner_id:m.owner_id,conversation_id:m.conversation_id,manifest_id:m.manifest_id};
  const contents=new Map();let total=0;
  for(const part of bundle.contents){if(!part||Object.keys(part).sort().join(',')!=='bytes,reference_id'||!Array.isArray(part.bytes)||contents.has(part.reference_id.toLowerCase()))throw new Error('Invalid file archive');total+=part.bytes.length;if(total>16777216||part.bytes.some(b=>!Number.isInteger(b)||b<0||b>255))throw new Error('Invalid file bytes');contents.set(part.reference_id.toLowerCase(),part.bytes);}
  if(!m.references.length){try{referenceFor(m,sourceScope,random());}catch(error){if(error.message!=='Attachment reference missing')throw error;}}
  for(const ref of m.references){const bytes=contents.get(ref.reference_id.toLowerCase());let sent=false;
   await verifyBytes({manifest:m,scope:sourceScope,referenceId:ref.reference_id,current:()=>!closed&&current(),digest:hash,
    reader:bytes===undefined?null:{read:async()=>sent?{done:true}:(sent=true,{done:false,value:Uint8Array.from(bytes)}),cancel:async()=>{}}});
   contents.delete(ref.reference_id.toLowerCase());
  }
  if(contents.size)throw new Error('Unknown file content');check();return bundle;
 }
 async function prepareCopy(source){
  check();if(pending)return pending;
  if(!uuid.test(owner))throw new Error('Refresh the file list before uploading');
  // Snapshot before asynchronous hashing so edits cannot mutate the frozen request.
  source=structuredClone(source);await validateBundle(source);check();
  const mapping=source.manifest.references.map(r=>({source_reference_id:r.reference_id,target_reference_id:random()}));
  const target_manifest={...source.manifest,manifest_id:random(),owner_id:owner,conversation_id:conversation,references:source.manifest.references.map((r,i)=>({...r,reference_id:mapping[i].target_reference_id,message_id:null}))};
  validate(target_manifest);pending={kind:'import',path:`${root}/attachment-imports`,body:{request_key:random(),source,target_manifest,mapping}};return pending;
 }
 async function upload(file){
  check();if(pending)return pending;
  if(!file||file.size>16777216)throw new Error('Choose a file up to 16 MiB');
  const bytes=new Uint8Array(await file.arrayBuffer());check();if(bytes.length!==file.size)throw new Error('File size changed');
  const sha256=[...new Uint8Array(await hash(bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');check();
  const ref={reference_id:random(),message_id:null,filename:file.name,media_type:file.type||'application/octet-stream',byte_length:bytes.length,sha256,state:'available'};
  return prepareCopy({manifest:{schema_version:1,manifest_id:random(),owner_id:owner,conversation_id:conversation,references:[ref]},contents:[{reference_id:ref.reference_id,bytes:Array.from(bytes)}]});
 }
 async function commit(){
  check();if(!pending)throw new Error('No file request to retry');const frozen=pending;
  const result=await request(frozen.path,{method:frozen.kind==='import'?'POST':'DELETE',body:frozen.body});check();
  if(frozen.kind==='import'){
   if(result.source_manifest_id!==frozen.body.source.manifest.manifest_id||canonical(result.mapping)!==canonical(frozen.body.mapping)||canonical(result.manifest)!==canonical(frozen.body.target_manifest)||!uuid.test(result.import_id))throw new Error('File receipt mismatch');
   validate(result.manifest);
  }else if(result.manifest_id!==frozen.manifest||result.reference_id!==frozen.reference||result.removed!==true)throw new Error('File removal receipt mismatch');
  pending=null;return result;
 }
 async function remove(m,id){
  referenceFor(m,scope(m),id);revision++; // Invalidate any in-flight download before mutation.
  if(!pending)pending={kind:'remove',manifest:m.manifest_id,reference:id,path:`${root}/attachments/${identifier(m.manifest_id)}/${identifier(id)}`,body:{request_key:random()}};
  if(pending.kind!=='remove'||pending.manifest!==m.manifest_id||pending.reference!==id)throw new Error('Finish the pending file request first');return commit();
 }
 async function download(m,id){
  const version=revision;const latest=await openManifest(m.manifest_id);const ref=referenceFor(latest,scope(latest),id);
  if(ref.state!=='available')throw new Error(ref.state==='inert'?'Saved reference only; no file bytes':'File removed');
  const result=await request(`${root}/attachments/${identifier(latest.manifest_id)}/${identifier(id)}`,{raw:async response=>{
   const live=()=>!closed&&current()&&version===revision;
   if(response.headers.get('x-content-type-options')!=='nosniff')throw new Error('File response metadata mismatch');
   if(response.headers.get('content-type')==='application/age'){
    const ciphertext=await readSealed(response.body.getReader(),sealedLimit(ref.byte_length),live);
    const opened=await open(ciphertext);if(!live())throw new Error('File selection changed');
    return verifyBytes({manifest:latest,scope:scope(latest),referenceId:id,reader:once(opened.bytes),current:live,digest:hash});
   }
   if(response.headers.get('content-length')!==String(ref.byte_length)||response.headers.get('content-type')!==ref.media_type)throw new Error('File response metadata mismatch');
   return verifyBytes({manifest:latest,scope:scope(latest),referenceId:id,reader:response.body.getReader(),current:live,digest:hash});
  }});
  // Removal leaves identity/digest unchanged: revalidate tombstone immediately before save.
  const final=await openManifest(latest.manifest_id);if(referenceFor(final,scope(final),id).state!=='available'||version!==revision)throw new Error('File removed or selection changed');check();return result;
 }
 // The saved archive holds plaintext copies: sealed contents are opened here.
 async function exportCopy(m){
  const stored=await request(`${root}/attachment-manifests/${identifier(m.manifest_id)}/export`,{limit:72*1024*1024});validate(stored.manifest);if(stored.manifest.manifest_id!==m.manifest_id)throw new Error("File collection identity mismatch");
  if(!Array.isArray(stored.contents)||stored.contents.length>128)throw new Error('Invalid file archive');
  const contents=[];
  for(const part of stored.contents){
   if(!part||!Array.isArray(part.bytes))throw new Error('Invalid file archive');
   if(part.format==='plain')contents.push({reference_id:part.reference_id,bytes:part.bytes});
   else if(part.format==='age-x25519-v1'){const opened=await open(Uint8Array.from(part.bytes));check();contents.push({reference_id:part.reference_id,bytes:Array.from(opened.bytes)});}
   else throw new Error('Unsupported file format');
  }
  const bundle={manifest:stored.manifest,contents};await validateBundle(bundle);return bundle;
 }
 return {list,open:openManifest,upload,prepareCopy,commit,remove,download,exportCopy,pending:()=>pending,close(){closed=true;revision++;for(const controller of active)controller.abort();active.clear();pending=null;}};
}

// age adds a header (per recipient) and 16 bytes per 64 KiB chunk; the V1
// payload adds a small JSON header. Anything larger is refused unread.
export const sealedLimit=length=>length+256*1024+16*(Math.ceil(length/65536)+2);
async function readSealed(reader,limit,live){
 const parts=[];let size=0,reads=0;
 try{while(true){if(++reads>65536)throw new Error('File response read limit');const part=await reader.read();if(!live())throw new Error('File selection changed');if(part.done)break;if(!(part.value instanceof Uint8Array))throw new Error('File response invalid');size+=part.value.byteLength;if(size>limit)throw new Error('File response too large');parts.push(part.value);}}
 finally{void reader.cancel().catch(()=>{});}
 const out=new Uint8Array(size);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;
}
function once(bytes){let sent=false;return {read:async()=>sent?{done:true}:(sent=true,{done:false,value:bytes}),cancel:async()=>{}};}
