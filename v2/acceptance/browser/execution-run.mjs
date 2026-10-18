// Optional synthetic execution setup. Fixture authority never enters the server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {click, digest} from './support.mjs';
import {executionScenarios} from './execution-scenarios.mjs';

export async function executionFixture(file, artifact) {
  const receipt=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(receipt.product_source,artifact.server.source_sha,'fixture_server_source_mismatch');
  assert.equal(receipt.product_source,artifact.ui.source_sha,'fixture_ui_source_mismatch');
  assert.equal(digest(await fs.readFile(receipt.executable)),receipt.executable_sha256,'fixture_binary_mismatch');
  const directory=path.join(path.dirname(file),'v2/acceptance/browser');
  for(const [name,hash] of Object.entries(receipt.files)) {
    assert(!name.includes('/')&&!name.includes('..'),'fixture_inventory_invalid');
    assert.equal(digest(await fs.readFile(path.join(directory,name))),hash,'fixture_source_mismatch');
  }
  assert(receipt.files['fixture-driver.mjs'],'fixture_module_not_pinned');
  return {receipt,directory};
}

export async function runExecution({configuration,page,context,candidate,network,report,signal}) {
  network.resources='real';
  await click(page,'Assistant');
  await page.waitForSelector('#composer',{visible:true});
  const conversation=await page.evaluate(async()=>{
    const response=await fetch('/api/v2/browser/session',{credentials:'same-origin',cache:'no-store'});
    if(response.status!==200)throw new Error('synthetic_session_required');
    return (await response.json()).global_conversation_id;
  });
  const home=path.join(candidate.root,'owner-b');
  await fs.writeFile(path.join(home,'browser-fixture.marker'),'synthetic-browser-fixture-v1\n',{mode:0o600,flag:'wx'});
  const {fixtureDriver}=await import(pathToFileURL(path.join(configuration.directory,'fixture-driver.mjs')).href);
  let fixture;
  report.fixture={product_source:configuration.receipt.product_source,
    fixture_source:configuration.receipt.fixture_source,js_cleanup_source:configuration.receipt.js_cleanup_source,
    executable_sha256:configuration.receipt.executable_sha256,files:configuration.receipt.files,
    native_provider:false,authority_duration_seconds:60};
  const started=performance.now();
  try {
    fixture=await fixtureDriver({executable:configuration.receipt.executable,
      db:path.join(home,'core.sqlite3'),username:'synthetic-owner-b',conversation,context});
    await executionScenarios({page,fixture,report,signal});
  } finally {
    if(fixture)await fixture.close();
    report.cleanup.owned_fixture_stopped=true;
    report.fixture.elapsed_ms=Math.round(performance.now()-started);
  }
}
