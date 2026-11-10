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
test('PDF is sandboxed without script or same-origin permissions',async()=>{
  const f=fixture('application/pdf');await f.root.find('View file details').click();await f.root.find('Preview').click();
  const frame=f.root.all().find(n=>n.tag==='iframe');assert.equal(frame.attrs.sandbox,'');f.view.close();
});
test('closing while save picker is pending never opens a writable destination',async()=>{
  let resolve,opened=0;
  const f=fixture('text/plain',()=>new Promise(r=>resolve=r));await f.root.find('View file details').click();f.root.find('Download').click();f.view.close();
  resolve({createWritable(){opened++;throw Error('must not open');}});await new Promise(r=>setImmediate(r));assert.equal(opened,0);
});
