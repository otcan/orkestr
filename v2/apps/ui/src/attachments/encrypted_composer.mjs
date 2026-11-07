// File objects stay in JavaScript: the Dioxus bridge receives only verified
// receipts, never a gigabyte base64 string. Reselect an interrupted file to
// resume its session; no file bytes/private keys are retained in draft state.
import {encryptedUploadClient,validateUploadFile} from './encrypted_upload.mjs';
import {uploadPastedText} from './pasted_text.mjs';

export function nativePaste(config, element, options) {
  return uploadPastedText(element, nativeDescribe(config, options), {
    scope: `${config.conversation}:${config.csrf}`,
  });
}

export function nativeDescribe({conversation,csrf},{drafts=globalThis.sessionStorage,client=encryptedUploadClient({conversation,csrf})}={}) {
  return async files=>{
    const list=[...files],receipts=[];
    if(list.length>8)return{error:'Attach at most 8 files at once.'};
    // Validate the complete batch before starting any transfer.
    try{for(const file of list)validateUploadFile(file,'00000000-0000-4000-8000-000000000001');}
    catch(e){return{error:e.message};}
    for(const file of list){
      const key=`orkestr.native-encrypted-upload.v1:${conversation}:${JSON.stringify([file.name,file.size,file.lastModified])}`;
      let id;try{id=drafts?.getItem(key);}catch{/* Draft persistence is optional. */}
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id||''))id=crypto.randomUUID();
      try{drafts?.setItem(key,id);}catch{/* Restricted storage still permits this transfer. */}
      try{
        const status=await client.upload(file,id,{requireIngest:true});
        receipts.push(await client.attach(status));
        try{drafts?.removeItem(key);}catch{/* Receipt already verified. */}
      }catch(e){return{receipts,error:e.message||'File upload interrupted. Reselect the same file to resume.'};}
    }
    return{receipts};
  };
}
