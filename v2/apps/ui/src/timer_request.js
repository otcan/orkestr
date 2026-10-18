// Exact timer owner HTTP operations at 1a92f545; no clock or claim inputs.
const input = await dioxus.recv();
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const allowed = input.method === 'POST' && new RegExp(`^/api/v2/timers/${uuid}/(?:enable|control)$`).test(input.path);
if (!allowed || !input.csrf) throw new Error('Timer operation unavailable');
const fields = Object.keys(input.body ?? {}).sort().join(',');
const enable = input.path.endsWith('/enable');
if (fields !== (enable ? 'conversation_id,expected_revision,request_key,text' : 'action,expected_revision,request_key')) throw new Error('Invalid timer fields');
if (!Number.isSafeInteger(input.body.expected_revision) || input.body.expected_revision < 1 || typeof input.body.request_key !== 'string' || !input.body.request_key) throw new Error('Invalid timer precondition');
if (!enable && !['disable','stop','rollback'].includes(input.body.action)) throw new Error('Invalid timer control');
const controller = new AbortController(); let finished = false;
dioxus.recv().then(() => { if (!finished) controller.abort(); });
const timer = setTimeout(() => controller.abort(), 15000);
try {
 const headers = {'x-orkestr-csrf': input.csrf};
 headers['Content-Type'] = 'application/json';
 const response = await fetch(input.path, {method:input.method, credentials:'same-origin', cache:'no-store', signal:controller.signal, headers, body:JSON.stringify(input.body)});
 if (response.status !== 200) { await response.body?.cancel(); return {status:response.status,body:null}; }
 const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes=0,text='';
 try { while(true) { const {done,value}=await reader.read(); if(done) {text+=decoder.decode();break;} bytes+=value.byteLength;if(bytes>65536)throw new Error('Timer response exceeds limit');text+=decoder.decode(value,{stream:true}); } }
 finally { await reader.cancel().catch(()=>{}); }
 return {status:200,body:JSON.parse(text)};
} finally { finished=true;clearTimeout(timer);controller.abort(); }
