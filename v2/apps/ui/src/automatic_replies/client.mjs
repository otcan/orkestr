import {PermissionState} from './state.mjs';
// Exact Core 32055a685 owner HTTP leaf. Registration is a server gate.
export function createPermissionClient({conversation,csrf,current=()=>true,fetchImpl=globalThis.fetch}) {
 const state=new PermissionState();state.select(conversation);
 const controllers=new Set();let closed=false,busy=false;
 const base='/api/v2/conversations/'+conversation+'/automatic-reply-permissions';
 async function request(ticket,method,body,after=null) {
  if(closed||!current()||!state.current(ticket))throw new Error('Permission selection changed');
  const controller=new AbortController();controllers.add(controller);
  const timer=setTimeout(()=>controller.abort(),15000);
  try {
   const headers={Accept:'application/json'};
   if(method==='POST'){headers['Content-Type']='application/json';headers['x-orkestr-csrf']=csrf;}
   const url=base+(method==='GET'?'?limit=16'+(after?'&after_id='+encodeURIComponent(after):''):'');
   const response=await fetchImpl(url,{method,headers,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,...(body?{body:JSON.stringify(body)}:{})});
   if(!response.ok){const error=new Error(response.status===401?'Sign in again to view permissions.':response.status===409?'Permission changed. Refresh before deciding again.':response.status===404?'This automatic-reply route is unavailable.':'Automatic-reply permission unavailable.');error.status=response.status;throw error;}
   if(!response.body)throw new Error('Missing permission response');
   const reader=response.body.getReader(),buffer=new Uint8Array(65536);let length=0,done=false;
   try {
    for(let reads=0;reads<256;reads++){
     const chunk=await reader.read();if(chunk.done){done=true;break;}
     if(!(chunk.value instanceof Uint8Array)||length+chunk.value.length>buffer.length)throw new Error('Permission response exceeds limit');
     buffer.set(chunk.value,length);length+=chunk.value.length;
    }
    if(!done)throw new Error('Permission response read limit');
   }finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
   if(closed||!current()||!state.current(ticket))throw new Error('Permission selection changed');
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));
  }finally{clearTimeout(timer);controllers.delete(controller);}
 }
 return {
  async read(after=null){const ticket=state.request(after);const page=await request(ticket,'GET',null,after);return state.apply(ticket,page)?page:null;},
  async decide(route,enabled,key){
   if(busy)throw new Error('A permission request is already pending');
   const body=state.prepare(route,enabled,key),ticket=state.request();busy=true;
   try {
    const receipt=await request(ticket,'POST',body);
    const expected={conversation_id:conversation,route_id:body.route_id,route_generation:body.expected_route_generation,permission_revision:body.expected_permission_revision+1,enabled:body.enabled,request_key:body.request_key};
    if(Object.keys(receipt).sort().join()!==Object.keys(expected).sort().join()||Object.entries(expected).some(([k,v])=>receipt[k]!==v))throw new Error('Invalid permission receipt');
    state.finish(ticket,true);return receipt;
   }catch(error){if([400,401,403,404,409].includes(error.status))state.finish(ticket,true);throw error;}
   finally{busy=false;}
  },
  pending:()=>state.pending(),
  close(){closed=true;state.select(undefined);for(const controller of controllers)controller.abort();controllers.clear();}
 };
}
