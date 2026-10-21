import fs from 'node:fs';
import path from 'node:path';
import {createScopedGroupTransport} from './whatsapp-scoped-group-transport.js';
import {createScopedPairingPermit} from './whatsapp-scoped-pairing.js';
import {scopedRouteMembership} from './whatsapp-scoped-route-membership.js';
import {createScopedDirectSender,validateScopedDirectChats} from './whatsapp-scoped-direct-chats.js';
import {SCOPED_SEND_MAX_TEXT_LENGTH, validReplyDocument} from './whatsapp-scoped-group-formatting.js';
const loaded=new Map();
const fail=()=>{throw Object.assign(new Error('scoped_worker_operation_denied'),{statusCode:403});};
// Inbound events are fire-and-forget, so a failing journal (for example a build
// that cannot write the live schema) used to drop every message silently.
// Report each distinct failure code at most once a minute, without content.
export function observeFailureCode(error) {
 return String(error?.message || error || 'unknown').replace(/\d{6,}/g,'#').slice(0,160);
}
export function createScopedNativeWorkerPolicy(config,{createTransport=createScopedGroupTransport,createDirectSender=createScopedDirectSender,report=entry=>console.error(JSON.stringify(entry)),now=Date.now}={}) {
 const threads=scopedRouteMembership(config),groups=config.groups || [];
 if(!config.workerAccountId || !threads || !groups.length || groups.length!==threads.size
     || new Set(groups.map(g=>g.chatId)).size!==groups.length
     || groups.some(g=>!threads.has(g.threadId) || !/^\d+(?:-\d+)?@g\.us$/.test(g.chatId)))throw new Error('scoped_worker_configuration_invalid');
 const chats=new Set(groups.map(g=>g.chatId));
 // Owner-approved 1:1 chats (optional). Validated up front so a bad config fails at startup.
 const direct=validateScopedDirectChats(config,threads);
 let transport,directSender,started=false;
 const reported=new Map(),failures={total:0,last:null};
 const pairing=createScopedPairingPermit(config);
 const get=accountId=>{
  if(accountId!==config.workerAccountId)fail();
  return transport ||= createTransport({config,token:'native-private-socket-policy',base:{}});
 };
 return {
  accountId:config.workerAccountId,
  pairingAllowed:()=>pairing.allowsAuthentication(),
  claimStart({accountId,existing,options={},previous={},profile}) {
   if(accountId!==config.workerAccountId || options.resetRuntime || options.reset || options.force || (options.phoneNumber && !config.pairingAttempt) || previous.verifiedLogoutAt || previous.state==='auth_failure')throw new Error('scoped_worker_operator_recovery_required');
   if(options.phoneNumber)pairing.claim(options.phoneNumber);
   if(existing)return;
   if(started)throw new Error('scoped_worker_operator_recovery_required');
   const st=fs.lstatSync(profile);if(!st.isDirectory() || st.isSymbolicLink())throw new Error('scoped_worker_existing_session_required');
   started=true;
  },
  checkRequest(method,url,body) {
   if(pairing.requestAllowed(method,url,body))return;
   body ||= {};
   if(method==='GET' && ['/health','/accounts'].includes(url.pathname))return;
   const a=encodeURIComponent(config.workerAccountId);
   const ownsDirect=(chatId,threadId)=>Boolean(direct?.chats.has(chatId)) && direct.chats.get(chatId)===threadId;
   // Owner-authorized read-all threads: paged list of every chat/contact and paged
   // history of any chat; read-only, never marks seen, only fixed parameters.
   const readAllThread=Boolean(direct?.readAll.has(url.searchParams.get('thread_id')));
   const onlyParams=keys=>[...url.searchParams.keys()].every(k=>keys.includes(k));
   if(method==='GET' && readAllThread && url.pathname===`/accounts/${a}/chats/page` && onlyParams(['thread_id','source','cursor','limit']))return;
   if(method==='GET' && readAllThread && url.pathname.startsWith(`/accounts/${a}/chats/`) && url.pathname.endsWith('/history')
      && url.pathname.split('/').length===6 && url.searchParams.get('page')==='1'
      && (!url.searchParams.has('mark_seen') || url.searchParams.get('mark_seen')==='false')
      && onlyParams(['thread_id','page','before','limit','mark_seen']))return;
   if(method==='GET' && [...(direct?.chats.keys()||[])].some(g=>url.pathname===`/accounts/${a}/chats/${encodeURIComponent(g)}/history` && ownsDirect(g,url.searchParams.get('thread_id')))
      && (!url.searchParams.has('mark_seen') || url.searchParams.get('mark_seen')==='false')
      && Number(url.searchParams.get('limit')||30)>0 && Number(url.searchParams.get('limit')||30)<=50)return;
   if(method==='GET' && [...chats].some(g=>url.pathname===`/accounts/${a}/chats/${encodeURIComponent(g)}/history`) && (!url.searchParams.has('mark_seen') || url.searchParams.get('mark_seen')==='false')
      && Number(url.searchParams.get('limit')||30)>0 && Number(url.searchParams.get('limit')||30)<=50)return;
   if(method==='POST' && url.pathname==='/send-text' && body.accountId===config.workerAccountId && chats.has(body.to)
      && typeof body.text==='string' && body.text.length<=SCOPED_SEND_MAX_TEXT_LENGTH && typeof body.requestId==='string' && typeof body.parentId==='string'
      && Object.keys(body).every(k=>['accountId','to','text','requestId','parentId','notificationId'].includes(k)))return;
   if(method==='POST' && url.pathname==='/send-text' && ownsDirect(body.to,body.threadId) && body.accountId===config.workerAccountId
      && typeof body.text==='string' && body.text.length<=3000 && typeof body.requestId==='string'
      && Object.keys(body).every(k=>['accountId','to','text','requestId','threadId'].includes(k)))return;
   // The full text of a long reply, as one Markdown document to the same group.
   if(method==='POST' && url.pathname==='/send-document' && body.accountId===config.workerAccountId && chats.has(body.to)
      && validReplyDocument({filename:body.filename,mimetype:body.mimetype,text:body.text}) && typeof body.requestId==='string' && typeof body.parentId==='string'
      && Object.keys(body).every(k=>['accountId','to','filename','mimetype','text','requestId','parentId','notificationId'].includes(k)))return;
   fail();
  },
  observe(accountId,client,message){
   if(accountId!==config.workerAccountId)fail();
   const failed=error=>{
    const code=observeFailureCode(error);failures.total++;failures.last={code,at:new Date(now()).toISOString()};
    if(!reported.has(code) || now()-reported.get(code)>=60000){reported.set(code,now());
     report({event:'scoped_group_observe_failed',accountId,chatId:message?.fromMe===true?message?.to:message?.from,code,failures:failures.total});}
    return false;
   };
   try {return Promise.resolve(get(accountId).observe(client,message)).catch(failed);} catch(error) {return Promise.resolve(failed(error));}
  },
  observeFailures:()=>({...failures}),
  send(accountId,client,chatId,text,request){
   if(direct?.chats.has(chatId)) {
    if(accountId!==config.workerAccountId || direct.chats.get(chatId)!==request?.threadId)fail();
    directSender ||= createDirectSender({config,direct,now});
    return directSender.sendText(client,chatId,text,request);
   }
   return get(accountId).sendText(client,chatId,text,'main',request);
  },
  directChatCount:()=>direct?.chats.size||0,
  sendDocument(accountId,client,chatId,document,request,createMedia){return get(accountId).sendDocument(client,chatId,document,'main',request,createMedia);},
  close(){transport?.close();directSender?.close();},
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

export function createPreservingNativeAuth(LocalAuth,{allowPairing=()=>false}={}) {
 return class extends LocalAuth {
  async beforeBrowserInitialized(){
   if(!this.clientId || typeof this.dataPath!=='string')throw new Error('scoped_worker_existing_session_required');
   const st=fs.lstatSync(path.join(this.dataPath,`session-${this.clientId}`));
   if(!st.isDirectory() || st.isSymbolicLink())throw new Error('scoped_worker_existing_session_required');
   return super.beforeBrowserInitialized();
  }
  async onAuthenticationNeeded(){return {failed:!allowPairing(),restart:false,failureEventPayload:'scoped_worker_existing_authentication_required'};}
  async logout(){throw new Error('scoped_worker_logout_blocked_preserve_session');}
 };
}
