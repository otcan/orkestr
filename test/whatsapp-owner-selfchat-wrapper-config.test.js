import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { ownerSelfChatWrapperEnvironment, assertOwnerSelfChatWrapperEnvironment } from '../packages/connectors/src/whatsapp-owner-selfchat-wrapper-config.js';
import { createOwnerSelfChatWrapper } from '../packages/connectors/src/whatsapp-owner-selfchat-wrapper.js';
import { selfChatHash } from '../packages/connectors/src/whatsapp-owner-selfchat-journal.js';

const invocation='a'.repeat(32),runtimeId=`example.service:42:${invocation}`;
function fixture() {
  const wrapperEnvironment={WA_EXAMPLE_STATE_DIR:'/protected/state',WA_EXAMPLE_SESSION_DIR:'/protected/session',
    WA_EXAMPLE_TOKEN_FILE:'/protected/tokens/existing-token',WA_EXAMPLE_HOST:'127.0.0.1',WA_EXAMPLE_PORT:'18749'};
  return {wrapperPath:'/protected/wrapper.mjs',implementationPaths:['/protected/bridge.mjs'],
    requiredDirectories:['/protected/state','/protected/session','/protected/tokens'],
    requiredFiles:['/protected/tokens/existing-token'],existingService:'example.service',wrapperEnvironmentPrefix:'WA_EXAMPLE_',wrapperEnvironment,
    verifiedWrapperEnvironment:{runtimeId,environmentHash:selfChatHash(wrapperEnvironment)}};
}

function mockPaths(t, deniedPath='', extraFiles=[]) {
  const files=new Set(['/protected/wrapper.mjs','/protected/bridge.mjs','/protected/tokens/existing-token','/usr/bin/node',...extraFiles]);
  t.mock.method(fs,'lstat',async filename=>({uid:filename===deniedPath?1000:0,mode:files.has(filename)?0o100600:0o40700,
    size:1,isSymbolicLink:()=>false,isDirectory:()=>!files.has(filename),isFile:()=>files.has(filename)}));
}

test('wrapper requires every explicit account selector and never falls back to defaults',()=>{
  const valid=fixture();assert.deepEqual(ownerSelfChatWrapperEnvironment(valid),valid.wrapperEnvironment);
  for(const key of Object.keys(valid.wrapperEnvironment)) {
    const config=fixture();delete config.wrapperEnvironment[key];
    assert.throws(()=>createOwnerSelfChatWrapper(config),/wrapper_environment_required/);
  }
  const missing=fixture();delete missing.wrapperEnvironment;
  assert.throws(()=>createOwnerSelfChatWrapper(missing),/wrapper_environment_required/);
});

test('wrapper requires a bounded explicit prefix and exactly its own selector keys',()=>{
  for(const prefix of [undefined,null,123,'','WA_','EXAMPLE_','wa_example_','WA_EXAMPLE','WA_EXAMPLE_\n','WA_X;_','WA_'+ 'X'.repeat(65)+'_']) {
    const config=fixture();config.wrapperEnvironmentPrefix=prefix;
    assert.throws(()=>createOwnerSelfChatWrapper(config),/wrapper_environment_prefix_required/);
  }
  const mismatched=fixture();mismatched.wrapperEnvironmentPrefix='WA_OTHER_';
  assert.throws(()=>createOwnerSelfChatWrapper(mismatched),/wrapper_environment_required/);
  const alternate=fixture();alternate.wrapperEnvironmentPrefix='WA_OTHER_';
  alternate.wrapperEnvironment=Object.fromEntries(Object.entries(alternate.wrapperEnvironment).map(([key,value])=>[key.replace('WA_EXAMPLE_','WA_OTHER_'),value]));
  const env=ownerSelfChatWrapperEnvironment(alternate);
  assert.throws(()=>assertOwnerSelfChatWrapperEnvironment(alternate,env,runtimeId),/environment_unverified/);
});

test('arbitrary environment, aliases, executable injection and invalid selectors are refused',()=>{
  for(const key of ['NODE_OPTIONS','LD_PRELOAD','PATH','WA_HTTP_TOKEN','WA_OTHER_PORT','WA_EXAMPLE_ROOT','WA_EXAMPLE_PHONE_NUMBER']) {
    const config=fixture();config.wrapperEnvironment[key]='untrusted';
    assert.throws(()=>createOwnerSelfChatWrapper(config),/wrapper_environment_required/);
  }
  for(const [key,value] of [
    ['WA_EXAMPLE_STATE_DIR','relative'],['WA_EXAMPLE_STATE_DIR','/protected/../other'],
    ['WA_EXAMPLE_SESSION_DIR','/protected/session\nNODE_OPTIONS=bad'],
    ['WA_EXAMPLE_TOKEN_FILE','/protected/token\0suffix'],['WA_EXAMPLE_HOST','localhost'],
    ['WA_EXAMPLE_HOST','203.0.113.1'],['WA_EXAMPLE_PORT','18749; touch /tmp/no'],
    ['WA_EXAMPLE_PORT','0'],['WA_EXAMPLE_PORT','65536'],['WA_EXAMPLE_PORT',18749],
  ]) {
    const config=fixture();config.wrapperEnvironment[key]=value;
    assert.throws(()=>createOwnerSelfChatWrapper(config),/wrapper_(environment|endpoint)_invalid/);
  }
});

test('selected account paths must agree with preflight references',()=>{
  for(const key of ['WA_EXAMPLE_STATE_DIR','WA_EXAMPLE_SESSION_DIR','WA_EXAMPLE_TOKEN_FILE']) {
    const config=fixture();config.wrapperEnvironment[key]='/protected/different';
    assert.throws(()=>createOwnerSelfChatWrapper(config),/environment_path_mismatch/);
  }
});

test('environment attestation rejects runtime or selector hash changes',()=>{
  const config=fixture(),env=ownerSelfChatWrapperEnvironment(config);
  assert.doesNotThrow(()=>assertOwnerSelfChatWrapperEnvironment(config,env,runtimeId));
  assert.throws(()=>assertOwnerSelfChatWrapperEnvironment(config,env,'example.service:43:'+invocation),/environment_unverified/);
  assert.throws(()=>assertOwnerSelfChatWrapperEnvironment(config,{...env,WA_EXAMPLE_PORT:'18750'},runtimeId),/environment_unverified/);
  assert.throws(()=>assertOwnerSelfChatWrapperEnvironment({...config,verifiedWrapperEnvironment:null},env,runtimeId),/environment_unverified/);
});

test('wrapper executes pinned Node and captured exact selectors, without process environment inheritance',async t=>{
  mockPaths(t);const config=fixture(),original={...config.wrapperEnvironment},calls=[];
  const previous=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='--require /mock/must-not-inherit';
  t.after(()=>{if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;});
  const runner=createOwnerSelfChatWrapper(config,async(command,args,options)=>{
    calls.push({command,args,options});
    return {stdout:command==='/usr/bin/systemctl'?`ActiveState=active\nMainPID=42\nInvocationID=${invocation}\n`:'{"ok":true}'};
  });
  config.wrapperEnvironment.WA_EXAMPLE_PORT='18750';
  const text='literal $(not-a-command) `not-a-command`';
  await runner.invoke(['send-text','15550000001@c.us',text],{runtimeId});
  assert.equal(calls.length,2);assert.equal(calls[0].command,'/usr/bin/systemctl');
  assert.deepEqual(calls[0].options.env,{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'});
  assert.equal(calls[1].command,'/usr/bin/node');
  assert.deepEqual(calls[1].args,['/protected/wrapper.mjs','send-text','15550000001@c.us',text]);
  assert.deepEqual(calls[1].options.env,{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',...original});
  assert.equal(calls[1].options.shell,undefined);
});

test('changed runtime attestation prevents wrapper dispatch',async t=>{
  mockPaths(t);const config=fixture(),calls=[];
  const runner=createOwnerSelfChatWrapper(config,async command=>{
    calls.push(command);return {stdout:`ActiveState=active\nMainPID=43\nInvocationID=${invocation}\n`};
  });
  await assert.rejects(runner.invoke(['status'],{runtimeId}),/environment_unverified/);
  assert.deepEqual(calls,['/usr/bin/systemctl']);
});

test('unprotected executable ancestry prevents even systemctl or wrapper invocation',async t=>{
  mockPaths(t,'/protected');let called=false;
  const runner=createOwnerSelfChatWrapper(fixture(),async()=>{called=true;throw new Error('must not execute');});
  await assert.rejects(runner.invoke(['status'],{runtimeId}),/operator_path_not_protected/);
  assert.equal(called,false);
});

test('root-owned runtime leaf below a nonroot ancestor is insufficient',async t=>{
  mockPaths(t,'/untrusted/ancestor');const config=fixture();let called=false;
  config.wrapperEnvironment.WA_EXAMPLE_STATE_DIR='/untrusted/ancestor/state';
  config.requiredDirectories[0]='/untrusted/ancestor/state';
  config.verifiedWrapperEnvironment.environmentHash=selfChatHash(config.wrapperEnvironment);
  const runner=createOwnerSelfChatWrapper(config,async()=>{called=true;throw new Error('must not execute');});
  await assert.rejects(runner.invoke(['status'],{runtimeId}),/operator_path_not_protected/);
  assert.equal(called,false);
});

test('required root-owned file is refused when an ancestor is replaceable',async t=>{
  const filename='/untrusted/ancestor/required-file';mockPaths(t,'/untrusted/ancestor',[filename]);
  const config=fixture();config.requiredFiles.push(filename);let called=false;
  const runner=createOwnerSelfChatWrapper(config,async()=>{called=true;throw new Error('must not execute');});
  await assert.rejects(runner.invoke(['status'],{runtimeId}),/operator_path_not_protected/);
  assert.equal(called,false);
});
