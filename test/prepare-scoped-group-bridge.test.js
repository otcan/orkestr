import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test from 'node:test';

test('prepared standalone group bridge includes its complete transport import graph', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prepared-group-bridge-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'scripts'));
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({type:'module'}));
  // A synthetic preserving bridge exposes only the patcher's documented seams.
  // No browser, service, profile or connector is initialized by this fixture.
  fs.writeFileSync(path.join(dir,'scripts/wa_web_bridge.mjs'),[
    'const transportOnly = createTransportOnlyPolicy(process.env);',
    "client.on('message_create', async (message) => {\n  if (transportOnly.enabled) return;",
    'await applyAccountReadyState(accountId, { routerEnabled, recovered: false, client });',
    '  app.use(transportOnly.middleware);',
    'transportOnly.sendText(client,to,text,requestedAccountId)',
    'const ready=bridgeState.ready && diagnostics.identityMatches;',
    'ownerSelfChatPolicy:transportOnly.policyFields(transportOnlyBuildHash)',
    "const transportOnlyBuildHash = '00000000';",
  ].join('\n'));
  fs.writeFileSync(path.join(dir,'scripts/account-wrapper.mjs'),
    "['serve','status','history','send-text','identity']\n  if (command === 'send-text') {");
  const script=fileURLToPath(new URL('../scripts/prepare-scoped-group-bridge.mjs',import.meta.url));
  const options={cwd:dir,env:{PATH:path.dirname(process.execPath),HOME:dir},encoding:'utf8',timeout:10000};
  const prepared=spawnSync(process.execPath,[script,dir],options);
  assert.equal(prepared.status,0,prepared.stderr);
  assert.match(fs.readFileSync(path.join(dir,'scripts/wa_web_bridge.mjs'),'utf8'),/transportOnly\.routes\?\.\(app,/);
  for(const file of ['whatsapp-scoped-group-transport.js','whatsapp-scoped-group-relay.js','whatsapp-scoped-timer-notifications.js','whatsapp-scoped-coordinator.js','whatsapp-scoped-delegates.js']) {
    const url=pathToFileURL(path.join(dir,'packages/connectors/src',file)).href;
    const imported=spawnSync(process.execPath,['--input-type=module','--eval',`await import(${JSON.stringify(url)})`],options);
    assert.equal(imported.status,0,imported.stderr);
  }
  // Upgrade a documented earlier wrapper shape, with the newly introduced
  // modules absent. Both inactive preparation paths must carry their closure.
  const wrapperPath=path.join(dir,'scripts/account-wrapper.mjs');
  let wrapper=fs.readFileSync(wrapperPath,'utf8')
    .replace("'group-reply','group-notify']","'group-reply']")
    .replace("if(command==='group-reply' || command==='group-notify')","if(command==='group-reply')")
    .replace("JSON.stringify({to,text,accountId:'main',requestId,parentId,...(command==='group-notify'?{notificationId:requestId}:{})})","JSON.stringify({to,text,accountId:'main',requestId,parentId})");
  fs.writeFileSync(wrapperPath,wrapper);
  for(const name of ['whatsapp-participant-recovery','whatsapp-participant-recovery-admission','whatsapp-scoped-participant-input','whatsapp-scoped-wrapper-errors'])
    fs.unlinkSync(path.join(dir,'packages/connectors/src',name+'.js'));
  const upgrade=fileURLToPath(new URL('../scripts/prepare-scoped-group-notifications.mjs',import.meta.url));
  const upgraded=spawnSync(process.execPath,[upgrade,dir],options);
  assert.equal(upgraded.status,0,upgraded.stderr);
  for(const file of ['whatsapp-scoped-group-transport.js','whatsapp-scoped-group-relay.js']) {
    const url=pathToFileURL(path.join(dir,'packages/connectors/src',file)).href;
    const imported=spawnSync(process.execPath,['--input-type=module','--eval',`await import(${JSON.stringify(url)})`],options);
    assert.equal(imported.status,0,imported.stderr);
  }
});
