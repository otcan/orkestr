import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Candidate} from './history-support.mjs';

test('foreign health listener cannot authorize child that fails bind', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'candidate-collision-'));let requests=0,candidate;
 const server=http.createServer((_,res)=>{requests++;res.end(JSON.stringify({product:'orkestr-v2',fixture_mode:false}));});
 try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const file=path.join(root,'child');
  await fs.writeFile(file,'#!/usr/bin/node\nconst net=require("node:net");setTimeout(()=>{const s=net.createServer();s.on("error",()=>process.exit(43));s.listen(Number(process.env.ORKESTR_V2_BIND.split(":").pop()),"127.0.0.1");},100);\n',{mode:0o700});
  candidate=new Candidate({server:{path:file},ui:{path:root}},root,server.address().port);
  await assert.rejects(candidate.start());assert.equal(requests,0);
 } finally {await candidate?.stop();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
});

test('child post-bind marker permits owned health and joined shutdown', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'candidate-owned-'));let candidate;
 const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 try {
  const file=path.join(root,'child');
  await fs.writeFile(file,'#!/usr/bin/node\nconst http=require("node:http");const s=http.createServer((_,r)=>r.end(JSON.stringify({product:"orkestr-v2",fixture_mode:false})));s.listen(Number(process.env.ORKESTR_V2_BIND.split(":").pop()),"127.0.0.1",()=>console.error(`orkestr-v2-server schema=1 home=${process.env.ORKESTR_V2_HOME} bind=${process.env.ORKESTR_V2_BIND} execution=disabled connections=none`));\n',{mode:0o700});
  candidate=new Candidate({server:{path:file},ui:{path:root}},root,port);await candidate.start();assert(candidate.child);await candidate.stop();assert.equal(candidate.child,null);
 } finally {await candidate?.stop();await fs.rm(root,{recursive:true,force:true});}
});
