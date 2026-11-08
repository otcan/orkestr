// Synthetic front proxy for browser acceptance only. Production publication,
// filesystem custody and CAS belong to the separate private operator profile.
import {createServer,request} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {sha} from '../apps/ui/scripts/release_contract.mjs';

export const latch=()=>{let release;const promise=new Promise(resolve=>release=resolve);return{promise,release};};
const CSP="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'";
export async function proxyFixture(apiOrigin,snapshots){
  const assets=new Map(),bootstrap=new Map();
  const asset=(data,type)=>({data,type,gzip:gzipSync(data)});
  for(const {directory,manifest,plan}of snapshots){
    bootstrap.set(plan.release_id,asset(await readFile(join(directory,'index.html')),'text/html; charset=utf-8'));
    for(const [name,pin]of Object.entries(manifest.assets))assets.set(plan.asset_prefix+name,asset(await readFile(join(directory,'_ui',plan.release_id,name)),pin.content_type));
  }
  const state={active:snapshots[0].plan.release_id,requests:[],responses:[],mainHold:null,chunkHold:null};
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://example.test').pathname;
    state.requests.push({path,method:req.method,cookie:req.headers.cookie,csrf:req.headers['x-orkestr-csrf']});
    // The production profile must preserve this separation, including old
    // root helper URLs. No API path is resolved against a static filesystem.
    if(path==='/api'||path.startsWith('/api/')||!['/','/index.html'].includes(path)&&!path.startsWith('/_ui/')){
      const remote=request(new URL(req.url,apiOrigin),{method:req.method,headers:req.headers},async response=>{
        const hold=state.chunkHold;
        if(hold&&req.method==='PUT'&&path.includes('/encrypted-uploads/')){
          state.chunkHold=null;hold.seen.release();await hold.resume.promise;
        }
        res.writeHead(response.statusCode,response.headers);response.pipe(res);
      });
      remote.on('error',()=>{res.writeHead(502);res.end();});req.pipe(remote);return;
    }
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{allow:'GET, HEAD'});res.end();return;}
    if(/[%\\]/.test(path)||path.split('/').some(part=>part==='.'||part==='..')){res.writeHead(404);res.end();return;}
    const item=['/','/index.html'].includes(path)?bootstrap.get(state.active):assets.get(path);
    if(!item){res.writeHead(404);res.end();return;}
    const hold=state.mainHold;
    if(hold&&path===hold.path){state.mainHold=null;hold.seen.release();await hold.resume.promise;}
    const gzip=/\bgzip\b/.test(req.headers['accept-encoding']||''),data=gzip?item.gzip:item.data,etag=`"${sha(data)}"`;
    const notModified=req.headers['if-none-match']===etag;
    state.responses.push({path,active:state.active});
    res.writeHead(notModified?304:200,{'content-type':item.type,'content-length':data.length,etag,vary:'accept-encoding',
      ...(gzip?{'content-encoding':'gzip'}:{}),'x-content-type-options':'nosniff','content-security-policy':CSP,
      'cache-control':path.startsWith('/_ui/')?'public, max-age=31536000, immutable':'public, no-cache'});
    res.end(notModified||req.method==='HEAD'?undefined:data);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,state,origin:`http://127.0.0.1:${server.address().port}`};
}
