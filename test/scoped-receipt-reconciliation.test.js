import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {acceptedReceipt,reconcileAcceptedReceipt} from '../scripts/lib/scoped-receipt-reconciliation.mjs';
const now = Date.parse('2026-01-01T12:00:30Z');
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const row = {id:'reply:one',chat_id:'123@g.us',parent_id:'input-one',hash:hash(['123@g.us','answer','input-one']),state:'uncertain',created_at:'2026-01-01T12:00:00.500Z'};
const evidence = () => ({checkedAt:new Date(now).toISOString(),chatId:row.chat_id,authenticated:true,ready:true,messages:[{id:'true_123@g.us_RECEIPT',to:row.chat_id,fromMe:true,body:'answer',timestamp:'2026-01-01T12:00:00Z'}]});
test('exact provider history matches subsecond attempt, with no send',()=>assert.equal(acceptedReceipt(row,evidence(),now),'true_123@g.us_RECEIPT'));
for (const [name,modify] of Object.entries({stale:e=>e.checkedAt='2025-01-01',wrongChat:e=>e.chatId='999@g.us',unready:e=>e.ready=false,unauthenticated:e=>e.authenticated=false,inbound:e=>e.messages[0].fromMe=false,wrongRecipient:e=>e.messages[0].to='999@g.us',wrongId:e=>e.messages[0].id='summary:fake',wrongText:e=>e.messages[0].body='other',oldReply:e=>e.messages[0].timestamp='2026-01-01T11:59:59Z',absent:e=>e.messages=[],ambiguous:e=>e.messages.push({...e.messages[0],id:'true_123@g.us_OTHER'})})) {
 test(`rejects ${name}`,()=>{const e=evidence();modify(e);assert.throws(()=>acceptedReceipt(row,e,now));});
}
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const dbPath=path.join(dir,'transport.sqlite'),fencePath=path.join(dir,'fence.sqlite');
 const db=new DatabaseSync(dbPath); db.exec('CREATE TABLE group_send(id TEXT PRIMARY KEY,chat_id TEXT,parent_id TEXT,hash TEXT,state TEXT,created_at TEXT,provider_id TEXT)');
 db.prepare('INSERT INTO group_send VALUES(?,?,?,?,?,?,NULL)').run(...['id','chat_id','parent_id','hash','state','created_at'].map(k=>row[k]));db.close();
 const f=new DatabaseSync(fencePath);f.exec("CREATE TABLE delivery_route(id INTEGER,route TEXT,epoch INTEGER); INSERT INTO delivery_route VALUES(1,'route-one',1); CREATE TABLE delivery_attempt(id TEXT PRIMARY KEY,hash TEXT,route TEXT,epoch INTEGER,state TEXT,provider_id TEXT)");
 f.prepare("INSERT INTO delivery_attempt VALUES(?,?,'route-one',1,'uncertain',NULL)").run(row.id,row.hash);f.close();
 return {dbPath,fencePath,routeId:'route-one',requestId:row.id,evidence:evidence(),now};
}
test('dry run does not clear hold; apply preserves audit; repeat is idempotent',t=>{
 const o=fixture(t);assert.equal(reconcileAcceptedReceipt(o).changed,false);
 const db=new DatabaseSync(o.dbPath);assert.equal(db.prepare('SELECT state FROM group_send').get().state,'uncertain');
 assert.equal(reconcileAcceptedReceipt({...o,apply:true}).changed,true);
 assert.equal(reconcileAcceptedReceipt({...o,apply:true}).changed,false);
 assert.equal(db.prepare('SELECT count(*) n FROM receipt_reconciliation').get().n,1);
 assert.equal(db.prepare('SELECT state FROM group_send').get().state,'sent');db.close();
});
test('wrong fence leaves transport uncertain and preserves journal',t=>{
 const o=fixture(t);assert.throws(()=>reconcileAcceptedReceipt({...o,routeId:'wrong',apply:true}));
 const db=new DatabaseSync(o.dbPath);assert.equal(db.prepare('SELECT state FROM group_send').get().state,'uncertain');db.close();
});
test('already accepted provider ID cannot be reused for another request',t=>{
 const o=fixture(t),db=new DatabaseSync(o.dbPath);
 db.prepare("INSERT INTO group_send VALUES('other','123@g.us','other','other','sent',?,?)").run(row.created_at,evidence().messages[0].id);
 assert.throws(()=>reconcileAcceptedReceipt({...o,apply:true}),/receipt_reused/);db.close();
});
test('matching partial reconciliation is recoverable, mismatched receipt is not',t=>{
 const o=fixture(t),f=new DatabaseSync(o.fencePath);f.prepare("UPDATE delivery_attempt SET state='sent',provider_id=?").run(evidence().messages[0].id);
 assert.equal(reconcileAcceptedReceipt({...o,apply:true}).changed,true);f.close();
});
test('mismatched partial receipt cannot clear either journal',t=>{
 const o=fixture(t),f=new DatabaseSync(o.fencePath);f.prepare("UPDATE delivery_attempt SET state='sent',provider_id='wrong'").run();
 assert.throws(()=>reconcileAcceptedReceipt({...o,apply:true}),/fence_conflict/);f.close();
});
