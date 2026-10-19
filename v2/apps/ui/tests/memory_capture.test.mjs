import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/memory_capture.js',import.meta.url),'utf8');
const {memoryCaptureTime}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('capture uses current clock and preserves integer milliseconds',()=>{
 const before=Date.now();const capture=memoryCaptureTime();assert.ok(capture>=before&&capture<=Date.now());
 assert.equal(memoryCaptureTime(()=>1792400000123),1792400000123);
 assert.equal(memoryCaptureTime(()=>253402300799999),253402300799999);
});
test('failed or invalid clock refuses instead of epoch fallback',()=>{
 for(const value of [0,-1,NaN,Infinity,1.5,253402300800000,'1792400000123',null]) assert.throws(()=>memoryCaptureTime(()=>value),/clock unavailable/);
 assert.throws(()=>memoryCaptureTime(()=>{throw Error('clock failed')}),/clock failed/);
});
