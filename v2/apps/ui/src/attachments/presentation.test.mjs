import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attachmentLabel} from './presentation.mjs';
test('available metadata never implies verified or downloadable bytes',()=>{
 assert.deepEqual(attachmentLabel({filename:'synthetic.txt',byte_length:0,state:'available'}),
 {name:'synthetic.txt',size:'0 bytes',status:'Not downloaded',canSave:false});
});
test('tombstone keeps original name and size without save action',()=>{
 assert.deepEqual(attachmentLabel({filename:'saved.txt',byte_length:1024,state:'removed'}),
 {name:'saved.txt',size:'1,024 bytes',status:'File removed',canSave:false});
});
