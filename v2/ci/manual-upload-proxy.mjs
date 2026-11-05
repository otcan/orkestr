// Isolated representative streaming reverse proxy, not production configuration.
import {createServer,request} from 'node:http';
export async function uploadProxy(moduleSource){
  let backend=0;
  const stats={max_body_bytes:1_114_112,request_timeout_ms:1_200_000,chunk_requests:0,chunk_bytes:0,largest_chunk:0,body_rejections:0};
  const server=createServer((req,res)=>{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    if(path==='/'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});return res.end('<!doctype html><title>Isolated upload acceptance</title><input id="file" type="file"><script type="module">window.uploadModule=await import("/manual-upload.js");window.ready=true;</script>');}
    if(path==='/manual-upload.js'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});return res.end(moduleSource);}
    if(!path.startsWith('/api/v2/')||!backend){res.writeHead(404);return res.end();}
    const chunk=/\/encrypted-uploads\/[^/]+\/chunks\/\d+$/.test(path)&&req.method==='PUT';
    const declared=Number(req.headers['content-length']||0);
    if(declared>stats.max_body_bytes){stats.body_rejections++;res.writeHead(413);req.resume();return res.end();}
    const upstream=request({host:'127.0.0.1',port:backend,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
    upstream.setTimeout(stats.request_timeout_ms,()=>upstream.destroy(Error('proxy_timeout')));
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    let size=0;
    req.on('data',data=>{size+=data.length;if(size>stats.max_body_bytes){stats.body_rejections++;upstream.destroy();if(!res.headersSent)res.writeHead(413);res.end();req.destroy();}});
    req.on('end',()=>{if(chunk){stats.chunk_requests++;stats.chunk_bytes+=size;stats.largest_chunk=Math.max(stats.largest_chunk,size);}});
    req.pipe(upstream);
  });
  server.requestTimeout=stats.request_timeout_ms;server.headersTimeout=30_000;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return{origin:`http://127.0.0.1:${server.address().port}`,stats,setBackend:port=>backend=port,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
