// File objects stay in JavaScript: the Dioxus bridge receives only verified
// receipts, never a gigabyte base64 string. Reselect an interrupted file to
// resume its session; no file bytes/private keys are retained in draft state.
import {encryptedUploadClient,validateUploadFile} from './encrypted_upload.mjs';
import {uploadPastedText} from './pasted_text.mjs';
import {browserStorage} from './browser_storage.mjs';

export function nativePaste(config, element, options) {
  return uploadPastedText(element, nativeDescribe(config, options), {
    scope: `${config.conversation}:${config.csrf}`,
  });
}

export function nativeDescribe({conversation,csrf},{drafts=browserStorage('sessionStorage'),client=encryptedUploadClient({conversation,csrf}),progress=()=>{}}={}) {
  return async files=>{
    const list=[...files],receipts=[];
    if(list.length>8)return{error:'Attach at most 8 files at once.'};
    // Validate the complete batch before starting any transfer.
    try{for(const file of list)validateUploadFile(file,'00000000-0000-4000-8000-000000000001');}
    catch(e){return{error:e.message};}
    const total=list.reduce((sum,file)=>sum+file.size,0);
    let completed=0,index=0;
    for(const file of list){
      index++;
      let fileDone=0;
      const report=phase=>progress({phase,file_name:file.name.split(/[\\/]/).pop(),file_index:index,file_count:list.length,completed_bytes:completed+fileDone,total_bytes:total});

      const key=`orkestr.native-encrypted-upload.v1:${conversation}:${JSON.stringify([file.name,file.size,file.lastModified])}`;
      let id;try{id=drafts?.getItem(key);}catch{/* Draft persistence is optional. */}
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id||''))id=crypto.randomUUID();
      try{drafts?.setItem(key,id);}catch{/* Restricted storage still permits this transfer. */}
      try{
        report('preparing');
        const status=await client.upload(file,id,{requireIngest:true,phase:report,
          progress:(done,size)=>{if(size!==file.size||!Number.isSafeInteger(done)||done<fileDone||done>size)throw Error('Invalid upload progress.');fileDone=done;report('uploading');}});
        report('preparing_attachment');
        receipts.push(await client.attach(status));
        fileDone=file.size;
        report(index===list.length?'ready':'file_ready');
        completed+=file.size;
        try{drafts?.removeItem(key);}catch{/* Receipt already verified. */}
      }catch(e){try{report('failed');}catch{/* The view may already be closed. */}return{receipts,error:e.message||'File upload interrupted. Reselect the same file to resume.'};}
    }
    return{receipts};
  };
}

export {mountMessageFiles} from "./message_files.mjs";
