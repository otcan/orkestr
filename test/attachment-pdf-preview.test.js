import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { assertPreviewPageCount, previewCanvasScale } from "../apps/web/public/attachment-visual-limits.js";

function fixturePdf() {
  const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
    "<< /Length 25 >>\nstream\n0 0 1 rg 0 0 100 100 re f\nendstream"];
  let data="%PDF-1.7\n",offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(data));data+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(data); data+=`xref\n0 5\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))data+=`${String(offset).padStart(10,"0")} 00000 n \n`;
  data+=`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(data));
}
test("pinned PDF renderer parses and renders a synthetic page without a browser plugin",async()=>{
  const loading=getDocument({data:fixturePdf(),enableXfa:false,stopAtErrors:true,verbosity:0});
  try {
    const pdf=await loading.promise; assertPreviewPageCount(pdf.numPages); assert.equal(pdf.numPages,1);
    const page=await pdf.getPage(1),canvas=createCanvas(100,100);
    await page.render({canvas,canvasContext:canvas.getContext("2d"),viewport:page.getViewport({scale:1}),annotationMode:0}).promise;
    assert.deepEqual([...canvas.getContext("2d").getImageData(50,50,1,1).data],[0,0,255,255]);
    page.cleanup();
  } finally { await loading.destroy(); }
});
test("corrupt PDFs fail rather than displaying their binary as text",async()=>{
  const loading=getDocument({data:new Uint8Array(Buffer.from("%PDF-1.7\ncorrupt")),stopAtErrors:true,verbosity:0});
  try { await assert.rejects(loading.promise); } finally { await loading.destroy(); }
});
test("PDF page and canvas bounds hold for huge and invalid geometry",()=>{
  assertPreviewPageCount(200); for(const value of [0,201,Infinity,NaN,-1])assert.throws(()=>assertPreviewPageCount(value));
  for(const [width,height] of [[100,100],[1e8,1e8],[1e8,1],[1,1e8]]) {
    const scale=previewCanvasScale(width,height,400,4);
    assert.ok(Math.floor(width*scale)*Math.floor(height*scale)<=8_000_000);
    assert.ok(Math.max(width*scale,height*scale)<=8192);
  }
  for(const value of [0,-1,NaN,Infinity])assert.throws(()=>previewCanvasScale(value,100,400));
});
