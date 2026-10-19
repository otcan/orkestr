import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerScopeStatus } from './fastify_scope_status.ts';
const scope = { outreachWorkspaceId: 'workspace-demo', linkedinAccountAlias: 'account-demo' };
const principal = { subject: 'caller-demo', scope, canReadScopeStatus: true };
const url = '/status/linkedin-outreach?outreachWorkspaceId=workspace-demo&linkedinAccountAlias=account-demo';
async function run(verifier, options = {}) {
  const app = Fastify();
  registerScopeStatus(app, { configuredScope: scope, serviceSurface: {} }, verifier);
  try { return await app.inject({ method: 'GET', url, ...options }); }
  finally { await app.close(); }
}
test('original Fastify request retained across both current checks', async () => {
  const seen = [];
  const response = await run(async request => { seen.push(request); return principal; });
  assert.equal(response.statusCode, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(seen[0].raw.url, url);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.json().workflow_ready, false);
});
test('claimed headers never supply a principal', async () => {
  const response = await run(async () => null, { headers: { authorization: 'Bearer fake', 'x-owner': 'caller-demo' } });
  assert.equal(response.statusCode, 401);
});
test('foreign scope refused', async () => {
  assert.equal((await run(async () => ({ ...principal, scope: { ...scope, linkedinAccountAlias: 'foreign-demo' } }))).statusCode, 403);
});
test('logout/revocation on delivery check refused', async () => {
  let count = 0;
  assert.equal((await run(async () => ++count === 1 ? principal : null)).statusCode, 401);
});
test('changed caller and failed authority refused', async () => {
  let count = 0;
  assert.equal((await run(async () => ({ ...principal, subject: ++count === 1 ? 'caller-demo' : 'other-demo' }))).statusCode, 403);
  assert.equal((await run(async () => { throw Error('unavailable'); })).statusCode, 503);
});
