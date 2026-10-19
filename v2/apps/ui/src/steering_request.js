// Reviewed Steering route only. The caller fences owner/selection before applying receipts.
const input = await dioxus.recv();
if (!['GET','POST'].includes(input.method) || !/^\/api\/v2\/conversations\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:\/steer|\/steering\/[A-Za-z0-9_.:-]{1,128})$/.test(input.path) || !input.csrf) throw new Error('Steering unavailable');
if ((input.method==='POST') !== input.path.endsWith('/steer')) throw new Error('Steering unavailable');
const controller = new AbortController();
let finished = false;
dioxus.recv().then(() => { if (!finished) controller.abort(); });
const timer = setTimeout(() => controller.abort(), 15000);
try {
 const response = await fetch(input.path, {method:input.method, credentials:'same-origin', cache:'no-store', signal:controller.signal,
  headers:{'Content-Type':'application/json','x-orkestr-csrf':input.csrf}, body:input.method==='POST'?JSON.stringify(input.body):undefined});
 if (response.status !== 200) { await response.body?.cancel(); return {status:response.status,body:null}; }
 const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes=0,text='';
 try { while(true) { const {done,value}=await reader.read(); if(done) {text+=decoder.decode();break;} bytes+=value.byteLength;if(bytes>65536)throw new Error('Steering response exceeds limit');text+=decoder.decode(value,{stream:true}); } }
 finally { await reader.cancel().catch(()=>{}); }
 return {status:200,body:JSON.parse(text)};
} finally { finished=true;clearTimeout(timer);controller.abort(); }
