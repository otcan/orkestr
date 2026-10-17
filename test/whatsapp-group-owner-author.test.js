import assert from 'node:assert/strict';
import test from 'node:test';
import {createScopedGroupTransport} from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import {createGroupOwnerAuthorPolicy} from '../packages/connectors/src/whatsapp-group-owner-author.js';
const now=Date.now(), own='15550000001@c.us', other='15550000002@c.us', group='120000000001@g.us';
const config={ownChatId:own,activatedAt:new Date(now-2000).toISOString(),groups:[{chatId:group,threadId:'test'}],additionalOwnerAuthors:{ids:[other],since:new Date(now-1000).toISOString()}};
function fixture(t) {
 const p=createScopedGroupTransport({config,token:'fake-token',base:{},dbPath:':memory:',now:()=>now});t.after(()=>p.close());
 let sends=0;const client={info:{wid:{_serialized:own}},sendMessage:async()=>{sends++;return {id:{_serialized:'echo'}};}};
 const m={id:{_serialized:'incoming',remote:group},fromMe:false,from:group,to:own,author:other,timestamp:now/1000,body:'owner question'};
 return {p,client,m,sends:()=>sends};
}
test('both owner origins use the same group and connected reply account; echo and replay suppressed',async t=>{
 const {p,client,m,sends}=fixture(t);assert.equal(await p.observe(client,m),true);assert.equal(await p.observe(client,m),false);
 const req={requestId:'reply',parentId:'incoming'};assert.equal((await p.sendText(client,group,'answer','main',req)).ok,true);
 assert.equal((await p.sendText(client,group,'answer','main',req)).duplicate,true);assert.equal(sends(),1);
 assert.equal(await p.observe(client,{...m,id:{_serialized:'echo',remote:group},fromMe:true,to:group}),false);
 assert.equal(await p.observe(client,{...m,id:{_serialized:'own',remote:group},fromMe:true,to:group}),true);
});
test('remote admission denies unknown authors, groups, old input, spoofed routing and quoted identities',async t=>{
 const {p,client,m}=fixture(t);
 for(const patch of [{author:own},{author:'15550000003@c.us'},{author:undefined,quotedAuthor:other},{fromMe:undefined},{from:'120000000002@g.us'},{id:{_serialized:'bad',remote:'120000000002@g.us'}},{timestamp:(now-1000)/1000},{timestamp:(now+10000)/1000}])assert.equal(await p.observe(client,{...m,...patch}),false);
});
test('LID requires exact provider mapping to the allowed PN; failures and mismatches denied',async t=>{
 const {p,client,m}=fixture(t);const message={...m,author:'1000000000001@lid'};
 for(const rows of [[],[{lid:'1000000000002@lid',pn:other}],[{lid:message.author,pn:own}],[{lid:message.author,pn:other},{lid:message.author,pn:own}]]){client.getContactLidAndPhone=async()=>rows;assert.equal(await p.observe(client,message),false);}
 client.getContactLidAndPhone=async()=>{throw Error('not ready')};assert.equal(await p.observe(client,message),false);
 client.getContactLidAndPhone=async()=>[{lid:message.author,pn:other}];assert.equal(await p.observe(client,message),true);
});
test('secondary owner still cannot cause a retry after uncertain delivery',async t=>{
 const {p,client,m,sends}=fixture(t);client.sendMessage=async()=>{throw Error('timeout')};await p.observe(client,m);
 await assert.rejects(p.sendText(client,group,'answer','main',{requestId:'reply',parentId:'incoming'}),/uncertain/);
 await assert.rejects(p.observe(client,{...m,id:{_serialized:'later',remote:group}}),/uncertain/);assert.equal(sends(),0);
});
test('default is own-account-only; invalid or broadened author configuration is rejected',async()=>{
 assert.equal(await createGroupOwnerAuthorPolicy({...config,additionalOwnerAuthors:undefined}).accepts({},{}),false);
 for(const rule of [{ids:[own],since:config.activatedAt},{ids:[other,own],since:config.activatedAt},{ids:['1000000000001@lid'],since:config.activatedAt},{ids:[other],since:'bad'},{ids:[other],since:'2000-01-01'},{...config.additionalOwnerAuthors,allowAll:true}])assert.throws(()=>createGroupOwnerAuthorPolicy({...config,additionalOwnerAuthors:rule}),/invalid/);
});
