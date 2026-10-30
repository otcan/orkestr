// Keep generations and immutable request integers in raw JSON, parsed only by Rust.
export async function betaRequest(input, fetcher = fetch) {
 const uuid = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
 if (!['beta','window','window_queue'].includes(input.route) || !['GET','POST'].includes(input.method) || (input.route !== 'window' && input.method !== 'GET')) throw Error('Invalid beta operation');
 if ((input.route !== 'beta' || input.conversation != null) && !uuid.test(input.conversation)) throw Error('Invalid conversation');
 const path = input.route === 'beta' ? `/api/v2/beta${input.conversation == null ? '' : `?conversation_id=${input.conversation}`}` : `/api/v2/conversations/${input.conversation}/window${input.route === 'window_queue' ? '/queue' : ''}`;
 if (input.method === 'GET' && input.body !== null) throw Error('Unexpected request body');
 if (input.method === 'POST' && (!input.csrf || typeof input.body !== 'string' || !input.body.length || new TextEncoder().encode(input.body).length > 8192)) throw Error('Window confirmation required');
 const controller = new AbortController(), cancel = () => controller.abort();
 input.signal?.addEventListener('abort',cancel,{once:true});
 if (input.signal?.aborted) cancel();
 const timer = setTimeout(cancel,15000);
 try {
  const response = await fetcher(path,{method:input.method,credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal,
   headers:input.method === 'POST' ? {'Content-Type':'application/json','x-orkestr-csrf':input.csrf} : {},body:input.method === 'POST' ? input.body : undefined});
  // A restricted thread refuses windows by design; only that fixed code is surfaced.
  if (response.status === 409 && input.route === 'window' && input.method === 'POST') { let code='';try{const t=await response.text();if(t.length<=4096&&JSON.parse(t)?.code==='restricted_conversation')code='restricted_conversation';}catch{}return code?{status:409,text:'',code}:{status:409,text:''}; }
  // An install without connected models answers discovery with this fixed code; the first screen explains the next step.
  if (response.status === 404 && input.route === 'beta') { let code='';try{const t=await response.text();if(t.length<=4096&&JSON.parse(t)?.code==='beta_unconfigured')code='beta_unconfigured';}catch{}return code?{status:404,text:'',code}:{status:404,text:''}; }
  if (![200,201,202].includes(response.status)) { await response.body?.cancel();return {status:response.status,text:''}; }
  if (!response.body) throw Error('Missing beta response');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,reads=0,text='';
  try {for (;;) {if (++reads>1024) throw Error('Beta read budget exceeded');const {done,value}=await reader.read();if(done){text+=decoder.decode();break;}bytes+=value.byteLength;if(bytes>65536)throw Error('Beta response too large');text+=decoder.decode(value,{stream:true});}}
  finally {await reader.cancel().catch(()=>{});}
  return {status:response.status,text};
 } finally {clearTimeout(timer);input.signal?.removeEventListener('abort',cancel);}
}
