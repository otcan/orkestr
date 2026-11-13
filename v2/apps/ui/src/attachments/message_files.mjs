import {createAttachmentClient} from './client.mjs';
import {ageOpenSealed,ageDecodePayload} from './age.mjs';
import {encryptedUploadClient} from './encrypted_upload.mjs';
import {previewKind,downloadType,MEMORY_DOWNLOAD_LIMIT} from './preview_policy.mjs';

const humanSize=bytes=>bytes<1000?`${bytes} B`:bytes<1e6?`${Math.ceil(bytes/1000)} KB`:`${(bytes/1e6).toFixed(1)} MB`;

// IDs are hints from message text, never authority. Metadata and bytes must pass
// the conversation-scoped client and its ciphertext/plaintext integrity checks.
export function mountMessageFiles({conversation,files,root},{client=encryptedUploadClient({conversation,readOnly:true}),picker=globalThis.showSaveFilePicker?.bind(globalThis),url=URL}={}){
  let live=true;const controllers=new Set(),urls=new Set();
  const legacy=createAttachmentClient({conversation,readOnly:true,current:()=>live,open:async ciphertext=>ageDecodePayload(await ageOpenSealed(ciphertext))});
  let legacyReady=null;
  const active=()=>{if(!live)throw Error('File view closed');};
  const revoke=value=>{if(value){url.revokeObjectURL(value);urls.delete(value);}};
  const blobUrl=(parts,type)=>{active();const value=url.createObjectURL(new Blob(parts,{type}));urls.add(value);return value;};
  for(const file of files){
    let pinned=null;
    const load=async signal=>{
      if(file.kind==='encrypted')return client.status(file.id,{signal});
      if(file.kind!=='manifest')throw Error('Unsupported attachment reference.');
      legacyReady??=legacy.list().catch(error=>{legacyReady=null;throw error;});await legacyReady;active();
      pinned=await legacy.open(file.id);active();
      const reference=pinned.references.find(r=>r.reference_id===file.reference);
      if(!reference||reference.state!=='available')throw Error('File is unavailable or removed.');
      return {file:{filename:reference.filename,media_type:reference.media_type,plaintext_size:reference.byte_length}};
    };
    const download=async(metadata,sink,options)=>{
      const latest=await load(options.signal);active();if(JSON.stringify(latest.file)!==JSON.stringify(metadata.file))throw Error('Attachment metadata changed. Reopen its details.');
      if(file.kind==='encrypted')return client.download(metadata,sink,options);
      try{const verified=await legacy.download(pinned,file.reference);active();await sink.write(verified.bytes);active();await sink.close();}
      catch(error){await sink.abort?.(error);throw error;}
    };
    // The note's name, type and size are display hints only (ORK-786): the
    // card shows them at once, without a request, and every Preview or
    // Download still loads and verifies the conversation-scoped metadata.
    const hint=typeof file.name==='string'&&file.name&&typeof file.media_type==='string'&&Number.isSafeInteger(file.size)&&file.size>=0
      ?{filename:file.name,media_type:file.media_type,plaintext_size:file.size}:null;
    const card=document.createElement('section');card.className='message-file-card';card.setAttribute('data-verified','false');
    const named=typeof file.name==='string'&&file.name?file.name:null;
    // Files panel (ORK-809): who sent the file, as a plain label.
    if(typeof file.from==='string'&&file.from){const from=document.createElement('span');from.className='message-file-from';from.textContent=file.from.slice(0,80);card.append(from);}
    const title=document.createElement('strong');title.textContent=named??'Attached file';card.append(title);
    const status=document.createElement('p');status.setAttribute('role','status');card.append(status);
    if(hint)status.textContent=`${humanSize(hint.plaintext_size)} \u00b7 ${hint.media_type}`;
    if(named)card.setAttribute('aria-label',`Attached file ${named}`);
    const body=document.createElement('div');card.append(body);root.append(card);
    const button=(label,run)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=run;card.insertBefore(b,body);return b;};
    let working=false,previewUrl=null,verified=null;
    let closeButton=null;
    const closePreview=()=>{body.replaceChildren();revoke(previewUrl);previewUrl=null;if(closeButton)closeButton.hidden=true;};
    async function task(fn){
      if(working||!live)return;working=true;card.setAttribute('aria-busy','true');const abort=new AbortController();controllers.add(abort);
      status.textContent='Verifying file…';
      try{await fn(abort.signal);}
      catch(error){if(live)status.textContent=error.name==='AbortError'?'File action cancelled.':error.message;}
      finally{working=false;card.setAttribute('aria-busy','false');controllers.delete(abort);}
    }
    const verify=async signal=>{
      const metadata=await load(signal);active();
      title.textContent=metadata.file.filename;status.textContent=`${metadata.file.plaintext_size.toLocaleString()} bytes · ${metadata.file.media_type}`;
      card.setAttribute('data-verified','true');verified=metadata;return metadata;
    };
    const unavailable=()=>{const p=document.createElement('p');p.textContent='Preview unavailable for this type or size. Use Download.';body.replaceChildren(p);};
    const preview=async(metadata,kind,signal)=>{
      closePreview();const parts=[];
      await download(metadata,{write:async bytes=>{active();parts.push(bytes);status.textContent=`Verifying ${parts.reduce((n,b)=>n+b.length,0).toLocaleString()} bytes…`;},close:async()=>{active();},abort:async()=>{parts.length=0;}},{signal});active();
      if(kind==='text'){
        const pre=document.createElement('pre');pre.textContent=await new Blob(parts).text();active();body.append(pre);
      }else{
        previewUrl=blobUrl(parts,metadata.file.media_type);
        const node=document.createElement('img');node.alt=metadata.file.filename;node.style.maxWidth='100%';
        node.src=previewUrl;body.append(node);
      }
      if(!closeButton)closeButton=button('Close preview',closePreview);closeButton.hidden=false;status.textContent='Verified preview. Previewing does not send the file.';
    };
    // Invoke the picker directly during the click gesture, before fetching.
    const save=suggested=>{
      if(working||!live)return;
      const handle=picker?picker({suggestedName:suggested}):null;
      handle?.catch?.(()=>{});
      void task(async signal=>{
        const metadata=verified??await verify(signal);
        if(metadata.file.filename!==suggested)throw Error('The file name changed since this card was shown. Download again.');
        if(handle){let sink,written=0;try{const selected=await handle;active();sink=await selected.createWritable();active();await download(metadata,{write:async bytes=>{active();await sink.write(bytes);active();written+=bytes.length;status.textContent=`Verified ${written.toLocaleString()} of ${metadata.file.plaintext_size.toLocaleString()} bytes…`;},close:async()=>{active();await sink.close();},abort:async error=>sink.abort(error)},{signal});}catch(error){await sink?.abort?.(error).catch(()=>{});throw error;}}
        else{
          if(metadata.file.plaintext_size>MEMORY_DOWNLOAD_LIMIT)throw Error('Large downloads require a browser supporting Save File Picker. No file was buffered.');
          const parts=[];await download(metadata,{write:async bytes=>{active();parts.push(bytes);status.textContent=`Verifying ${parts.reduce((n,b)=>n+b.length,0).toLocaleString()} bytes…`;},close:async()=>{active();},abort:async()=>{parts.length=0;}},{signal});active();
          const value=blobUrl(parts,downloadType(metadata.file.media_type)),a=document.createElement('a');a.href=value;a.download=metadata.file.filename;a.click();setTimeout(()=>revoke(value),1000);
        }
        active();status.textContent='File verified. Download offered.';
      });
    };
    if(hint){
      // Name, type and size are known: Preview (when the type may preview) and Download at once.
      if(previewKind(hint.media_type,hint.plaintext_size))button('Preview',()=>task(async signal=>{
        const metadata=verified??await verify(signal);
        const kind=previewKind(metadata.file.media_type,metadata.file.plaintext_size);
        if(!kind){unavailable();return;}
        await preview(metadata,kind,signal);
      }));
      button('Download',()=>save(verified?.file.filename??hint.filename));
      continue;
    }
    const details=button('View file details',()=>task(async signal=>{
      const metadata=await verify(signal);
      details.hidden=true;
      const kind=previewKind(metadata.file.media_type,metadata.file.plaintext_size);
      if(kind)button('Preview',()=>task(signal=>preview(metadata,kind,signal)));
      else unavailable();
      button('Download',()=>save(metadata.file.filename));
    }));
  }
  return {close(){live=false;legacy.close();for(const controller of controllers)controller.abort();controllers.clear();for(const value of urls)url.revokeObjectURL(value);urls.clear();root.replaceChildren();}};
}
