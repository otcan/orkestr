const config=await dioxus.recv();
let live=true,busy=false;const urls=new Set();
// Sealed files are decrypted here with this browser's identity (attachments/age.mjs).
const client=createAttachmentClient({...config,current:()=>live,open:async ciphertext=>ageDecodePayload(await ageOpenSealed(ciphertext))});
const report=async value=>{if(live)await dioxus.send(value);};
const save=(bytes,name,type)=>{
 if(!live)throw new Error('File selection changed');
 const url=URL.createObjectURL(new Blob([bytes],{type}));urls.add(url);
 const a=document.createElement('a');a.href=url;a.download=name;a.click();
 setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},1000);
};
async function run(action){
 if(busy)return;busy=true;
 try{
  let result={},notice='';
  if(action.kind==='list'){result.page=await client.list(action.after??null);notice='Files refreshed.';}
  else if(action.kind==='open'){result.manifest=await client.open(action.id);notice='Files in this saved copy.';}
  else if(action.kind==='upload'||action.kind==='import'){
   if(!client.pending()){
    const file=document.getElementById(action.input)?.files?.[0];if(!file)throw new Error('Choose a file first');
    if(action.kind==='upload')await client.upload(file);
    else {if(file.size>68*1024*1024)throw new Error('File archive exceeds limit');await client.prepareCopy(JSON.parse(await file.text()));}
   }
   const receipt=await client.commit();result.manifest=await client.open(receipt.manifest.manifest_id);result.page=await client.list();notice='File copy saved. It was not sent as a message.';
  }else if(action.kind==='retry'){
   const receipt=await client.commit();result.manifest=await client.open(receipt.manifest?.manifest_id??receipt.manifest_id);result.page=await client.list();notice='Original file request confirmed.';
  }else if(action.kind==='remove'){
   await client.remove(action.manifest,action.reference);result.manifest=await client.open(action.manifest.manifest_id);notice='File removed. Its saved reference remains.';
  }else if(action.kind==='download'){
   const verified=await client.download(action.manifest,action.reference);save(verified.bytes,verified.filename,verified.media_type);notice='File verified and download offered.';
  }else if(action.kind==='export'){
   const bundle=await client.exportCopy(action.manifest);save(JSON.stringify(bundle),'thread-files.json','application/json');notice='Copy archive offered. It contains available file bytes.';
  }else throw new Error('Unknown file action');
  await report({...result,notice,pending:!!client.pending(),kind:'result'});
 }catch(error){await report({kind:'result',notice:error.message,status:error.status??0,pending:!!client.pending()});}
 finally{busy=false;}
}
void run({kind:'list'});
try{while(live){const action=await dioxus.recv();if(action.stop)break;void run(action);}}
finally{live=false;client.close();for(const url of urls)URL.revokeObjectURL(url);urls.clear();}
