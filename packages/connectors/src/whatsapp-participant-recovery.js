// One Root-authorized historical participant message. Never owner/control authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const FORMAT='orkestr-whatsapp-participant-message-recovery-v1';
const FIELDS=['format','accountId','chatId','threadId','messageId','authorId','phoneId','createdAt','bodySha256','expiresAt'];
export const PARTICIPANT_RECOVERY_FIELDS=['threadId','messageId','expectedAuthorId','expectedPhoneId','expectedCreatedAt','expectedBodySha256'];
const deny=()=>{throw Object.assign(new Error('participant_recovery_denied'),{statusCode:403});};
const exact=(v,keys)=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const digest=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const sha=v=>typeof v==='string' && /^[0-9a-f]{64}$/.test(v);
const canonicalTime=v=>typeof v==='string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString()===v;
const identifier=v=>typeof v==='string' && v.length>0 && v.length<=1024 && !/[\s\x00-\x1f]/.test(v);

// Pure: preflight validates configuration without reading grants or journals.
export function validateParticipantRecoveryReference(config) {
 const ref=config.participantRecoveryGrant;
 if(ref===undefined)return null;
 if(!exact(ref,['path','sha256']) || typeof ref.path!=='string' || !path.isAbsolute(ref.path)
    || path.resolve(ref.path)!==ref.path || !sha(ref.sha256))deny();
 return Object.freeze({...ref});
}

export function readProtectedParticipantGrant(ref) {
 let fd;
 try {
  if(fs.realpathSync(ref.path)!==ref.path)deny();
  let p=ref.path;
  for(;;){const s=fs.lstatSync(p);if(s.uid!==0 || (s.mode&0o022) || s.isSymbolicLink() ||
      (p!==ref.path && !s.isDirectory()))deny();const parent=path.dirname(p);if(parent===p)break;p=parent;}
  fd=fs.openSync(ref.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile() || before.uid!==0n || (before.mode&0o777n)!==0o400n || before.nlink!==1n || before.size>16384n)deny();
  const raw=fs.readFileSync(fd),after=fs.fstatSync(fd,{bigint:true}),current=fs.statSync(ref.path,{bigint:true});
  const same=s=>['dev','ino','size','mtimeNs','ctimeNs'].every(k=>before[k]===s[k]);
  if(!same(after)||!same(current)||digest(raw)!==ref.sha256)deny();
  return JSON.parse(raw.toString('utf8'));
 } catch {deny();} finally {if(fd!==undefined)fs.closeSync(fd);}
}

export function createParticipantRecoveryPolicy(config,{now=Date.now,readGrant=readProtectedParticipantGrant}={}) {
 const ref=validateParticipantRecoveryReference(config);
 const accountId=config.workerAccountId || config.accountId || 'main';
 function grant() {
  if(!ref)deny();
  const g=readGrant(ref),group=config.groups?.find(r=>r.chatId===g?.chatId);
  const member=config.participantAuthors?.find(r=>r.chatId===g?.chatId && r.threadId===g?.threadId && Array.isArray(r.ids) && r.ids.includes(g?.phoneId));
  if(!exact(g,FIELDS) || g.format!==FORMAT || g.accountId!==accountId || !group || !member || group.threadId!==g.threadId
     || !identifier(g.messageId) || !/^\d+(?:-\d+)?@g\.us$/.test(g.chatId) || !identifier(g.threadId)
     || !/^\d+@(?:lid|c\.us)$/.test(g.authorId) || !/^\d+@c\.us$/.test(g.phoneId) || g.phoneId===config.ownChatId
     || !canonicalTime(g.createdAt) || !canonicalTime(g.expiresAt) || !sha(g.bodySha256)
     || Date.parse(g.createdAt)>now()+5000 || Date.parse(g.expiresAt)<=now())deny();
  return g;
 }
 function request(chatId,body) {
  const g=grant();
  if(!exact(body,PARTICIPANT_RECOVERY_FIELDS) || chatId!==g.chatId || body.threadId!==g.threadId
     || body.messageId!==g.messageId || body.expectedAuthorId!==g.authorId || body.expectedPhoneId!==g.phoneId
     || body.expectedCreatedAt!==g.createdAt || body.expectedBodySha256!==g.bodySha256)deny();
  return Object.freeze({...g,grantSha256:ref.sha256});
 }
 function matches(proof,input) {
  try {
   const g=grant();
   return proof?.recoveryGrantSha256===ref.sha256 && proof.inputId===g.messageId && input.id===g.messageId
     && proof.chatId===g.chatId && input.chat_id===g.chatId && proof.threadId===g.threadId
     && proof.authorId===g.authorId && proof.phoneId===g.phoneId && proof.createdAt===g.createdAt
     && input.created_at===g.createdAt && typeof input.body==='string' && digest(input.body)===g.bodySha256;
  } catch {return false;}
 }
 return {enabled:Boolean(ref),request,matches,sha256:ref?.sha256,
  message(g,message,chatId) {
   if(g?.grantSha256!==ref?.sha256)deny();
   // Re-read the protected grant so removal, replacement and expiry revoke it.
   request(chatId,{threadId:g.threadId,messageId:g.messageId,expectedAuthorId:g.authorId,
    expectedPhoneId:g.phoneId,expectedCreatedAt:g.createdAt,expectedBodySha256:g.bodySha256});
   const remote=message?.id?.remote?._serialized || message?.id?.remote;
   if(message?.id?._serialized!==g.messageId || message?.fromMe!==false || message.from!==chatId
      || remote!==chatId || message.author!==g.authorId || typeof message.body!=='string'
      || digest(message.body)!==g.bodySha256 || !Number.isFinite(Number(message.timestamp))
      || new Date(Number(message.timestamp)*1000).toISOString()!==g.createdAt)deny();
   return true;
  }};
}
