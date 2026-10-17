import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createDeliveryRouteFence} from './whatsapp-delivery-route-fence.js';
import {notificationScope, createTimerNotificationProofStore} from './whatsapp-timer-notification-proof.js';

const fail=code=>{throw new Error(`group_transport_${code}`);};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// An explicitly configured, existing-account transport. The surrounding bridge
// keeps its legacy router disabled; only fresh owner-authored group input enters.
export function createScopedGroupTransport({config,token,base,dbPath=config.journalPath,now=Date.now,routeFence: suppliedFence,proofStore: suppliedProof}) {
  if(!/^\d+@c\.us$/.test(config.ownChatId || '') || !Number.isFinite(Date.parse(config.activatedAt))
      || !Array.isArray(config.groups) || !config.groups.length || !token)fail('configuration_invalid');
  const groups=new Map(config.groups.map(g=>[g.chatId,g]));
  if(groups.size!==config.groups.length || [...groups].some(([id,g])=>!/^\d+(?:-\d+)?@g\.us$/.test(id) || !g.threadId))fail('configuration_invalid');
  const db=new DatabaseSync(dbPath);db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS group_input(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_send(id TEXT PRIMARY KEY,hash TEXT NOT NULL,chat_id TEXT NOT NULL,parent_id TEXT NOT NULL,state TEXT NOT NULL,provider_id TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const contract=hash([config.ownChatId,config.activatedAt,config.groups]);
  const prior=db.prepare('SELECT value FROM group_meta WHERE key=?').get('contract');
  if(prior && prior.value!==contract)fail('configuration_changed');
  db.prepare('INSERT OR IGNORE INTO group_meta VALUES(?,?)').run('contract',contract);
  db.prepare("UPDATE group_send SET state='uncertain' WHERE state='sending'").run();
  const scope=notificationScope(config);
  const routeFence=config.routeControl ? suppliedFence || createDeliveryRouteFence({dbPath:config.routeControl.dbPath,now}) : null;
  if(config.routeControl && !groups.has(config.groups.find(g=>g.threadId===config.routeControl.threadId)?.chatId))fail('route_thread_invalid');
  const fenced=to=>routeFence && groups.get(to)?.threadId===config.routeControl.threadId;
  if(routeFence)routeFence.recover(config.routeControl.routeId);
  const proofStore=scope ? suppliedProof || createTimerNotificationProofStore({path:scope.proofDbPath,readOnly:true,now}) : null;
  let tail=Promise.resolve();
  const serial=work=>{const next=tail.catch(()=>{}).then(work);tail=next;return next;};
  const uncertain=()=>Boolean(db.prepare("SELECT 1 FROM group_send WHERE state='uncertain' LIMIT 1").get());
  const assertClient=client=>{if(client?.info?.wid?._serialized!==config.ownChatId)fail('account_mismatch');};
  return {
    ...base,enabled:true,groupsMode:true,close:()=>{db.close();if(!suppliedFence)routeFence?.close();if(!suppliedProof)proofStore?.close();},blocked:uncertain,
    assertClient,
    middleware(req,res,next) {
      const matchToken=String(req.get('authorization')||'').match(/^Bearer (.+)$/i);
      const supplied=Buffer.from(matchToken?.[1] || ''),expected=Buffer.from(token);
      if(!matchToken || supplied.length!==expected.length || !crypto.timingSafeEqual(supplied,expected))return res.status(401).json({ok:false,error:'group_transport_unauthorized'});
      let allowed=req.method==='GET' && ['/health','/api/accounts'].includes(req.path);
      const match=req.path.match(/^\/api\/chats\/([^/]+)\/(history|meta)$/);
      if(req.method==='GET' && match) {
        try {allowed=groups.has(decodeURIComponent(match[1])) && (req.query.mark_seen===undefined || req.query.mark_seen==='false')
          && (match[2]==='meta' || /^(?:[1-9]|[1-4]\d|50)$/.test(String(req.query.limit ?? 20)));}catch{allowed=false;}
      }
      if(req.method==='POST' && req.path==='/send-text') {
        const b=req.body || {};
        allowed=groups.has(b.to) && b.accountId==='main' && typeof b.text==='string' && b.text.trim() && b.text.length<=3000
          && typeof b.requestId==='string' && typeof b.parentId==='string'
          && Object.keys(b).every(k=>['to','text','accountId','requestId','parentId','notificationId'].includes(k))
          && (b.notificationId===undefined || (scope?.chatId===b.to && b.notificationId===b.requestId));
      }
      return allowed?next():res.status(403).json({ok:false,error:'group_transport_scope_denied'});
    },
    historyClient(client,chatId) {assertClient(client);if(!groups.has(chatId))fail('group_denied');return client;},
    async reconcile(client) {
      assertClient(client);
      let recorded=0,failed=0;
      for(const chatId of groups.keys()) {
        try {
          const chat=await client.getChatById(chatId);
          const messages=await chat.fetchMessages({limit:30});
          for(const message of messages) if(await this.observe(client,message))recorded++;
        } catch {failed++;}
      }
      return {recorded,failed};
    },
    observe(client,message) {
      return serial(async()=>{
        assertClient(client);
        const id=message?.id?._serialized,chatId=message?.to;
        const ts=Number(message?.timestamp)*1000;
        if(message?.fromMe!==true || !groups.has(chatId) || typeof id!=='string' || !id || id.startsWith('summary:')
            || typeof message.body!=='string' || !message.body.trim() || message.body.length>32000
            || !Number.isFinite(ts) || ts<=Date.parse(config.activatedAt) || ts>now()+5000)return false;
        if(fenced(chatId)) {
          let active;try {active=routeFence.assertActive(config.routeControl.routeId);}catch{return false;}
          if(ts<Date.parse(active.since))return false;
        }
        if(uncertain())fail('delivery_uncertain');
        if(db.prepare('SELECT 1 FROM group_send WHERE provider_id=?').get(id))return false;
        const result=db.prepare('INSERT OR IGNORE INTO group_input VALUES(?,?,?,?)').run(id,chatId,message.body,new Date(ts).toISOString());
        return Boolean(result.changes);
      });
    },
    sendText(client,to,text,accountId,request={}) {
      return serial(async()=>{
        assertClient(client);
        if(!groups.has(to) || accountId!=='main' || typeof text!=='string' || !text.trim() || text.length>3000
            || !/^[a-zA-Z0-9:._-]{1,200}$/.test(request.requestId || ''))fail('scope_denied');
        let parent;
        if(request.notificationId!==undefined) {
          if(!scope || request.notificationId!==request.requestId)fail('notification_denied');
          parent=proofStore.authorize({scope,id:request.notificationId,to,text,parentId:request.parentId});
        } else {
          parent=db.prepare('SELECT * FROM group_input WHERE id=? AND chat_id=?').get(request.parentId,to);
          if(!parent)fail('reply_parent_required');
        }
        const material=hash([to,text,request.parentId]);
        const previous=db.prepare('SELECT * FROM group_send WHERE id=?').get(request.requestId);
        if(previous) {
          if(previous.hash!==material)fail('request_conflict');
          if(previous.state==='sent')return {ok:true,ids:[previous.provider_id],duplicate:true};
          fail('delivery_uncertain');
        }
        if(uncertain())fail('delivery_uncertain');
        const routed=fenced(to);
        const shared=routed ? routeFence.reserve({id:request.requestId,hash:material,route:config.routeControl.routeId,createdAt:parent.run_at || parent.created_at}) : null;
        if(shared?.duplicate)return {ok:true,ids:[shared.providerId],duplicate:true};
        db.prepare('INSERT INTO group_send VALUES(?,?,?,?,?,?,?)').run(request.requestId,material,to,request.parentId,'sending',null,new Date(now()).toISOString());
        let timer;
        try {
          const sent=await Promise.race([client.sendMessage(to,text,{sendSeen:false}),new Promise((_,reject)=>{
            timer=setTimeout(()=>reject(new Error('send_timeout')),30000);
          })]);
          const id=sent?.id?._serialized;if(typeof id!=='string' || !id || id.startsWith('summary:'))fail('delivery_uncertain');
          db.prepare("UPDATE group_send SET state='sent',provider_id=? WHERE id=?").run(id,request.requestId);
          if(routed)routeFence.sent(request.requestId,id);
          return {ok:true,ids:[id]};
        } catch {
          db.prepare("UPDATE group_send SET state='uncertain' WHERE id=?").run(request.requestId);
          if(routed)routeFence.uncertain(request.requestId);
          fail('delivery_uncertain');
        } finally {clearTimeout(timer);}
      });
    },
    policyFields(buildHash) {return {version:1,transportOnly:true,groupsOnly:true,groupCount:groups.size,timerNotifications:!!scope,routeFence:!!routeFence,sendAttempts:1,textOnly:true,maxTextLength:3000,markSeen:false,automaticRouting:false,strictBearer:true,buildHash};},
    diagnostics(client,buildHash) {return {identityMatches:client?.info?.wid?._serialized===config.ownChatId,...this.policyFields(buildHash)};},
  };
}
