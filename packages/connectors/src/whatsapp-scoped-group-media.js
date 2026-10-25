// Inbound media download for the scoped group transport.
//
// `message.downloadMedia()` alone is not reliable for messages observed from
// the live `message` event: WhatsApp Web often has not resolved the media yet
// (stage FETCHING / ERROR) and whatsapp-web.js then returns undefined, or a
// minified store error is thrown. The transport used to swallow that silently
// and journal "[WhatsApp attachment skipped: download failed]" for every image.
// This mirrors the legacy bridge's recovery ladder (retry on a refreshed
// message, then the in-browser blob and store/decrypt fallbacks) and reports
// every failure without message content or media keys.

import crypto from 'node:crypto';
import {browserBlobInboundMedia, browserStoreInboundMedia} from './whatsapp-inbound-media-browser.js';

const DEFAULTS={attempts:3,retryMs:1500,timeoutMs:20000};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hasData=media=>Boolean(media && !Array.isArray(media) && media.data);
const code=error=>String(error?.code || error?.message || error || 'unknown').replace(/\d{6,}/g,'#').slice(0,160);

function withTimeout(promise,ms) {
  let timer;
  return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('media_download_timeout')),ms);
  })]).finally(()=>clearTimeout(timer));
}

export function scopedMediaIdHash(id) {
  return crypto.createHash('sha256').update(String(id||'')).digest('hex').slice(0,16);
}

// Returns {media, errors, stage}. `media` is null when every path failed.
export async function downloadScopedGroupMedia({client,message,chatId,report=()=>{},options={},wait=delay}) {
  const {attempts,retryMs,timeoutMs}={...DEFAULTS,...options};
  const id=message?.id?._serialized || '';
  const errors=[];
  let browserMedia=null;
  const onMedia=value=>{browserMedia=value;};
  const timed=promise=>withTimeout(promise,timeoutMs);
  let candidate=message;
  for(let attempt=1;attempt<=attempts;attempt++) {
    if(attempt>1) {
      if(retryMs>0)await wait(retryMs*(attempt-1));
      if(typeof client?.getMessageById==='function') {
        const refreshed=await timed(client.getMessageById(id)).catch(()=>null);
        if(refreshed?.hasMedia && typeof refreshed.downloadMedia==='function')candidate=refreshed;
      }
    }
    const ladder=[
      ['primary',()=>typeof candidate?.downloadMedia==='function' ? candidate.downloadMedia() : null],
      ['browser_blob',()=>browserBlobInboundMedia({client,eventId:id,withTimeout:timed,onMedia})],
      ['browser_store',()=>browserStoreInboundMedia({client,eventId:id,chatId,withTimeout:timed,onMedia})],
    ];
    for(const [stage,run] of ladder) {
      try {
        const media=await timed(run());
        if(hasData(media)) {
          if(attempt>1 || stage!=='primary')report({event:'scoped_group_media_download_recovered',chatId,idHash:scopedMediaIdHash(id),attempt,stage,errors});
          return {media,errors,stage};
        }
        errors.push({attempt,stage,code:'no_media'});
      } catch(error) {
        errors.push({attempt,stage,code:code(error)});
      }
    }
  }
  report({event:'scoped_group_media_download_failed',chatId,idHash:scopedMediaIdHash(id),attempts,
    type:String(message?.type||''),errors,browserMedia});
  return {media:null,errors,stage:''};
}
