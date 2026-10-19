// Exact JSON integers stay in text; never parse/stringify a CAS-bearing body here.
export async function memoryRequest(input, fetcher = fetch) {
 const paths = {settings: '/api/v2/memory/settings', proposals: '/api/v2/memory/proposals', decisions: '/api/v2/memory/decisions', query: '/api/v2/memory/query', export: '/api/v2/memory/export'};
 const methods = {settings: ['GET','PUT'], proposals: ['POST'], decisions: ['POST'], query: ['POST'], export: ['GET']};
 if (!Object.hasOwn(paths,input.route) || !methods[input.route].includes(input.method)) throw Error('Invalid Memory operation');
 const enc = new TextEncoder();
 if (input.body !== null && (typeof input.body !== 'string' || enc.encode(input.body).length > 65536)) throw Error('Invalid Memory body');
 if (input.method === 'GET' && input.body !== null) throw Error('Unexpected Memory body');
 if (input.method !== 'GET' && (!input.csrf || input.body === null)) throw Error('Memory confirmation required');
 const controller = new AbortController();
 const cancel = () => controller.abort(); input.signal?.addEventListener('abort',cancel,{once:true});
 if (input.signal?.aborted) controller.abort();
 const timer = setTimeout(cancel,15000);
 try {
  const response = await fetcher(paths[input.route],{method:input.method,credentials:'same-origin',redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json',...(input.method !== 'GET'?{'x-orkestr-csrf':input.csrf}:{})},body:input.body===null?undefined:input.body,signal:controller.signal});
  if(response.status===204)return {status:204,text:''};
  const limit=input.route==='query'?4194304:input.route==='export'?8388608:65536;
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,reads=0,text='';
  try {for(;;){if(++reads>16384)throw Error('Memory read budget exceeded');const {done,value}=await reader.read();if(done){text+=decoder.decode();break;}size+=value.byteLength;if(size>limit)throw Error('Memory response too large');text+=decoder.decode(value,{stream:true});}}
  finally{await reader.cancel().catch(()=>{});}
  return {status:response.status,text};
 } finally {clearTimeout(timer);input.signal?.removeEventListener('abort',cancel);}
}
