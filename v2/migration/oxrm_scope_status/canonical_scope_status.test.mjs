import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopeStatus, SCOPE_STATUS_PATH } from './canonical_scope_status.ts';
const pair = Object.freeze({outreachWorkspaceId: 'workspace-example', linkedinAccountAlias: 'account-example'});
const other = Object.freeze({outreachWorkspaceId: 'workspace-other', linkedinAccountAlias: 'account-other'});
const request = (scope = pair) => ({method:'GET',url: `${SCOPE_STATUS_PATH}?${new URLSearchParams(scope)}`});
const principal = (scope=pair, subject='subject-example') => ({subject, scope, canReadScopeStatus:true});
const create = (authenticate=async()=>principal(), configuredScope=pair, serviceSurface={}) =>
  createScopeStatus({authenticate, configuredScope, serviceSurface});

test('exact scope and callable source coverage, zero operational calls',async()=>{
  let calls=0;
  const trap=()=>{calls++;throw Error('must not invoke');};
  const result=await create(async()=>principal(),pair,{
    claimOutreachRecipients:trap,recordOutreachEvent:trap,listXrmRecords:trap,
  })(request());
  assert.equal(result.statusCode,200);
  assert.deepEqual(result.body.scope,pair);
  assert.equal(result.body.workflow_ready,false);
  assert.equal(result.body.activity_proven,false);
  for(const v of Object.values(result.body.coverage.capabilities)){
    assert.equal(v.availability,'callable_surface_present');
    assert.equal(v.behavioral_assurance,'not_exercised');
  }
  assert.equal(calls,0);
  assert.equal(result.headers['cache-control'],'no-store');
});
test('foreign request or authenticated scope refuses, no global fallback',async()=>{
  assert.equal((await create()(request(other))).statusCode,403);
  assert.equal((await create(async()=>principal(other))(request())).statusCode,403);
  assert.equal((await create(async()=>null)(request())).statusCode,401);
  assert.equal((await create(async()=>({...principal(),canReadScopeStatus:false}))(request())).statusCode,401);
});
test('missing and partial configuration is unresolved, not absent',async()=>{
  for(const config of [undefined,{}, {outreachWorkspaceId:'workspace-example'}]){
    const handler=createScopeStatus({authenticate:async()=>principal(),configuredScope:config,serviceSurface:{}});
    assert.equal((await handler(request())).body.error,'scope_not_configured');
  }
});
test('current caller rechecked and change/logout/revoke/exception refuses',async()=>{
  for(const [second,status] of [[null,401],[principal(other),403],[principal(pair,'changed'),403]]){
    const values=[principal(),second];
    const result=await create(async()=>values.shift())(request());
    assert.equal(result.statusCode,status);
    assert.equal(result.body.scope,undefined);
  }
  for(const failAt of [1,2]){
    let calls=0;
    const result=await create(async()=>{if(++calls===failAt)throw Error('private detail');return principal();})(request());
    assert.equal(result.body.error,'authority_unavailable');
    assert.equal(JSON.stringify(result).includes('private detail'),false);
  }
});
test('strict route/query/method/body, no client principal',async()=>{
  for(const url of [SCOPE_STATUS_PATH,`${SCOPE_STATUS_PATH}?outreachWorkspaceId=x`,
    `${request().url}&outreachWorkspaceId=x`,`${request().url}&owner=foreign`,
    `${SCOPE_STATUS_PATH}?outreachWorkspaceId=x&linkedinAccountAlias=%00`,
    '//foreign.example.invalid/status', 'https://foreign.example.invalid/status']){
    assert.notEqual((await create()({method:'GET',url})).statusCode,200);
  }
  assert.equal((await create()({...request(),method:'POST'})).statusCode,405);
  assert.equal((await create()({...request(),body:{principal:principal()}})).statusCode,400);
});
test('accessor and inherited methods not evaluated or treated as supported',async()=>{
  const surface=Object.create({claimOutreachRecipients(){throw Error('must not invoke');}});
  Object.defineProperty(surface,'recordOutreachEvent',{get(){throw Error('must not evaluate');}});
  const result=await create(async()=>principal(),pair,surface)(request());
  for(const v of Object.values(result.body.coverage.capabilities))assert.equal(v.availability,'not_observed');
});
test('configuration and principal snapshots immutable across checks',async()=>{
  const mutable={...pair};let calls=0;
  const handler=create(async()=>{calls++;if(calls===2)mutable.outreachWorkspaceId='changed';return principal();},mutable);
  const result=await handler(request());
  assert.equal(result.statusCode,200);
  assert.deepEqual(result.body.scope,pair);
});
test('mandatory auth seam has no anonymous or host-operator default',()=>{
  assert.throws(()=>createScopeStatus({configuredScope:pair,serviceSurface:{}}),/explicit_status_authority_required/);
});
