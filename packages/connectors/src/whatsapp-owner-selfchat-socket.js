import http from 'node:http';
import fs from 'node:fs/promises';
import { selfChatError } from './whatsapp-owner-selfchat-journal.js';

// Parent directory must be operator-created root:runtime-group 0750. No TCP
// listener, general proxy, arbitrary command or credential endpoint is offered.
export async function listenOwnerSelfChatAdapter({ socketPath, adapter, mode=0o660 }) {
  if (!socketPath?.startsWith('/')) throw selfChatError('selfchat_socket_required');
  const server=http.createServer(async (req,res) => {
    res.setHeader('content-type','application/json');
    if (req.method!=='POST' || req.url!=='/operation') {
      res.writeHead(404); res.end(JSON.stringify({ok:false,error:'selfchat_endpoint_denied'})); return;
    }
    try {
      const chunks=[]; let size=0;
      for await(const chunk of req) {
        size+=chunk.length;
        if(size>16384) throw selfChatError('selfchat_request_too_large',413);
        chunks.push(chunk);
      }
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const result=await adapter.request(body);
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error.statusCode || 400);
      const code=/^(selfchat_|owner_selfchat_)[a-z_]+$/.test(error.message) ? error.message : 'selfchat_request_failed';
      res.end(JSON.stringify({ok:false,error:code,retryable:false}));
    }
  });
  server.requestTimeout=35000; server.headersTimeout=5000;
  // Refuse occupied/stale sockets. Do not delete another process's endpoint.
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  try { await fs.chmod(socketPath,mode); } catch(error) { server.close(); throw error; }
  return server;
}

export function ownerSelfChatSocketRequest(socketPath, body, {timeoutMs=35000}={}) {
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify(body);
    const req=http.request({socketPath,path:'/operation',method:'POST',headers:{
      'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)req.destroy(selfChatError('selfchat_response_too_large'));else chunks.push(chunk);});
      res.on('error',()=>reject(selfChatError('selfchat_transport_unavailable',503)));
      res.on('end',()=>{
        try {
          const result=JSON.parse(Buffer.concat(chunks).toString());
          if(res.statusCode!==200 || result.ok!==true) throw selfChatError(result.error || 'selfchat_transport_failed',res.statusCode);
          resolve(result);
        } catch(error) { reject(error); }
      });
    });
    // A failed RPC must never cause a fallback to another account or sender.
    const timer=setTimeout(()=>req.destroy(selfChatError('selfchat_transport_timeout',504)),timeoutMs);
    req.once('close',()=>clearTimeout(timer));
    req.once('error',()=>reject(selfChatError('selfchat_transport_unavailable',503)));
    req.end(data);
  });
}
