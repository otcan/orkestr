// File objects stay in JavaScript: the Dioxus bridge receives only verified
// receipts, never a gigabyte base64 string. Reselect an interrupted file to
// resume its session; no file bytes/private keys are retained in draft state.
import {encryptedUploadClient,validateUploadFile} from './encrypted_upload.mjs';
import {uploadPastedText} from './pasted_text.mjs';
import {browserStorage} from './browser_storage.mjs';

// Uploads in flight, by upload id. Cancel stops one of them; the other files
// of its batch and the draft's attachments are untouched.
const active=new Map();
// Ids the owner cancelled or removed. A retained paste receipt naming one is
// not reused for a later send.
const discarded=new Set();

export function cancelUpload(uploadId) {
  const controller=active.get(uploadId);
  controller?.abort();
  return Boolean(controller);
}

// Remove (attached, not yet sent): the server discards the encrypted upload.
export async function discardUpload({conversation,csrf},uploadId,{client}={}) {
  discarded.add(uploadId);
  try{await (client??encryptedUploadClient({conversation,csrf})).discard(uploadId);return true;}
  catch{return false;}
}

export function nativePaste(config, element, options) {
  return uploadPastedText(element, nativeDescribe(config, options), {
    scope: `${config.conversation}:${config.csrf}`,
    retainSuccess: options?.retainSuccess === true,
    reusable: result => !result.receipts?.some(receipt => discarded.has(receipt?.manifest_id)),
  });
}

export function nativeDescribe({conversation,csrf},{drafts=browserStorage('sessionStorage'),client=encryptedUploadClient({conversation,csrf}),progress=()=>{}}={}) {
  return async files=>{
    const list=[...files],receipts=[];
    if(list.length>8)return{error:'Attach at most 8 files at once.'};
    // Validate the complete batch before starting any transfer.
    try{for(const file of list)validateUploadFile(file,'00000000-0000-4000-8000-000000000001');}
    catch(e){return{error:e.message};}
    let total=list.reduce((sum,file)=>sum+file.size,0);
    let completed=0,index=0;
    for(const file of list){
      index++;
      let fileDone=0;
      const key=`orkestr.native-encrypted-upload.v1:${conversation}:${JSON.stringify([file.name,file.size,file.lastModified])}`;
      let id;try{id=drafts?.getItem(key);}catch{/* Draft persistence is optional. */}
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id||''))id=crypto.randomUUID();
      try{drafts?.setItem(key,id);}catch{/* Restricted storage still permits this transfer. */}
      const report=phase=>progress({phase,upload_id:id,file_name:file.name.split(/[\\/]/).pop(),file_index:index,file_count:list.length,completed_bytes:completed+fileDone,total_bytes:total});
      const controller=new AbortController(),signal=controller.signal;
      active.set(id,controller);
      try{
        report('preparing');
        const status=await client.upload(file,id,{requireIngest:true,signal,phase:report,
          progress:(done,size)=>{if(size!==file.size||!Number.isSafeInteger(done)||done<fileDone||done>size)throw Error('Invalid upload progress.');fileDone=done;report('uploading');}});
        report('preparing_attachment');
        const receipt=await client.attach(status,{signal});
        signal.throwIfAborted();
        receipts.push(receipt);
        fileDone=file.size;
        report(index===list.length?'ready':'file_ready');
        completed+=file.size;
        try{drafts?.removeItem(key);}catch{/* Receipt already verified. */}
      }catch(e){
        if(signal.aborted){
          // Cancelled: the transfer has stopped. Discard the partial upload
          // (expiry still removes it if this fails) and its resume id, then
          // continue with the rest of the batch.
          discarded.add(id);
          await client.discard(id).catch(()=>{});
          try{drafts?.removeItem(key);}catch{/* Nothing left to resume. */}
          total-=file.size;
          continue;
        }
        try{report('failed');}catch{/* The view may already be closed. */}return{receipts,error:e.message||'File upload interrupted. Reselect the same file to resume.'};
      }finally{active.delete(id);}
    }
    return{receipts};
  };
}

export {mountMessageFiles} from "./message_files.mjs";
// The local folder control rides in the same bundled asset (encrypted_upload.js).
export {mountLocalFiles} from "../local_files/panel.mjs";
