import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/memory_export.js',import.meta.url),'utf8');
const {offerMemoryExport}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function fixture(fail=false){const log=[];let blob;return {log,get blob(){return blob},env:{Blob,URL:{createObjectURL(b){blob=b;log.push('create');return 'blob:synthetic'},revokeObjectURL(u){log.push(['revoke',u])}},document:{body:{append(){log.push('append')}},createElement(){return {click(){log.push('click');if(fail)throw Error('blocked')},remove(){log.push('remove')}}}},setTimeout(fn,ms){assert.equal(ms,1000);fn()}}};}
test('export preserves exact integer bytes and separate file cleanup',async()=>{const f=fixture();const raw='{"records":[],"synthetic_revision":9007199254740993}';offerMemoryExport(raw,f.env,()=>true);assert.equal(await f.blob.text(),raw);assert.deepEqual(f.log,['create','append','click','remove',['revoke','blob:synthetic']]);});
test('failed file offer still removes link and revokes owned URL',()=>{const f=fixture(true);assert.throws(()=>offerMemoryExport('{}',f.env,()=>true),/blocked/);assert.deepEqual(f.log.slice(-2),['remove',['revoke','blob:synthetic']]);});
test('export byte cap refuses before Blob or DOM allocation',()=>{const f=fixture();assert.throws(()=>offerMemoryExport('é'.repeat(4194305),f.env,()=>true),/too large/);assert.deepEqual(f.log,[]);});

for (const reason of ['logout','drop']) {
 test(`delayed export after ${reason} refuses before private byte allocation`,async()=>{
  const f=fixture();let current=true;
  const delayed=Promise.resolve().then(()=>offerMemoryExport('{"records":[]}',f.env,()=>current));
  current=false;
  await assert.rejects(delayed,/retired/);assert.deepEqual(f.log,[]);
 });
}
test('authority loss at final action removes owned link without click',()=>{
 const f=fixture();let checks=0;
 assert.throws(()=>offerMemoryExport('{}',f.env,()=>++checks===1),/retired/);
 assert.equal(f.log.includes('click'),false);
 assert.deepEqual(f.log.slice(-2),['remove',['revoke','blob:synthetic']]);
});
