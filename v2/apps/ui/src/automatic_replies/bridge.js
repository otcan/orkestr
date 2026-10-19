const config=await dioxus.recv();let live=true,busy=false,page=null;
const client=createPermissionClient({...config,current:()=>live});
async function run(action){
 if(busy||!live)return;busy=true;
 try{
  let notice='Permissions refreshed.';
  if(action.kind==='read')page=await client.read(action.after??null);
  else if(action.kind==='decide'){
   await client.decide(action.route,action.enabled,crypto.randomUUID());
   // A receipt is historical. Only this fresh read supplies current policy.
   page=null;page=await client.read();notice='Permission saved. Current permissions refreshed.';
  }else throw new Error('Unknown permission action');
  if(live)await dioxus.send({page,notice,pending:!!client.pending()});
 }catch(error){if(live)await dioxus.send({page:null,notice:error.message,status:error.status??0,pending:!!client.pending()});}
 finally{busy=false;}
}
void run({kind:'read'});
try{while(live){const action=await dioxus.recv();if(action.stop)break;void run(action);}}
finally{live=false;client.close();}
