import assert from 'node:assert/strict';
import test from 'node:test';
import {delegateCommand, runDelegateCli} from '../scripts/whatsapp-delegate-cli.mjs';

test('delegate CLI maps reactions and scoped reads to explicit endpoints', () => {
  assert.deepEqual(delegateCommand(['react','15550000002@c.us','false_15550000002@c.us_ABC','👍','--request-id','op1']), {
    method:'POST',path:'/delegate/react',body:{to:'15550000002@c.us',messageId:'false_15550000002@c.us_ABC',emoji:'👍',requestId:'op1'}});
  assert.equal(delegateCommand(['read','15550000002@c.us','--limit','10']).path,'/delegate/chats/15550000002%40c.us/messages?limit=10');
  assert.equal(delegateCommand(['chats','--unread']).path,'/delegate/chats?unread_only=1');
  assert.equal(delegateCommand(['reactions','--state','uncertain']).path,'/delegate/reactions?state=uncertain');
  for(const args of [['react','chat','msg','👍'],['health','extra'],['health','--state','x'],['react','chat','msg','👍','--request-id','a','--request-id','b']])
    assert.throws(()=>delegateCommand(args));
});

test('CLI requires loopback, never follows redirects, and hides credential errors', async () => {
  let reads=0,calls=0,output='';
  const env={ORKESTR_WA_DELEGATE_URL:'http://127.0.0.1:18400',ORKESTR_WA_DELEGATE_TOKEN_FILE:'/fake/delegate.token'};
  const readFile=async()=>{reads++;return 'fixture-delegate-secret';};
  const fetchImpl=async(_url,options)=>{calls++;assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer fixture-delegate-secret');return {ok:true,json:async()=>({ok:true,reactionRead:true})};};
  const run=overrides=>runDelegateCli({args:['health'],env,readFile,fetchImpl,write:text=>{output+=text;},...overrides});
  assert.equal(await run(),0);assert.equal(reads,1);assert.equal(calls,1);assert.equal(output.includes('fixture-delegate-secret'),false);
  assert.equal(await run({env:{...env,ORKESTR_WA_DELEGATE_URL:'http://example.invalid'}}),1);
  assert.equal(reads,1);assert.equal(calls,1);
  output='';assert.equal(await run({readFile:async()=>{throw Error('fixture-delegate-secret');}}),1);
  assert.equal(output.includes('fixture-delegate-secret'),false);assert.equal(JSON.parse(output).error,'delegate_cli_credential_unavailable');
});
