// Real mounted WASM Attach clicks against a synthetic API, including browser
// storage restrictions. No account, provider or external browser state is used.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
import {A,startMock} from './headless-workspace-mock.mjs';
import {uploadCancel} from './headless-upload-cancel.mjs';

assert.equal(process.env.CI,'true','Run only against the isolated synthetic API');
assert.ok(process.env.UI_BUNDLE_DIR,'UI_BUNDLE_DIR is required');
const {server,state,origin}=await startMock(process.env.UI_BUNDLE_DIR);
const scratch=await mkdtemp(join(tmpdir(),'orkestr-attachment-picker-'));
const file=join(scratch,'synthetic-picker.bin');
const bytes=Buffer.alloc(3*1024*1024+17,0x61);
await writeFile(file,bytes);
let browser;
try{
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
  for(const mode of ['normal','sessionStorage','localStorage','both','asset-unavailable']){
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request',request=>{
      if(mode==='asset-unavailable'&&new URL(request.url()).pathname==='/encrypted_upload.js')return request.abort();
      if(request.url().startsWith(origin+'/')||/^(data|blob):/.test(request.url()))return request.continue();
      request.abort();
    });
    await page.evaluateOnNewDocument(mode=>{
      for(const name of ['sessionStorage','localStorage'])if(mode===name||mode==='both'){
        Object.defineProperty(window,name,{configurable:true,get(){throw new DOMException('Storage denied','SecurityError');}});
      }
      // Fail if native Attach regresses to reading the entire file.
      const read=Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer=function(){if(this.size>1024*1024)throw Error('Unbounded file read');return read.call(this);};
    },mode);
    await page.goto(`${origin}/#conversation/${A}`,{waitUntil:'domcontentloaded'});
    await page.waitForSelector('#composer');
    const selector='.message-composer button[aria-label="Attach a file or image"]';
    const before=state.uploads.length;
    // A trusted click opens the picker before optional uploader setup.
    const chooser=page.waitForFileChooser({timeout:5000});
    await page.click(selector);await(await chooser).accept([file]);
    if(mode==='asset-unavailable'){
      await page.waitForFunction(()=>document.querySelector('.composer-tools')?.textContent.includes('Encrypted uploads are unavailable.'));
      assert.equal(state.uploads.length,before,'No upload when the asset is unavailable');
      assert.equal(await page.$eval(selector,n=>n.disabled),false,'The picker is retryable');
    }else{
      await page.waitForFunction(()=>document.querySelector('.attachment-chip .chip-name')?.textContent==='synthetic-picker.bin');
      assert.equal(state.uploads.length,before+1,`${mode}: one attachment receipt`);
      const uploaded=state.uploads.at(-1);
      assert.equal(uploaded.encrypted,true,`${mode}: native ciphertext path`);
      assert.deepEqual(Buffer.from(uploaded.files[0].content_base64,'base64'),bytes);
      // Cancelling another picker does not upload or leave controls busy.
      const cancelled=page.waitForFileChooser({timeout:5000});
      await page.click(selector);await(await cancelled).cancel();
      await page.waitForFunction(selector=>!document.querySelector(selector).disabled,{},selector);
      assert.equal(state.uploads.length,before+1);
    }
    assert.deepEqual(errors,[],`${mode}: no unhandled browser error`);
    if(process.env.SCREENSHOT_DIR){
      await mkdir(process.env.SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:join(process.env.SCREENSHOT_DIR,`attachment-picker-${mode}.png`)});
    }
    await page.close();
    console.log(`Attachment picker: ${mode} passed`);
  }
  await uploadCancel({browser,state,origin,scratch,screenshot:async(page,name)=>{
    if(!process.env.SCREENSHOT_DIR)return;
    await mkdir(process.env.SCREENSHOT_DIR,{recursive:true});
    await page.screenshot({path:join(process.env.SCREENSHOT_DIR,`attachment-picker-${name}.png`)});
  }});
  console.log('Attachment picker: upload cancel and remove passed');
}finally{
  await browser?.close();server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  await rm(scratch,{recursive:true,force:true});
}
