import test from 'node:test';
import assert from 'node:assert/strict';
import {mountMessageFiles} from './message_files.mjs';
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.style={};}
  append(...nodes){this.children.push(...nodes);}
  insertBefore(node,before){this.children.splice(this.children.indexOf(before),0,node);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(k,v){this.attrs[k]=v;}
  click(){return this.onclick?.();}
  find(text){return this.children.flatMap(n=>[n,...n.all()]).find(n=>n.textContent===text);}
  all(){return this.children.flatMap(n=>[n,...n.all()]);}
}
const conversation='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002';
const metadata=type=>({file:{filename:'file',media_type:type,plaintext_size:3}});
function fixture(type='image/png',picker){
  globalThis.document={createElement:tag=>new Element(tag)};
  const root=new Element('div'),made=[],revoked=[];
  const client={status:async()=>metadata(type),download:async(_m,sink)=>{await sink.write(new Uint8Array([1,2,3]));await sink.close();}};
  const view=mountMessageFiles({conversation,files:[{kind:'encrypted',id}],root},{client,picker,url:{createObjectURL(){const x=`blob:${made.length}`;made.push(x);return x;},revokeObjectURL:x=>revoked.push(x)}});
  return {root,view,made,revoked,client};
}
test('verified image URL is revoked on close and no raw HTML preview is offered',async()=>{
  const f=fixture();await f.root.find('View file details').click();await f.root.find('Preview').click();
  assert.equal(f.made.length,1);f.root.find('Close preview').click();assert.deepEqual(f.revoked,f.made);
  await f.root.find('Preview').click();f.view.close();assert.deepEqual(f.revoked,f.made);
  const html=fixture('text/html');await html.root.find('View file details').click();assert.equal(html.root.find('Preview'),undefined);html.view.close();
});
test('PDF is download-only: no preview button and no frame, Download stays offered',async()=>{
  const f=fixture('application/pdf');await f.root.find('View file details').click();
  assert.equal(f.root.find('Preview'),undefined);assert.ok(f.root.find('Download'));
  assert.equal(f.root.all().find(n=>n.tag==='iframe'),undefined);
  assert.ok(f.root.all().some(n=>/Preview unavailable for this type or size\. Use Download\./.test(n.textContent||'')),'download-only notice');
  f.view.close();
});
test('closing while save picker is pending never opens a writable destination',async()=>{
  let resolve,opened=0;
  const f=fixture('text/plain',()=>new Promise(r=>resolve=r));await f.root.find('View file details').click();f.root.find('Download').click();f.view.close();
  resolve({createWritable(){opened++;throw Error('must not open');}});await new Promise(r=>setImmediate(r));assert.equal(opened,0);
});
// ORK-786: a note's name, type and size show at once; actions still verify.
function hinted(type='text/plain',{name='notes.txt',verifiedName='notes.txt',picker}={}){
  globalThis.document={createElement:tag=>new Element(tag)};
  const root=new Element('div'),calls=[];
  const client={status:async()=>{calls.push('status');return {file:{filename:verifiedName,media_type:type,plaintext_size:3}};},
    download:async(_m,sink)=>{calls.push('download');await sink.write(new Uint8Array([104,105,33]));await sink.close();}};
  const file={kind:'encrypted',id,name,media_type:type,size:3};
  const view=mountMessageFiles({conversation,files:[file],root},{client,picker,url:{createObjectURL:()=>'blob:x',revokeObjectURL(){}}});
  return {root,view,calls};
}
test('a hinted card shows name, size and type without a request, with Preview and Download',async()=>{
  const f=hinted();
  assert.deepEqual(f.calls,[],'nothing is fetched to draw the card');
  assert.equal(f.root.children[0].children[0].textContent,'notes.txt');
  assert.equal(f.root.children[0].children[1].textContent,'3 B · text/plain');
  assert.equal(f.root.children[0].attrs['data-verified'],'false');
  assert.equal(f.root.find('View file details'),undefined);
  assert.ok(f.root.find('Download'));
  await f.root.find('Preview').click();
  assert.deepEqual(f.calls.slice(0,2),['status','status'],'preview verifies metadata, then bytes against it');
  assert.equal(f.root.children[0].attrs['data-verified'],'true');
  assert.ok(f.root.all().some(n=>n.tag==='pre'&&n.textContent==='hi!'));
  f.view.close();
});
test('a hinted PDF offers Download only, and Download refuses a name that changed',async()=>{
  const pdf=hinted('application/pdf',{name:'a.pdf',verifiedName:'a.pdf'});
  assert.equal(pdf.root.find('Preview'),undefined);assert.ok(pdf.root.find('Download'));pdf.view.close();
  let suggested=null,opened=0;
  const picker=options=>{suggested=options.suggestedName;return Promise.resolve({createWritable(){opened++;return {write(){},close(){},abort(){}};}});};
  const f=hinted('text/plain',{name:'shown.txt',verifiedName:'other.txt',picker});
  f.root.find('Download').click();
  for(let i=0;i<20&&f.root.children[0].children[1].textContent.startsWith('Verifying');i++)await new Promise(r=>setImmediate(r));
  assert.equal(suggested,'shown.txt');
  assert.equal(opened,0,'no destination is opened for a file whose name changed');
  assert.match(f.root.children[0].children[1].textContent,/name changed/);
  f.view.close();
});
test('a hinted Download with a matching name verifies and writes',async()=>{
  const written=[];
  const picker=()=>Promise.resolve({createWritable:async()=>({write:async b=>written.push(...b),close:async()=>{},abort:async()=>{}})});
  const f=hinted('text/plain',{picker});
  f.root.find('Download').click();
  for(let i=0;i<50&&!/Download offered/.test(f.root.children[0].children[1].textContent);i++)await new Promise(r=>setImmediate(r));
  assert.deepEqual(written,[104,105,33]);
  assert.match(f.root.children[0].children[1].textContent,/File verified\. Download offered\./);
  f.view.close();
});
