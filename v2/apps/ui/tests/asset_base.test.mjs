import assert from 'node:assert/strict';
import test from 'node:test';
import {uiAssetUrl} from '../src/asset_base.mjs';
const origin='https://example.test';
const document=content=>({querySelector:()=>content?{content}:null,URL:origin+'/'});
test('ordinary startup retains root assets while a pinned page retains its own helper',()=>{
  assert.equal(uiAssetUrl('encrypted_upload.js',document(null),origin),origin+'/encrypted_upload.js');
  const prefix=`/_ui/${'a'.repeat(64)}/`;
  assert.equal(uiAssetUrl('encrypted_upload.js',document(prefix),origin),origin+prefix+'encrypted_upload.js');
  assert.equal(uiAssetUrl('encrypted_upload.js',{...document(null),URL:origin+prefix+'index.html'},origin),origin+prefix+'encrypted_upload.js');
});
test('an asset namespace cannot select another origin, API, filesystem or parent path',()=>{
  for(const value of ['https://other.test/','//other.test/','/api/','/_ui/../','file:///tmp/','/_ui/'+('a'.repeat(63))+'/'])assert.throws(()=>uiAssetUrl('encrypted_upload.js',document(value),origin));
  for(const name of ['..','.','../helper.js','/helper.js','api/x.js','file.js?x'])assert.throws(()=>uiAssetUrl(name,document(null),origin));
});
