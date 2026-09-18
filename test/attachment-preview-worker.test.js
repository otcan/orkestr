import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync, deflateRawSync } from "node:zlib";
import { AttachmentPreview, crc32, inflateBounded } from "../apps/web/public/attachment-preview-worker.js";

function zip(name, text, {method = 8, flags = 0x800, mode = 0x8000} = {}) {
  const raw = Buffer.from(text), filename = Buffer.from(name), compressed = method === 8 ? deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(flags,6); local.writeUInt16LE(method,8);
  local.writeUInt32LE(crc32(raw),14); local.writeUInt32LE(compressed.length,18); local.writeUInt32LE(raw.length,22); local.writeUInt16LE(filename.length,26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(flags,8); central.writeUInt16LE(method,10);
  central.writeUInt32LE(crc32(raw),16); central.writeUInt32LE(compressed.length,20); central.writeUInt32LE(raw.length,24); central.writeUInt16LE(filename.length,28); central.writeUInt32LE((mode << 16) >>> 0,38);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10);
  end.writeUInt32LE(central.length+filename.length,12); end.writeUInt32LE(local.length+filename.length+compressed.length,16);
  return Buffer.concat([local,filename,compressed,central,filename,end]);
}
function tar(name, text, type = "0") {
  const header = Buffer.alloc(512), bytes=Buffer.from(text);
  header.write(name); header.write(bytes.length.toString(8).padStart(11,"0")+"\0",124);
  header.fill(32,148,156); header.write(type,156); header.write("ustar\0",257);
  const sum=header.reduce((a,b)=>a+b,0); header.write(sum.toString(8).padStart(6,"0")+"\0 ",148);
  return Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512),Buffer.alloc(1024)]);
}
test("text preview is literal, bounded and UTF-8 safe",async()=>{
  const p=new AttachmentPreview(); const result=await p.open(Buffer.from("<script>alert(1)</script>"),"script.html");
  assert.equal(result.text,"<script>alert(1)</script>"); assert.equal(result.archive,false);
  const large=await p.open(Buffer.from("€".repeat(100000)),"large.txt"); assert.equal(large.truncated,true);
  await assert.rejects(p.open(Buffer.from([0,1,2]),"binary"),/Binary/);
});
for(const method of [0,8])test(`ZIP ${method} lists and previews with integrity checks`,async()=>{
  const p=new AttachmentPreview();const bytes=zip("src/example.txt","hello encrypted world",{method});
  const list=await p.open(bytes,"test.zip");assert.equal(list.entries[0].name,"src/example.txt");
  assert.equal((await p.entry(0)).text,"hello encrypted world");
  bytes[30+Buffer.byteLength("src/example.txt")]^=1;
  await assert.rejects(p.entry(0));
});
for(const name of ["../secret","/etc/passwd","C:\\secret","safe/../../escape","bad\u0000.txt"])test(`archive blocks unsafe name ${JSON.stringify(name)}`,async()=>{
  await assert.rejects(new AttachmentPreview().open(zip(name,"a"),"test.zip"));
});
test("ZIP rejects encrypted files, symlinks and truncated archives",async()=>{
  for(const bytes of [zip("a","b",{flags:1}),zip("a","b",{mode:0xa000}),zip("a","b").subarray(0,50)])await assert.rejects(new AttachmentPreview().open(bytes,"a.zip"));
});
test("decompression bombs enforce actual output and advertised size limits",async()=>{
  const bomb=gzipSync(Buffer.alloc(4*1024*1024,65));
  await assert.rejects(inflateBounded(bomb,"gzip",1024),/limit/);
  await assert.rejects(new AttachmentPreview().open(bomb,"a.gz"),/limit/);
  await assert.rejects(new AttachmentPreview().open(zip("a.txt","x".repeat(3*1024*1024)),"a.zip"),/limit/);
});
test("TAR, TGZ and GZIP previews and malicious TAR links",async()=>{
  for(const [bytes,name] of [[tar("notes.txt","notes"),"a.tar"],[gzipSync(tar("notes.txt","notes")),"a.tgz"]]) {
    const p=new AttachmentPreview();const list=await p.open(bytes,name);assert.equal(list.entries.length,1);assert.equal((await p.entry(0)).text,"notes");
  }
  assert.equal((await new AttachmentPreview().open(gzipSync(Buffer.from("text")),"a.txt.gz")).text,"text");
  for(const type of ["1","2","3","4","6","x"])await assert.rejects(new AttachmentPreview().open(tar("bad","",type),"a.tar"));
});
test("no recursive expansion and oversized inputs fail closed",async()=>{
  const p=new AttachmentPreview();await p.open(zip("nested.zip","dummy"),"a.zip");await assert.rejects(p.entry(0),/Nested/);
  await assert.rejects(p.open(new Uint8Array(26*1024*1024),"a"),/25 MB/);
});
