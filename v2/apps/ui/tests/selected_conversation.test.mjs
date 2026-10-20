import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedConversation,conversationFragment} from '../src/selected_conversation.mjs';
const id='00000000-0000-4000-8000-00000000000a';
test('only an exact canonical conversation presentation pointer survives reload',()=>{
 assert.equal(selectedConversation(`#conversation/${id.toUpperCase()}`),id);
 assert.equal(conversationFragment(id),`#conversation/${id}`);
 for(const hash of ['',`#conversation/${id}/extra`,`#conversation/${id}?owner=x`,`#conversation/%30${id.slice(1)}`,'#conversation/00000000-0000-0000-0000-000000000000','https://elsewhere.invalid/#conversation/'+id]) assert.equal(selectedConversation(hash),null);
});
test('fragment construction refuses arbitrary navigation and empty identity',()=>{
 for(const input of ['',null,'../admin',id+'?x=1']) assert.throws(()=>conversationFragment(input));
});
