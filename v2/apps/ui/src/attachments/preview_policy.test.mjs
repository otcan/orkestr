import test from 'node:test';
import assert from 'node:assert/strict';
import {previewKind,downloadType,PREVIEW_LIMIT,TEXT_PREVIEW_LIMIT} from './preview_policy.mjs';
test('only passive bounded types receive previews; unsafe types download inertly',()=>{
  for(const type of ['text/html','image/svg+xml','application/javascript','application/xhtml+xml']){
    assert.equal(previewKind(type,10),null);assert.equal(downloadType(type),'application/octet-stream');
  }
  assert.equal(previewKind('image/png',PREVIEW_LIMIT),'image');
  assert.equal(previewKind('image/png',PREVIEW_LIMIT+1),null);
  assert.equal(previewKind('application/pdf',10),null,'PDF is download-only');
  assert.equal(downloadType('application/pdf'),'application/pdf');
  assert.equal(downloadType('image/png'),'image/png');
  assert.equal(previewKind('text/plain',TEXT_PREVIEW_LIMIT),'text');
  assert.equal(previewKind('text/plain',TEXT_PREVIEW_LIMIT+1),null);
});
