// Real API pass-through. Only authenticated GET beta discovery is synthetic:
// this exposes the composer without configuring or invoking a real provider.
import {createServer,request} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
export async function composerProxy(bundle){
  let backend=0;
  const sessionFor=headers=>new Promise((resolve,reject)=>{
    // node fetch rewrites Host; the real browser endpoint requires its exact
    // origin authority. Use HTTP request with the original Host and cookie.
    const check=request({host:'127.0.0.1',port:backend,path:'/api/v2/browser/session',method:'GET',headers:{host:headers.host,cookie:headers.cookie||''}},reply=>{
      let text='',bytes=0;reply.on('data',part=>{bytes+=part.length;if(bytes>8192){reply.destroy();reject(Error('Session projection exceeds bound'));}else text+=part.toString('utf8');});
      reply.on('end',()=>{try{resolve({ok:reply.statusCode===200,body:JSON.parse(text)});}catch{reject(Error('Session projection invalid'));}});
    });check.setTimeout(5000,()=>check.destroy());check.on('error',reject);check.end();
  });
  const stats={chunk_requests:0,chunk_bytes:0,largest_chunk:0,beta_fixture_reads:0,attachment_posts:0,message_posts:0};
  const server=createServer(async(req,res)=>{
    try{
    const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;
    if(path==='/api/v2/beta'&&req.method==='GET'&&backend){
      const session=await sessionFor(req.headers);
      if(session.ok){
        const value=session.body,id=url.searchParams.get('conversation_id')||value.global_conversation_id;
        if(id===value.global_conversation_id){
          stats.beta_fixture_reads++;res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
          return res.end(JSON.stringify({schema_version:1,conversation_id:id,provider:'codex',role:'deep',controls:{stop:true,steer:true,accept:true},limits:{duration_ms:900000,attempts:32,bytes:67108864,cleanup_ms:30000,cleanup_attempts:4,cleanup_bytes:1048576},window:null}));
        }
      }
    }
    if(path.startsWith('/api/v2/')){
      const upstream=request({host:'127.0.0.1',port:backend,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
      let size=0;req.on('data',b=>size+=b.length);req.on('end',()=>{
        if(/\/encrypted-uploads\/[^/]+\/chunks\/\d+$/.test(path)&&req.method==='PUT'){stats.chunk_requests++;stats.chunk_bytes+=size;stats.largest_chunk=Math.max(stats.largest_chunk,size);}
        if(path.endsWith('/attachment')&&req.method==='POST')stats.attachment_posts++;
        if(path.endsWith('/messages')&&req.method==='POST')stats.message_posts++;
      });req.pipe(upstream);return;
    }
    const file=resolve(bundle,'.'+(path==='/'?'/index.html':path));
    if(!file.startsWith(resolve(bundle)+'/')){res.writeHead(404);res.end();return;}
    try{const body=await readFile(file);res.writeHead(200,{'cache-control':'no-store','content-type':({'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css'})[extname(file)]||'application/octet-stream'});res.end(body);}
    catch{res.writeHead(404);res.end();}
    }catch{if(!res.headersSent)res.writeHead(503);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return{origin:`http://127.0.0.1:${server.address().port}`,stats,setBackend:port=>backend=port,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
