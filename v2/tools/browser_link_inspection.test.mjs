import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { inspectVisibleLink } from './browser_link_inspection.mjs';
const anchor = (text, href) => ({innerText:text,target:'_blank',getClientRects:()=>[{}],getAttribute:()=>href,hasAttribute:()=>false});
const evaluate = anchors => expression => vm.runInNewContext(expression, {document:{querySelectorAll:selector=>selector==='a[href]'?anchors:[]},getComputedStyle:()=>({visibility:'visible',display:'block'}),location:{href:'https://example.test/form'},URL});
test('projects an exact anchor without invoking its click or label', async()=>{
 let clicks=0; const a=anchor(' document ','/ethics.pdf');a.click=()=>clicks++;
 const out=await inspectVisibleLink(evaluate([a]),'document');assert.equal(out.href,'https://example.test/ethics.pdf');assert.equal(clicks,0);
});
test('omits query and fragment tokens', async()=>{const out=await inspectVisibleLink(evaluate([anchor('document','/ethics.pdf?token=secret#private')]),'document');assert.equal(out.href,'https://example.test/ethics.pdf');assert.equal(out.parameters_omitted,true);assert.ok(!JSON.stringify(out).includes('secret'));});
test('refuses absent, ambiguous, javascript and credential URLs',async()=>{
 assert.equal((await inspectVisibleLink(evaluate([]),'document')).error,'link_not_found');
 assert.equal((await inspectVisibleLink(evaluate([anchor('document','/a'),anchor('document','/b')]),'document')).error,'link_ambiguous');
 for(const href of ['javascript:alert(1)','https://user:pass@example.test/a']) assert.equal((await inspectVisibleLink(evaluate([anchor('document',href)]),'document')).error,'link_url_unsupported');
});
test('input cannot inject code', async()=>{await assert.rejects(()=>inspectVisibleLink(evaluate([]),'\n'),/link_text_invalid/);const out=await inspectVisibleLink(evaluate([]),'document";globalThis.pwned=true;//');assert.equal(out.error,'link_not_found');});
