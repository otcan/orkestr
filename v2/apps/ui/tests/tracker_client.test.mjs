import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trackerJournal, trackerRequest} from '../src/tracker_client.mjs';
const binding = '10000000-0000-4000-8000-000000000001';
const conversation = '20000000-0000-4000-8000-000000000001';
const key = '30000000-0000-4000-8000-000000000001';
const body = {request_key:key,expected_source_revision:1,expected_recipe:'job-tracker',expected_classifier_id:'synthetic-rules',expected_classifier_digest:'ab'.repeat(32)};
function storage() {
  const values = new Map();
  return {get length(){return values.size;},key(n){return [...values.keys()][n] ?? null;},getItem(k){return values.get(k) ?? null;},setItem(k,v){values.set(k,v);},removeItem(k){values.delete(k);}};
}
test('interrupted decision reloads exactly and cannot be silently replaced', () => {
  const local = storage();
  trackerJournal(local,binding,conversation).save('check',body);
  const restarted = trackerJournal(local,binding,conversation);
  assert.deepEqual(restarted.load(),[{kind:'check',body}]);
  assert.deepEqual(restarted.save('check',body),{kind:'check',body});
  assert.throws(() => restarted.save('check',{...body,expected_source_revision:2}),/different details/);
  assert.deepEqual(restarted.load(),[{kind:'check',body}]);
  restarted.clear(key); assert.deepEqual(restarted.load(),[]);
});
test('owner and conversation retention namespaces are isolated', () => {
  const local = storage(); trackerJournal(local,binding,conversation).save('check',body);
  assert.deepEqual(trackerJournal(local,conversation,conversation).load(),[]);
  assert.deepEqual(trackerJournal(local,binding,binding).load(),[]);
  assert.throws(() => trackerJournal(local,'',conversation),/Chat unavailable/);
});
test('paths, credentials, malformed references and missing opt-in are not journaled', () => {
  const journal = trackerJournal(storage(),binding,conversation);
  for (const invalid of [{...body,path:'/synthetic/private'},{...body,token:'never-stored'},{...body,expected_recipe:'private'},{...body,request_key:'../other'},{...body,expected_source_revision:-1}]) {
    assert.throws(() => journal.save('check',invalid),/invalid/);
  }
  assert.throws(() => journal.save('selection',{request_key:key,expected_revision:0,source:{profile:'/synthetic/private'},acknowledge_read_only_access:true}),/invalid/);
  assert.deepEqual(journal.load(),[]);
});
test('an unavailable local store refuses before a decision is sent', () => {
  const local = storage(); local.setItem = () => {throw new Error('storage unavailable');};
  assert.throws(() => trackerJournal(local,binding,conversation).save('check',body),/storage unavailable/);
});
test('a later Stop can coexist with an uncertain automation enable', () => {
  const journal = trackerJournal(storage(),binding,conversation);
  const enable = {...body,expected_revision:0,expected_timer_revision:null,calendar:{timezone:'UTC',weekdays:[],start_minute:540,end_minute:540,every_hours:1,minutes:[0]},acknowledge_automation:true};
  journal.save('automation_enable',enable);
  journal.save('automation_disable',{request_key:conversation,expected_revision:0,expected_timer_revision:null});
  assert.equal(journal.load().length,2);
  journal.clear(key); assert.equal(journal.load()[0].kind,'automation_disable');
});
test('request bridge uses same origin, cookies and CSRF; arbitrary paths refuse', async () => {
  let seen;
  const fetch = async (path, options) => {seen={path,options};return new Response('{"cancelled":true}',{status:200});};
  const path = `/api/v2/conversations/${conversation}/tracker/checks/${key}`;
  const result = await trackerRequest({method:'DELETE',path,csrf:'synthetic-csrf',body:null},fetch);
  assert.equal(result.body.cancelled,true);assert.equal(seen.options.credentials,'same-origin');
  assert.equal(seen.options.headers['x-orkestr-csrf'],'synthetic-csrf');
  for (const wrong of ['https://outside.example/','/api/v2/messages',`/api/v2/conversations/${conversation}/tracker/grant`]) {
    await assert.rejects(trackerRequest({method:'POST',path:wrong,csrf:'x',body:{}},fetch),/unavailable/);
  }
  await assert.rejects(trackerRequest({method:'DELETE',path,csrf:'',body:null},fetch),/Sign in/);
});
test('reader errors preserve status and oversized or interrupted replies refuse', async () => {
  const input = {method:'GET',path:`/api/v2/conversations/${conversation}/tracker/mail-status`};
  const result = await trackerRequest(input,async () => new Response('{"message":"Sign in"}',{status:401}));
  assert.equal(result.status,401);
  await assert.rejects(trackerRequest(input,async () => new Response('{truncated')),/interrupted/);
  await assert.rejects(trackerRequest(input,async () => new Response('x'.repeat(4*1024*1024+1))),/display limit/);
});
