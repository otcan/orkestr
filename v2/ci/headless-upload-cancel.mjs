// ORK-790: Cancel in the upload bar and Remove on an attached file, in the
// real mounted WASM composer against the synthetic API. Synthetic files only.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {A} from './headless-workspace-mock.mjs';

const until=async(check,what,timeout=20000)=>{
  const end=Date.now()+timeout;
  while(!check()){if(Date.now()>end)throw new Error(`Timed out waiting for ${what}`);await new Promise(r=>setTimeout(r,50));}
};

export async function uploadCancel({browser,state,origin,scratch,screenshot=async()=>{}}) {
  const large=join(scratch,'synthetic-large.bin'),keep=join(scratch,'synthetic-keep.txt'),next=join(scratch,'synthetic-next.txt');
  await writeFile(large,Buffer.alloc(4*1024*1024+3,0x62));
  await writeFile(keep,'Synthetic file attached before the cancel');
  await writeFile(next,'Synthetic file queued behind the cancelled one');
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // Phone width: both controls must be at least 44 px tall.
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.goto(`${origin}/#conversation/${A}`,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#composer');
  const attach='.message-composer button[aria-label="Attach a file or image"]';
  const choose=async files=>{const chooser=page.waitForFileChooser({timeout:5000});await page.click(attach);await(await chooser).accept(files);};
  const chipNames=()=>page.$$eval('.message-composer .attachment-chip .chip-name',nodes=>nodes.map(n=>n.textContent).sort());
  const hasChip=name=>page.waitForFunction(name=>[...document.querySelectorAll('.message-composer .attachment-chip .chip-name')].some(n=>n.textContent===name),{},name);
  const sent=()=>Object.keys(state.intake).length;
  const height=selector=>page.$eval(selector,node=>node.getBoundingClientRect().height);

  // Another upload of the same draft, finished before the cancel.
  await choose([keep]);await hasChip('synthetic-keep.txt');
  const keepId=state.uploads.at(-1).upload_id;
  const sentBefore=sent(),putsBefore=state.chunkPuts?.length??0;

  // A large upload is held mid-transfer; the next file of its batch waits behind it.
  state.holdEncryptedChunk=1;
  await choose([large,next]);
  const cancel='.upload-progress button[aria-label="Cancel upload of synthetic-large.bin"]';
  await page.waitForSelector(cancel);
  await until(()=>state.chunkPuts.slice(putsBefore).some(p=>p.index===1),'the held chunk transfer');
  const largeId=state.chunkPuts.slice(putsBefore).find(p=>p.index===1).upload_id;
  assert.equal(await page.$eval(cancel,node=>[node.type,node.textContent.trim()].join(':')),'button:Cancel');
  assert.ok(await height(cancel)>=44,'Cancel is at least 44 px tall on a phone');
  await screenshot(page,'upload-cancel-in-progress');

  // Keyboard: Enter on the focused Cancel stops the upload and sends nothing.
  await page.focus(cancel);await page.keyboard.press('Enter');
  await until(()=>state.abortedChunkPuts?.some(p=>p.upload_id===largeId),'the browser aborting the transfer');
  await until(()=>state.discardedUploads?.includes(largeId),'the server discarding the partial upload');
  state.holdEncryptedChunk=undefined;
  // The rest of the batch still attaches; the cancelled file never does.
  await hasChip('synthetic-next.txt');
  await page.waitForFunction(()=>!document.querySelector('.message-composer .upload-progress'));
  assert.deepEqual(await chipNames(),['synthetic-keep.txt','synthetic-next.txt']);
  await new Promise(r=>setTimeout(r,300));
  assert.deepEqual(state.chunkPuts.filter(p=>p.upload_id===largeId).map(p=>p.index),[0,1],'no transfer after Cancel');
  assert.equal(await page.evaluate(async url=>(await fetch(url)).status,`/api/v2/conversations/${A}/encrypted-uploads/${largeId}`),404);
  assert.equal(state.uploads.some(u=>u.upload_id===largeId),false,'no attachment receipt for the cancelled file');
  assert.equal(state.discardedUploads.includes(keepId),false,'the other upload is untouched');
  assert.equal(sent(),sentBefore,'Cancel never sends the message');

  // The composer stays usable.
  assert.equal(await page.$eval('#composer',node=>node.disabled),false);
  assert.equal(await page.$eval(attach,node=>node.disabled),false,'Attach is available again');
  await page.focus('#composer');await page.keyboard.type('Synthetic message after a cancelled upload');
  await screenshot(page,'upload-cancelled');

  // Remove: the same control on a finished, unsent file.
  const remove='.attachment-chip button[aria-label="Remove synthetic-keep.txt"]';
  assert.equal(await page.$eval(remove,node=>[node.type,node.textContent.trim()].join(':')),'button:Remove');
  assert.ok(await height(remove)>=44,'Remove is at least 44 px tall on a phone');
  await page.click(remove);
  await until(()=>state.discardedUploads.includes(keepId),'the server discarding the removed upload');
  assert.deepEqual(await chipNames(),['synthetic-next.txt']);
  assert.equal(sent(),sentBefore,'Remove never sends the message');

  // Send: only the remaining file goes with the typed text.
  await page.focus('#composer');await page.keyboard.press('Enter');
  await until(()=>sent()===sentBefore+1,'the message send');
  const text=state.messages[A].at(-1).text;
  assert.match(text,/^Synthetic message after a cancelled upload\n\n\[File attached in the Orkestr app/);
  assert.ok(text.includes('synthetic-next.txt'));
  assert.ok(!text.includes('synthetic-keep.txt')&&!text.includes('synthetic-large.bin'),'removed and cancelled files are not sent');
  assert.deepEqual(errors,[],'no unhandled browser error');
  await page.close();
}
