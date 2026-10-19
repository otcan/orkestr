// Only canonical owner task operations; browser supplies Origin and session cookie.
const input = await dioxus.recv();
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const base = `/api/v2/conversations/${uuid}/worker-tasks`;
const create = input.method === 'POST' && new RegExp(`^${base}$`).test(input.path);
const hold = input.method === 'POST' && new RegExp(`^${base}/${uuid}/hold$`).test(input.path);
const remove = input.method === 'DELETE' && new RegExp(`^${base}/${uuid}/payload$`).test(input.path);
if ((!create && !hold && !remove) || !input.csrf) throw new Error('Worker task operation unavailable');
if (hold && JSON.stringify(input.body) !== '{}') throw new Error('Invalid hold request');
const controller = new AbortController(); let finished = false;
dioxus.recv().then(() => { if (!finished) controller.abort(); });
const timer = setTimeout(() => controller.abort(), 15000);
try {
 const headers = {'x-orkestr-csrf': input.csrf};
 if (!remove) headers['Content-Type'] = 'application/json';
 const response = await fetch(input.path, {method:input.method, credentials:'same-origin', cache:'no-store', signal:controller.signal, headers, ...(!remove ? {body:JSON.stringify(input.body)} : {})});
 if (!create || response.status !== 200) { await response.body?.cancel(); return {status:response.status,body:null}; }
 const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes=0,text='';
 try { while(true) { const {done,value}=await reader.read(); if(done) {text+=decoder.decode();break;} bytes+=value.byteLength;if(bytes>65536)throw new Error('Task response exceeds limit');text+=decoder.decode(value,{stream:true}); } }
 finally { await reader.cancel().catch(()=>{}); }
 return {status:200,body:JSON.parse(text)};
} finally { finished=true;clearTimeout(timer);controller.abort(); }
