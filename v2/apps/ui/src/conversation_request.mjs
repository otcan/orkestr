// Raw JSON preserves directory cursors exactly until Rust decodes them.
export async function conversationRequest(input, fetcher = fetch) {
 const isCreate = input.method === 'POST';
 if (!['GET','POST'].includes(input.method)) throw Error('Invalid conversation operation');
 if (!isCreate && (typeof input.after !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(input.after) || BigInt(input.after) > 9223372036854775807n || input.body !== null)) throw Error('Invalid conversation cursor');
 if (isCreate && (!input.csrf || typeof input.body !== 'string' || !input.body.length || new TextEncoder().encode(input.body).length > 2048)) throw Error('Invalid conversation request');
 const path = isCreate ? '/api/v2/conversations' : `/api/v2/conversations?after=${input.after}&limit=50`;
 const controller = new AbortController(), cancel = () => controller.abort();
 input.signal?.addEventListener('abort',cancel,{once:true});
 if(input.signal?.aborted) cancel();
 const timer=setTimeout(cancel,15000);
 try {
  const response=await fetcher(path,{method:input.method,credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal,
   headers:isCreate?{'Content-Type':'application/json','x-orkestr-csrf':input.csrf}:{},body:isCreate?input.body:undefined});
  if(![200,201].includes(response.status)){await response.body?.cancel();return {status:response.status,text:''};}
  if(!response.body)throw Error('Missing conversation response');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0,reads=0;
  try {for(;;){if(++reads>1024)throw Error('Conversation read budget exceeded');const {done,value}=await reader.read();if(done){text+=decoder.decode();break;}bytes+=value.byteLength;if(bytes>65536)throw Error('Conversation response too large');text+=decoder.decode(value,{stream:true});}}
  finally{await reader.cancel().catch(()=>{});}
  return {status:response.status,text};
 } finally {clearTimeout(timer);input.signal?.removeEventListener('abort',cancel);}
}
