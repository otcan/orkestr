export async function intelligenceRequest({conversation,signal},fetcher=fetch) {
 if(conversation==='00000000-0000-0000-0000-000000000000'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(conversation))throw Error('Invalid conversation');
 const c=new AbortController(),abort=()=>c.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(abort,10000);let reader;
 try{
  const response=await fetcher(`/api/v2/conversations/${conversation}/intelligence`,{method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store',signal:c.signal});
  if(response.status!==200){await response.body?.cancel();return {status:response.status,text:''};}
  if(!response.body)throw Error('Missing capabilities');
  reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
  for(let reads=0;reads<256;reads++){const {done,value}=await reader.read();if(done)return {status:200,text:text+decoder.decode()};bytes+=value.byteLength;if(bytes>8192)throw Error('Capabilities too large');text+=decoder.decode(value,{stream:true});}
  throw Error('Capabilities read limit');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);c.abort();await reader?.cancel().catch(()=>{});}
}
