import crypto from 'node:crypto';
import {createGroupParticipantPolicy} from './whatsapp-group-participant-author.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createGroupOwnerAuthorPolicy} from './whatsapp-group-owner-author.js';
import {scopedRouteMembership} from './whatsapp-scoped-route-membership.js';
import {SCOPED_SEND_MAX_TEXT_LENGTH, encodeReplyEntry, validReplyDocument} from './whatsapp-scoped-group-formatting.js';
import {DatabaseSync} from 'node:sqlite';
import {createDeliveryRouteFence} from './whatsapp-delivery-route-fence.js';
import {notificationScope, createTimerNotificationProofStore} from './whatsapp-timer-notification-proof.js';

const fail=code=>{throw new Error(`group_transport_${code}`);};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const IMAGE_MIME_EXTENSIONS=new Map([['image/jpeg','.jpg'],['image/png','.png'],['image/gif','.gif'],['image/webp','.webp']]);
const MAX_GROUP_MEDIA_BYTES=10*1024*1024;
const safeMediaName=value=>path.basename(String(value||'image').replace(/[\\/\0]/g,'_')).replace(/[^a-zA-Z0-9_. -]/g,'_').slice(0,180)||'image';

// Media evidence lives in a side table so group_input keeps the exact four-column
// shape every earlier transport build writes positionally. Altering group_input
// made a rollback to an earlier build fail every insert (and drop all input).
const MEDIA_TABLE='CREATE TABLE IF NOT EXISTS group_input_media(id TEXT PRIMARY KEY,path TEXT NOT NULL,filename TEXT,mimetype TEXT,size INTEGER)';

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
  return {groups,authors,participants,scope,fencedThreads};
}

export function createScopedGroupTransport({config,token,base,dbPath=config.journalPath,now=Date.now,routeFence: suppliedFence,proofStore: suppliedProof,sendLookupDelayMs=1000}) {
  if(!token)fail('configuration_invalid');
  // Validate the whole contract before opening durable state: a build that
  // rejects the live configuration must leave the journal untouched.
  const {groups,authors,participants,scope,fencedThreads}=validateScopedGroupConfig(config,now);
  const db=new DatabaseSync(dbPath);db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS group_input(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_send(id TEXT PRIMARY KEY,hash TEXT NOT NULL,chat_id TEXT NOT NULL,parent_id TEXT NOT NULL,state TEXT NOT NULL,provider_id TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_input_author(id TEXT PRIMARY KEY,proof TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    ${MEDIA_TABLE};`);
  const mediaDir=path.resolve(config.mediaDir || (dbPath===':memory:'
    ? path.join(os.tmpdir(),`orkestr-scoped-group-media-${process.pid}`)
    : `${dbPath}.media`));
  const contract=hash([config.ownChatId,config.activatedAt,config.groups]);
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
  const fenced=to=>routeFence && fencedThreads.has(groups.get(to)?.threadId);
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
        allowed=groups.has(b.to) && b.accountId==='main' && typeof b.text==='string' && b.text.trim() && b.text.length<=SCOPED_SEND_MAX_TEXT_LENGTH
          && typeof b.requestId==='string' && typeof b.parentId==='string'
          && Object.keys(b).every(k=>['to','text','accountId','requestId','parentId','notificationId'].includes(k))
          && (b.notificationId===undefined || (scope?.allowsChat(b.to) && b.notificationId===b.requestId));
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
        const id=message?.id?._serialized,chatId=message?.fromMe===true?message?.to:message?.from;
        const ts=Number(message?.timestamp)*1000;
        const hasMedia=message?.hasMedia===true;
        if(!groups.has(chatId) || typeof id!=='string' || !id || id.startsWith('summary:')
            || typeof message.body!=='string' || (!message.body.trim()&&!hasMedia) || message.body.length>32000
            || !Number.isFinite(ts) || ts<=Date.parse(config.activatedAt) || ts>now()+5000)return false;
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
        let body=message.body,mediaPath='',mediaFilename='',mediaMimetype='',mediaSize=0;
        if(hasMedia) {
          let media=null;
          try {if(typeof message.downloadMedia==='function')media=await message.downloadMedia();} catch { /* converted to a visible skip note */ }
          const mimetype=String(media?.mimetype||'').split(';')[0].trim().toLowerCase();
          const encoded=String(media?.data||'');
          if(!media?.data) body=[body.trim(),'[WhatsApp attachment skipped: download failed]'].filter(Boolean).join('\n\n');
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
          if(result.changes && participant) db.prepare('INSERT INTO group_input_author VALUES(?,?)').run(id,JSON.stringify(participant));
          db.exec('COMMIT');
          return Boolean(result.changes);
        } catch(error) {db.exec('ROLLBACK');throw error;}
      });
    },
    sendText(client,to,text,accountId,request={}) {
      const valid=typeof text==='string' && Boolean(text.trim()) && text.length<=SCOPED_SEND_MAX_TEXT_LENGTH;
      return deliver(client,to,valid ? text : '',accountId,request,()=>client.sendMessage(to,text,{sendSeen:false}),valid,
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
    policyFields(buildHash) {return {version:1,transportOnly:true,groupsOnly:true,groupCount:groups.size,additionalOwnerAuthors:authors.count,participantGroups:participants.count,timerNotifications:!!scope,routeFence:!!routeFence,sendAttempts:1,textOnly:true,maxTextLength:SCOPED_SEND_MAX_TEXT_LENGTH,markSeen:false,automaticRouting:false,strictBearer:true,buildHash};},
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
  function deliver(client,to,text,accountId,request,dispatch,valid,matches) {
      return serial(async()=>{
        assertClient(client);
        if(!valid || !groups.has(to) || accountId!=='main' || !/^[a-zA-Z0-9:._-]{1,200}$/.test(request.requestId || ''))fail('scope_denied');
        let parent;
        if(request.notificationId!==undefined) {
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
            sent=await Promise.race([dispatch(),new Promise((_,reject)=>{
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
