import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedConversation,conversationFragment,selectedV1Link,keepsFragment} from '../src/selected_conversation.mjs';
const id='00000000-0000-4000-8000-00000000000a';
test('only an exact canonical conversation presentation pointer survives reload',()=>{
 assert.equal(selectedConversation(`#conversation/${id.toUpperCase()}`),id);
 assert.equal(conversationFragment(id),`#conversation/${id}`);
 assert.equal(selectedConversation(`#conversation/${id}/timers`),id);
 assert.equal(selectedConversation(`#conversation/${id}/tracker`),id);
 assert.equal(keepsFragment(`#conversation/${id}/tracker`,id),true);
 for(const hash of ['',`#conversation/${id}/extra`,`#conversation/${id}/host`,`#conversation/${id}?owner=x`,`#conversation/%30${id.slice(1)}`,'#conversation/00000000-0000-0000-0000-000000000000','https://elsewhere.invalid/#conversation/'+id]) assert.equal(selectedConversation(hash),null);
});
test('old V1 deep links are read only in their exact redirected form',()=>{
 const ins='ins_AAAAAAAAAAAAAAAAAAAAAA', thr='thr_AAAAAAAAAAAAAAAAAAAAAQ';
 assert.deepEqual(selectedV1Link(`#v1-link/${ins}/${thr}`),[ins,thr]);
 for(const hash of ['',`#v1-link/${thr}`,`#v1-link/${ins}/${thr}/x`,`#v1-link/${ins}/thr_short`,`#v1-link/${ins}/${thr}?x=1`,`#conversation/${id}`]) assert.equal(selectedV1Link(hash),null);
});
test('fragment construction refuses arbitrary navigation and empty identity',()=>{
 for(const input of ['',null,'../admin',id+'?x=1']) assert.throws(()=>conversationFragment(input));
});
test('host, V1 and tab fragments survive reselecting the same conversation',()=>{
 for(const hash of ['#host','#host/details?range=24h','#v1/group-a',`#conversation/${id}/timers`]) assert.equal(keepsFragment(hash,id),true,hash);
 for(const hash of ['',`#conversation/${id}`,`#conversation/00000000-0000-4000-8000-00000000000b/timers`,'#hostile']) assert.equal(keepsFragment(hash,id),false,hash);
});
