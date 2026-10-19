// Owner-scoped removable text only; no bearer or cross-origin paths.
const input = await dioxus.recv();
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
if (!new RegExp('^/api/v2/conversations/'+uuid+'/payloads/'+uuid+'$').test(input.path) || !['GET','DELETE'].includes(input.method) || (input.method==='DELETE' && !input.csrf)) throw new Error('Output unavailable');
const controller = new AbortController();let finished=false;
dioxus.recv().then(()=>{if(!finished)controller.abort();});
const timer=setTimeout(()=>controller.abort(),15000);
try {
 const response=await fetch(input.path,{method:input.method,credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:input.method==='DELETE'?{'x-orkestr-csrf':input.csrf}:{}});
 if(response.status!==200){await response.body?.cancel();return {status:response.status,body:null};}
 const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,text='';
 try{while(true){const {done,value}=await reader.read();if(done){text+=decoder.decode();break;}bytes+=value.byteLength;if(bytes>1048576)throw new Error('Output exceeds limit');text+=decoder.decode(value,{stream:true});}}
 finally{await reader.cancel().catch(()=>{});}
 return {status:200,body:JSON.parse(text)};
}finally{finished=true;clearTimeout(timer);controller.abort();}
