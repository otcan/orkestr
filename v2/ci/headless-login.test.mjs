import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitLogin } from './headless-login.mjs';
function fixture(status = 200) {
  const pending = [];
  const calls = [];
  const page = {
    waitForResponse(predicate, options) { assert.equal(options.timeout,10000); return new Promise(resolve => pending.push({predicate,resolve})); },
    async waitForFunction(_fn, options) { assert.equal(options.timeout,10000); calls.push('transition'); },
    browser() { return { cookies: async () => { calls.push('cookie'); return [{name:'orkestr_v2_session',httpOnly:true,sameSite:'Strict'}]; } }; },
  };
  const click = async () => {
    calls.push('click');
    assert.ok(pending.length > 0, 'waiters were not registered before click');
    for (const [path,code] of [['/api/v2/setup',201],['/api/v2/browser/session',status]]) {
      const reply = {url:()=>`http://synthetic${path}`, request:()=>({method:()=> 'POST'}), status:()=>code};
      for(const item of pending) if(item.predicate(reply)) item.resolve(reply);
    }
  };
  return {page,click,calls,pending};
}
test('setup registers setup and login before click, then joins UI and cookie',async()=>{
  const f=fixture(); await submitLogin(f.page,'http://synthetic',f.click,true);
  assert.equal(f.pending.length,2); assert.deepEqual(f.calls,['click','transition','cookie']);
});
test('fresh login waits one exact response and refuses 401 without transition',async()=>{
  const f=fixture(401); await assert.rejects(submitLogin(f.page,'http://synthetic',f.click));
  assert.equal(f.pending.length,1); assert.deepEqual(f.calls,['click']);
});
