import fs from 'node:fs';
import path from 'node:path';
import {createScopedGroupTransport} from './whatsapp-scoped-group-transport.js';
const loaded=new Map();
const fail=()=>{throw Object.assign(new Error('scoped_worker_operation_denied'),{statusCode:403});};
export function createScopedNativeWorkerPolicy(config,{createTransport=createScopedGroupTransport}={}) {
 if(!config.workerAccountId || config.groups?.length!==1 || config.groups[0].threadId!==config.routeControl?.threadId)throw new Error('scoped_worker_configuration_invalid');
 let transport,started=false;
 const get=accountId=>{
  if(accountId!==config.workerAccountId)fail();
  return transport ||= createTransport({config,token:'native-private-socket-policy',base:{}});
 };
 return {
  accountId:config.workerAccountId,
  claimStart({accountId,existing,options={},previous={},profile}) {
   if(accountId!==config.workerAccountId || options.resetRuntime || options.reset || options.force || options.phoneNumber || previous.verifiedLogoutAt || previous.state==='auth_failure')throw new Error('scoped_worker_operator_recovery_required');
   if(existing)return;
   if(started)throw new Error('scoped_worker_operator_recovery_required');
   const st=fs.lstatSync(profile);if(!st.isDirectory() || st.isSymbolicLink())throw new Error('scoped_worker_existing_session_required');
   started=true;
  },
  checkRequest(method,url,body={}) {
   if(method==='GET' && ['/health','/accounts','/diagnostics/health'].includes(url.pathname))return;
   const a=encodeURIComponent(config.workerAccountId),g=encodeURIComponent(config.groups[0].chatId);
   if(method==='GET' && url.pathname===`/accounts/${a}/chats/${g}/history` && (!url.searchParams.has('mark_seen') || url.searchParams.get('mark_seen')==='false')
      && Number(url.searchParams.get('limit')||30)>0 && Number(url.searchParams.get('limit')||30)<=50)return;
   if(method==='POST' && url.pathname==='/send-text' && body.accountId===config.workerAccountId && body.to===config.groups[0].chatId
      && typeof body.text==='string' && body.text.length<=3000 && typeof body.requestId==='string' && typeof body.parentId==='string'
      && Object.keys(body).every(k=>['accountId','to','text','requestId','parentId','notificationId'].includes(k)))return;
   fail();
  },
  observe(accountId,client,message){return get(accountId).observe(client,message);},
  send(accountId,client,chatId,text,request){return get(accountId).sendText(client,chatId,text,'main',request);},
  close(){transport?.close();},
 };
}
export function scopedNativeWorker(env=process.env) {
 const file=env.ORKESTR_WA_SCOPED_GROUP_CONFIG;if(!file)return null;
 if(loaded.has(file))return loaded.get(file);
 let p=path.resolve(file);
 for(;;){const st=fs.lstatSync(p);if(st.isSymbolicLink() || st.uid!==0 || (st.mode&0o022))throw new Error('scoped_worker_config_unprotected');const parent=path.dirname(p);if(parent===p)break;p=parent;}
 const config=JSON.parse(fs.readFileSync(file,'utf8'));
 const selected=String(env.ORKESTR_WHATSAPP_ACCOUNT_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
 if(selected.length!==1 || selected[0]!==config.workerAccountId)throw new Error('scoped_worker_account_isolation_required');
 const policy=createScopedNativeWorkerPolicy(config);loaded.set(file,policy);return policy;
}

export function createPreservingNativeAuth(LocalAuth) {
 return class extends LocalAuth {
  async beforeBrowserInitialized(){
   if(!this.clientId || typeof this.dataPath!=='string')throw new Error('scoped_worker_existing_session_required');
   const st=fs.lstatSync(path.join(this.dataPath,`session-${this.clientId}`));
   if(!st.isDirectory() || st.isSymbolicLink())throw new Error('scoped_worker_existing_session_required');
   return super.beforeBrowserInitialized();
  }
  async onAuthenticationNeeded(){return {failed:true,restart:false,failureEventPayload:'scoped_worker_existing_authentication_required'};}
  async logout(){throw new Error('scoped_worker_logout_blocked_preserve_session');}
 };
}
