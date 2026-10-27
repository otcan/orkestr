import crypto from 'node:crypto';
import {createGroupParticipantPolicy} from './whatsapp-group-participant-author.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGroupOwnerAuthorPolicy} from './whatsapp-group-owner-author.js';
import {scopedRouteMembership} from './whatsapp-scoped-route-membership.js';
import {SCOPED_SEND_MAX_TEXT_LENGTH, encodeReplyEntry, validQuotedMessageId, validReplyDocument} from './whatsapp-scoped-group-formatting.js';
import {DatabaseSync} from 'node:sqlite';
import {createDeliveryRouteFence} from './whatsapp-delivery-route-fence.js';
import {notificationScope, createTimerNotificationProofStore} from './whatsapp-timer-notification-proof.js';
import {OPERATOR_NOTICE_PARENT, validateOperatorNotifications, operatorNoticeRequestValid, operatorNoticeBodyValid} from './whatsapp-scoped-operator-notices.js';
import {downloadScopedGroupMedia} from './whatsapp-scoped-group-media.js';
import {validateCoordinatorConfig, coordinatorTokenMatches, createCoordinatorAccess} from './whatsapp-scoped-coordinator.js';
import {validateDelegatesConfig, delegateForBearer, createDelegateAccess} from './whatsapp-scoped-delegates.js';
import {DYNAMIC_GROUPS_TABLE, createDynamicGroupView, validateDynamicGroups} from './whatsapp-scoped-dynamic-groups.js';
import {encodeReplyFile, readReplyFile} from './whatsapp-scoped-reply-files.js';

const fail=code=>{throw new Error(`group_transport_${code}`);};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const IMAGE_MIME_EXTENSIONS=new Map([['image/jpeg','.jpg'],['image/png','.png'],['image/gif','.gif'],['image/webp','.webp']]);
const MAX_GROUP_MEDIA_BYTES=10*1024*1024;
// Types that can never become an image attachment: skip the download so a large
// video or voice note cannot hold the serial input queue.
const NON_IMAGE_MEDIA_TYPES=new Set(['video','audio','ptt','ptv']);
const safeMediaName=value=>path.basename(String(value||'image').replace(/[\\/\0]/g,'_')).replace(/[^a-zA-Z0-9_. -]/g,'_').slice(0,180)||'image';

// Media evidence lives in a side table so group_input keeps the exact four-column
// shape every earlier transport build writes positionally. Altering group_input
// made a rollback to an earlier build fail every insert (and drop all input).
const MEDIA_TABLE='CREATE TABLE IF NOT EXISTS group_input_media(id TEXT PRIMARY KEY,path TEXT NOT NULL,filename TEXT,mimetype TEXT,size INTEGER)';

// Reply-quote evidence (WhatsApp "reply") is likewise a side table keyed by the
// input id. `resolved=0` records that the message quoted something we could not
// read, so the relay can say so instead of guessing.
const QUOTE_TABLE='CREATE TABLE IF NOT EXISTS group_input_quote(id TEXT PRIMARY KEY,quoted_id TEXT,author TEXT,sent_at TEXT,body TEXT,from_me INTEGER,resolved INTEGER NOT NULL)';
const QUOTE_LOOKUP_MS=5000;
const QUOTE_BODY_MAX=4000;
const quoteText=value=>typeof value==='string'?value.slice(0,QUOTE_BODY_MAX):'';
// Best-effort quoted-message capture; never throws. Null when the message quotes nothing.
export async function captureQuote(message) {
  const data=message?._data || {};
  if(message?.hasQuotedMsg!==true && !data.quotedStanzaID)return null;
  let quoted=null,timer;
  try {
    if(typeof message.getQuotedMessage==='function')
      quoted=await Promise.race([message.getQuotedMessage(),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),QUOTE_LOOKUP_MS);})]);
  } catch {quoted=null;} finally {clearTimeout(timer);}
  const embedded=data.quotedMsg || {};
  const body=quoteText(quoted?.body) || quoteText(embedded.body) || quoteText(embedded.caption);
  const quotedId=quoted?.id?._serialized || (typeof data.quotedStanzaID==='string' && data.quotedStanzaID ? data.quotedStanzaID : null);
  const seconds=Number(quoted?.timestamp || embedded.t);
  const author=String(quoted?.author || quoted?.from || data.quotedParticipant?._serialized || data.quotedParticipant || embedded.from?._serialized || '') || null;
  return {quotedId,author,sentAt:Number.isFinite(seconds) && seconds>0 ? new Date(seconds*1000).toISOString() : null,body,
    fromMe:quoted?.fromMe===true,resolved:Boolean(body) && Boolean(quotedId)};
}

// An explicitly configured, existing-account transport. The surrounding bridge
// keeps its legacy router disabled; only explicitly authorized, fresh group input enters.
// Pure contract validation: no files are opened. Shared by the transport and
// the deploy preflight, so a release that rejects a live config is never activated.
export function validateScopedGroupConfig(config,now=Date.now) {
  if(!/^\d+@c\.us$/.test(config?.ownChatId || '') || !Number.isFinite(Date.parse(config.activatedAt))
      || !Array.isArray(config.groups) || !config.groups.length)fail('configuration_invalid');
  const groups=new Map(config.groups.map(g=>[g.chatId,g]));
  if(groups.size!==config.groups.length || [...groups].some(([id,g])=>!/^\d+(?:-\d+)?@g\.us$/.test(id) || !g.threadId))fail('configuration_invalid');
  const authors=createGroupOwnerAuthorPolicy(config,now);
  const participants=createGroupParticipantPolicy(config,now);
  const scope=notificationScope(config);
  const fencedThreads=scopedRouteMembership(config);
  if(fencedThreads && [...fencedThreads].some(id=>!config.groups.some(g=>g.threadId===id)))fail('route_thread_invalid');
  const coordinator=validateCoordinatorConfig(config);
  const delegates=validateDelegatesConfig(config);
  if(delegates && coordinator && [...delegates.values()].some(d=>d.tokenSha256===coordinator.tokenSha256))fail('configuration_invalid');
  const dynamic=validateDynamicGroups(config);
  const operator=validateOperatorNotifications(config);
  return {groups,authors,participants,scope,fencedThreads,coordinator,delegates,dynamic,operator};
}

export function createScopedGroupTransport({config,token,base,dbPath=config.journalPath,now=Date.now,routeFence: suppliedFence,proofStore: suppliedProof,sendLookupDelayMs=1000,
    report=entry=>console.error(JSON.stringify(entry)),mediaDownloadOptions={}}) {
  if(!token)fail('configuration_invalid');
  // Validate the whole contract before opening durable state: a build that
  // rejects the live configuration must leave the journal untouched.
  const {groups: staticGroups,authors,participants,scope,fencedThreads,coordinator,delegates,dynamic,operator}=validateScopedGroupConfig(config,now);
  // The coordinator bearer must be a dedicated credential, never the transport token.
  if(coordinatorTokenMatches(coordinator,token) || delegateForBearer(delegates,token))fail('configuration_invalid');
  const db=new DatabaseSync(dbPath);db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS group_input(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_send(id TEXT PRIMARY KEY,hash TEXT NOT NULL,chat_id TEXT NOT NULL,parent_id TEXT NOT NULL,state TEXT NOT NULL,provider_id TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_input_author(id TEXT PRIMARY KEY,proof TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    ${MEDIA_TABLE};
    ${QUOTE_TABLE};`);
  // Registered groups (dynamicGroups) join the static allowlist live. The
  // contract below stays the static one, so enabling this needs no migration.
  if(dynamic)db.exec(DYNAMIC_GROUPS_TABLE);
  const groups=dynamic ? createDynamicGroupView(db,{static:staticGroups,now}) : staticGroups;
  const mediaDir=path.resolve(config.mediaDir || (dbPath===':memory:'
    ? path.join(os.tmpdir(),`orkestr-scoped-group-media-${process.pid}`)
    : `${dbPath}.media`));
  const contract=hash([config.ownChatId,config.activatedAt,config.groups]);  // static groups only
  const prior=db.prepare('SELECT value FROM group_meta WHERE key=?').get('contract');
  if(prior && prior.value!==contract)fail('configuration_changed');
  db.prepare('INSERT OR IGNORE INTO group_meta VALUES(?,?)').run('contract',contract);
  if(authors.contract) {
    const authorContract=hash(authors.contract);
    const previous=db.prepare('SELECT value FROM group_meta WHERE key=?').get('owner_authors');
    if(previous && previous.value!==authorContract)fail('owner_author_configuration_changed');
    db.prepare('INSERT OR IGNORE INTO group_meta VALUES(?,?)').run('owner_authors',authorContract);
  }
  db.prepare("UPDATE group_send SET state='uncertain' WHERE state='sending'").run();
  const routeFence=config.routeControl ? suppliedFence || createDeliveryRouteFence({dbPath:config.routeControl.dbPath,now}) : null;
  // A registered group shares the route fence of the static groups.
  const fenced=to=>Boolean(routeFence) && (fencedThreads.has(groups.get(to)?.threadId) || groups.get(to)?.dynamic===true);
  if(routeFence)routeFence.recover(config.routeControl.routeId);
  const proofStore=scope ? suppliedProof || createTimerNotificationProofStore({path:scope.proofDbPath,readOnly:true,now}) : null;
  let tail=Promise.resolve();
  const serial=work=>{const next=tail.catch(()=>{}).then(work);tail=next;return next;};
  const uncertain=()=>Boolean(db.prepare("SELECT 1 FROM group_send WHERE state='uncertain' LIMIT 1").get());
  const assertClient=client=>{if(client?.info?.wid?._serialized!==config.ownChatId)fail('account_mismatch');};
  // Owner-authorized coordinator: its own bearer, routes, and send journal table.
  const coordinatorAccess=coordinator ? createCoordinatorAccess({config,coordinator,db,serial,now,lookupDelayMs:sendLookupDelayMs}) : null;
  const delegateAccess=delegates ? createDelegateAccess({config,delegates,db,serial,now,lookupDelayMs:sendLookupDelayMs}) : null;
  return {
    ...base,enabled:true,groupsMode:true,hasGroup:chatId=>groups.has(chatId),close:()=>{db.close();if(!suppliedFence)routeFence?.close();if(!suppliedProof)proofStore?.close();},blocked:uncertain,
    assertClient,
    middleware(req,res,next) {
      const matchToken=String(req.get('authorization')||'').match(/^Bearer (.+)$/i);
      const supplied=Buffer.from(matchToken?.[1] || ''),expected=Buffer.from(token);
      // The coordinator bearer reaches only /coordinator/*; the transport token never does.
      if(coordinatorAccess && matchToken && coordinatorTokenMatches(coordinator,matchToken[1])) {
        if(!req.path.startsWith('/coordinator/'))return res.status(403).json({ok:false,error:'coordinator_scope_denied'});
        req.orkestrCoordinator=true;
        return next();
      }
      // A delegate bearer reaches only /delegate/*, scoped to its own chats.
      const delegate=delegateAccess && matchToken ? delegateForBearer(delegates,matchToken[1]) : null;
      if(delegate) {
        if(!req.path.startsWith('/delegate/'))return res.status(403).json({ok:false,error:'delegate_scope_denied'});
        req.orkestrDelegate=delegate;
        return next();
      }
      if(!matchToken || supplied.length!==expected.length || !crypto.timingSafeEqual(supplied,expected))return res.status(401).json({ok:false,error:'group_transport_unauthorized'});
      let allowed=req.method==='GET' && ['/health','/api/accounts'].includes(req.path);
      const match=req.path.match(/^\/api\/chats\/([^/]+)\/(history|meta)$/);
      if(req.method==='GET' && match) {
        try {allowed=groups.has(decodeURIComponent(match[1])) && (req.query.mark_seen===undefined || req.query.mark_seen==='false')
          && (match[2]==='meta' || /^(?:[1-9]|[1-4]\d|50)$/.test(String(req.query.limit ?? 20)));}catch{allowed=false;}
      }
      if(req.method==='POST' && req.path==='/send-text') {
        const b=req.body || {};
        allowed=groups.has(b.to) && b.accountId==='main' && typeof b.text==='string' && b.text.trim() && b.text.length<=SCOPED_SEND_MAX_TEXT_LENGTH
          && ((typeof b.requestId==='string' && typeof b.parentId==='string'
          && (b.quotedMessageId===undefined || validQuotedMessageId(b.quotedMessageId))
          && Object.keys(b).every(k=>['to','text','accountId','requestId','parentId','notificationId','quotedMessageId'].includes(k))
          && (b.notificationId===undefined || (scope?.allowsChat(b.to) && b.notificationId===b.requestId)))
            || operatorNoticeBodyValid(operator,b,'main'));
      }
      return allowed?next():res.status(403).json({ok:false,error:'group_transport_scope_denied'});
    },
    // Mounted by the bridge right after `middleware`, before its own routes.
    routes(app,getClient) {if(delegateAccess)app.use(delegateAccess.handler(getClient));if(coordinatorAccess)app.use(coordinatorAccess.handler(getClient));},
    coordinator:coordinatorAccess,
    delegates:delegateAccess,
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
        const id=message?.id?._serialized,chatId=message?.fromMe===true?message?.to:message?.from;
        const ts=Number(message?.timestamp)*1000;
        const hasMedia=message?.hasMedia===true;
        const group=groups.get(chatId);
        if(!group || typeof id!=='string' || !id || id.startsWith('summary:')
            || typeof message.body!=='string' || (!message.body.trim()&&!hasMedia) || message.body.length>32000
            || !Number.isFinite(ts) || ts<=Date.parse(config.activatedAt) || ts>now()+5000)return false;
        // A registered group starts at its registration: older history is never imported.
        if(group.dynamic && (ts<=Date.parse(group.registeredAt) || ts<=dynamic.since))return false;
        if(db.prepare('SELECT 1 FROM group_input WHERE id=?').get(id))return false;
        const remote=message?.id?.remote?._serialized || message?.id?.remote;
        if(remote && remote!==chatId)return false;
        let participant=null;
        if(message?.fromMe!==true && !await authors.accepts(client,message)) {
          participant=await participants.identify(client,message,chatId);
          if(!participant)return false;
        }
        if(fenced(chatId)) {
          let active;try {active=routeFence.assertActive(config.routeControl.routeId);}catch{return false;}
          if(ts<Date.parse(active.since))return false;
        }
        if(uncertain())fail('delivery_uncertain');
        if(db.prepare('SELECT 1 FROM group_send WHERE provider_id=?').get(id))return false;
        const quote=await captureQuote(message);
        let body=message.body,mediaPath='',mediaFilename='',mediaMimetype='',mediaSize=0;
        if(hasMedia) {
          const type=String(message?.type||'').toLowerCase();
          let media=null;
          if(NON_IMAGE_MEDIA_TYPES.has(type)) media={data:'',mimetype:type,skip:true};
          else media=(await downloadScopedGroupMedia({client,message,chatId,report,options:mediaDownloadOptions})).media;
          const mimetype=String(media?.mimetype||'').split(';')[0].trim().toLowerCase();
          const encoded=String(media?.data||'');
          if(media?.skip) body=[body.trim(),`[WhatsApp attachment skipped: unsupported media type ${type}]`].filter(Boolean).join('\n\n');
          else if(!media?.data) body=[body.trim(),'[WhatsApp attachment skipped: download failed]'].filter(Boolean).join('\n\n');
          else if(!IMAGE_MIME_EXTENSIONS.has(mimetype)) body=[body.trim(),`[WhatsApp attachment skipped: unsupported media type ${mimetype||'unknown'}]`].filter(Boolean).join('\n\n');
          else if(encoded.length>Math.ceil(MAX_GROUP_MEDIA_BYTES*4/3)+8) body=[body.trim(),'[WhatsApp attachment skipped: file exceeds 10 MiB limit]'].filter(Boolean).join('\n\n');
          else {
            const buffer=Buffer.from(encoded,'base64');
            if(!buffer.length) body=[body.trim(),'[WhatsApp attachment skipped: download was empty]'].filter(Boolean).join('\n\n');
            else if(buffer.length>MAX_GROUP_MEDIA_BYTES) body=[body.trim(),'[WhatsApp attachment skipped: file exceeds 10 MiB limit]'].filter(Boolean).join('\n\n');
            else {
              await fs.mkdir(mediaDir,{recursive:true,mode:0o700});
              mediaFilename=safeMediaName(media.filename||`image${IMAGE_MIME_EXTENSIONS.get(mimetype)}`);
              mediaMimetype=mimetype;mediaSize=buffer.length;
              mediaPath=path.join(mediaDir,`${crypto.createHash('sha256').update(id).digest('hex')}${IMAGE_MIME_EXTENSIONS.get(mimetype)}`);
              const temporary=`${mediaPath}.tmp`;
              await fs.writeFile(temporary,buffer,{mode:0o600,flag:'wx'}).catch(async error=>{
                if(error?.code!=='EEXIST')throw error;
                await fs.rm(temporary,{force:true});
                await fs.writeFile(temporary,buffer,{mode:0o600,flag:'wx'});
              });
              await fs.rename(temporary,mediaPath);
            }
          }
        }
        // Input and participant evidence commit together; a crash cannot turn a
        // participant input into a legacy owner input on the next relay poll.
        db.exec('BEGIN IMMEDIATE');
        try {
          const result=db.prepare('INSERT OR IGNORE INTO group_input(id,chat_id,body,created_at) VALUES(?,?,?,?)')
            .run(id,chatId,body,new Date(ts).toISOString());
          if(result.changes && mediaPath) db.prepare('INSERT INTO group_input_media(id,path,filename,mimetype,size) VALUES(?,?,?,?,?)')
            .run(id,mediaPath,mediaFilename||null,mediaMimetype||null,mediaSize||null);
          if(result.changes && quote) db.prepare('INSERT OR IGNORE INTO group_input_quote(id,quoted_id,author,sent_at,body,from_me,resolved) VALUES(?,?,?,?,?,?,?)')
            .run(id,quote.quotedId,quote.author,quote.sentAt,quote.body||null,quote.fromMe?1:0,quote.resolved?1:0);
          if(result.changes && participant) db.prepare('INSERT INTO group_input_author VALUES(?,?)').run(id,JSON.stringify(participant));
          db.exec('COMMIT');
          return Boolean(result.changes);
        } catch(error) {db.exec('ROLLBACK');throw error;}
      });
    },
    sendText(client,to,text,accountId,request={}) {
      const valid=typeof text==='string' && Boolean(text.trim()) && text.length<=SCOPED_SEND_MAX_TEXT_LENGTH;
      return deliver(client,to,valid ? text : '',accountId,request,quoted=>client.sendMessage(to,text,{sendSeen:false,...(quoted?{quotedMessageId:quoted}:{})}),valid,
        message=>message?.type==='chat' && message.body===text);
    },
    // The full text of a long reply as one Markdown document. It is one more
    // journaled send: same parent/proof authorization, dedupe, uncertainty and
    // route fence as a text. `createMedia` builds the provider's media object.
    sendDocument(client,to,document,accountId,request={},createMedia) {
      const valid=validReplyDocument(document) && typeof createMedia==='function';
      return deliver(client,to,valid ? encodeReplyEntry({document}) : '',accountId,request,()=>client.sendMessage(to,
        createMedia({mimetype:document.mimetype,data:Buffer.from(document.text,'utf8').toString('base64'),filename:document.filename}),
        {sendSeen:false,sendMediaAsDocument:true}),valid,
        message=>message?.type==='document' && message?._data?.filename===document?.filename);
    },
    // A file the assistant attached to a reply, read from the group's own
    // thread snapshot (`replyMediaRoot`) and checked against its digest. Same
    // journaled send as a text: parent authorization, dedupe, uncertainty.
    sendFile(client,to,file,accountId,request={},createMedia) {
      let data=null;
      const group=groups.get(to);
      try {
        if(typeof createMedia==='function' && config.replyMediaRoot && group)
          data=readReplyFile(file,{root:config.replyMediaRoot,threadId:group.threadId});
      } catch {data=null;}
      const valid=Boolean(data);
      const image=valid && file.mimetype.startsWith('image/');
      return deliver(client,to,valid ? encodeReplyFile(file) : '',accountId,request,()=>client.sendMessage(to,
        createMedia({mimetype:file.mimetype,data:data.toString('base64'),filename:file.filename}),
        {sendSeen:false,sendMediaAsDocument:!image}),valid,
        message=>image ? message?.type==='image' : message?.type==='document' && message?._data?.filename===file?.filename);
    },
    policyFields(buildHash) {return {version:1,transportOnly:true,groupsOnly:true,groupCount:groups.size,dynamicGroups:Boolean(dynamic),additionalOwnerAuthors:authors.count,participantGroups:participants.count,timerNotifications:!!scope,operatorNotices:!!operator,routeFence:!!routeFence,sendAttempts:1,textOnly:true,maxTextLength:SCOPED_SEND_MAX_TEXT_LENGTH,markSeen:false,automaticRouting:false,strictBearer:true,coordinator:!!coordinatorAccess,delegates:delegates?delegates.size:0,buildHash};},
    diagnostics(client,buildHash) {return {identityMatches:client?.info?.wid?._serialized===config.ownChatId,...this.policyFields(buildHash)};},
  };
  // `text` is the canonical payload string: the message itself, or a
  // document's envelope. It is what proofs authorize and the journal hashes.
  // WhatsApp Web can create and deliver a message yet return no usable model
  // from sendMessage (seen with a ~20000-character text). Before journaling the
  // send as uncertain, look for exactly one own message in this group that was
  // created after the send started, matches the payload, is not journaled yet
  // and has a server ack. Anything else stays uncertain.
  async function confirmByLookup(client,to,startedAt,matches) {
    if(typeof client?.getChatById!=='function')return null;
    for(let attempt=0;attempt<6;attempt++) {
      if(attempt)await new Promise(resolve=>setTimeout(resolve,sendLookupDelayMs));
      try {
        const chat=await client.getChatById(to);
        const found=(await chat.fetchMessages({limit:20})).filter(message=>{
          const id=message?.id?._serialized;
          return message?.fromMe===true && typeof id==='string' && id && !id.startsWith('summary:')
            && Number(message.timestamp)*1000>=startedAt-5000 && matches(message)
            && !db.prepare('SELECT 1 FROM group_send WHERE provider_id=?').get(id);
        });
        if(found.length>1)return null;
        if(found.length===1 && Number(found[0].ack)>=1)return found[0].id._serialized;
      } catch { /* a failed lookup proves nothing; retry, then stay uncertain */ }
    }
    return null;
  }
  // A text may quote (reply-to) an input of the same group. The quote is
  // presentation only: it is not part of the hashed, proof-authorized payload.
  // One naming no input of this group is dropped, not rejected: rejecting before
  // dispatch would close the reply undelivered over a cosmetic detail.
  function quotedInput(to,request) {
    const id=request.quotedMessageId;
    if(id===undefined || id===null || id==='')return null;
    if(validQuotedMessageId(id) && db.prepare('SELECT 1 FROM group_input WHERE id=? AND chat_id=?').get(id,to))return id;
    report({event:'group_send_quote_dropped',chatId:to,requestId:request.requestId});
    return null;
  }
  function deliver(client,to,text,accountId,request,dispatch,valid,matches) {
      return serial(async()=>{
        assertClient(client);
        if(!valid || !groups.has(to) || accountId!=='main' || !/^[a-zA-Z0-9:._-]{1,200}$/.test(request.requestId || ''))fail('scope_denied');
        let parent;
        if(request.operatorNotice!==undefined) {
          // Operator notice: no parent and no proof. Narrow by config, request id shape and an hourly cap.
          if(!operatorNoticeRequestValid(operator,to,request))fail('operator_notice_denied');
          request={...request,parentId:OPERATOR_NOTICE_PARENT};
          parent={id:OPERATOR_NOTICE_PARENT,created_at:new Date(now()).toISOString()};
        } else if(request.notificationId!==undefined) {
          if(!scope || request.notificationId!==request.requestId)fail('notification_denied');
          parent=proofStore.authorize({scope,id:request.notificationId,to,text,parentId:request.parentId});
        } else {
          parent=db.prepare('SELECT * FROM group_input WHERE id=? AND chat_id=?').get(request.parentId,to);
          if(!parent)fail('reply_parent_required');
          const author=db.prepare('SELECT proof FROM group_input_author WHERE id=?').get(parent.id);
          if(author && !participants.allows(JSON.parse(author.proof),parent))fail('participant_reply_denied');
        }
        const material=hash([to,text,request.parentId]);
        const previous=db.prepare('SELECT * FROM group_send WHERE id=?').get(request.requestId);
        if(previous) {
          if(previous.hash!==material)fail('request_conflict');
          if(previous.state==='sent')return {ok:true,ids:[previous.provider_id],duplicate:true};
          fail('delivery_uncertain');
        }
        if(uncertain())fail('delivery_uncertain');
        if(parent.id===OPERATOR_NOTICE_PARENT && db.prepare('SELECT count(*) n FROM group_send WHERE parent_id=? AND created_at>=?')
            .get(OPERATOR_NOTICE_PARENT,new Date(now()-3600000).toISOString()).n>=operator.maxPerHour)fail('operator_notice_rate_limited');
        const quoted=quotedInput(to,request);
        const routed=fenced(to);
        const shared=routed ? routeFence.reserve({id:request.requestId,hash:material,route:config.routeControl.routeId,createdAt:parent.run_at || parent.created_at}) : null;
        if(shared?.duplicate)return {ok:true,ids:[shared.providerId],duplicate:true};
        db.prepare('INSERT INTO group_send VALUES(?,?,?,?,?,?,?)').run(request.requestId,material,to,request.parentId,'sending',null,new Date(now()).toISOString());
        let timer;
        const startedAt=now();
        const settle=id=>{
          db.prepare("UPDATE group_send SET state='sent',provider_id=? WHERE id=?").run(id,request.requestId);
          if(routed)routeFence.sent(request.requestId,id);
          return {ok:true,ids:[id]};
        };
        try {
          let sent=null;
          try {
            sent=await Promise.race([dispatch(quoted),new Promise((_,reject)=>{
              timer=setTimeout(()=>reject(new Error('send_timeout')),30000);
            })]);
          } catch { /* the outcome is unknown; confirmed or left uncertain below */ }
          const id=sent?.id?._serialized;
          if(typeof id==='string' && id && !id.startsWith('summary:'))return settle(id);
          const found=await confirmByLookup(client,to,startedAt,matches);
          if(found)return settle(found);
          fail('delivery_uncertain');
        } catch {
          db.prepare("UPDATE group_send SET state='uncertain' WHERE id=?").run(request.requestId);
          if(routed)routeFence.uncertain(request.requestId);
          fail('delivery_uncertain');
        } finally {clearTimeout(timer);}
      });
  }
}
