import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as limits from "../apps/web/public/attachment-visual-limits.js";

const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness() {
  const source = await fs.readFile(new URL("../apps/web/src/app/attachment-visual-preview.component.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
  } });
  const exports = {}, timers = new Map(); let sequence = 0;
  const signal = value => { const get = () => value; get.set = next => { value = next; }; return get; };
  vm.runInNewContext(outputText, { exports, require: name => name === "@angular/core" ? {
    Component: () => value => value, Input: () => () => {}, ViewChild: () => () => {}, signal,
  } : limits, setTimeout: fn => { timers.set(++sequence, fn); return sequence; }, clearTimeout: id => timers.delete(id) });
  const component = new exports.AttachmentVisualPreviewComponent();
  component.canvas = { nativeElement: { width: 0, height: 0 } };
  component.viewport = { nativeElement: { clientWidth: 400 } };
  const renders = []; let active = 0, peak = 0;
  component.pdf = { getPage: async () => ({
    getViewport: ({ scale }) => ({ width: 100 * scale, height: 100 * scale }),
    render: ({ canvas }) => {
      active++; peak = Math.max(peak, active);
      let done; const promise = new Promise(resolve => { done = resolve; });
      const task = { promise, width: canvas.width, finish: () => { active--; done(); }, cancel: () => { task.cancelled = true; } };
      renders.push(task); return task;
    }, cleanup() {},
  }) };
  return { component, renders, timers, peak: () => peak };
}

test("rotation while rendering queues one final fit-width render without sharing a canvas", async () => {
  const { component, renders, timers, peak } = await harness();
  const first = component.render(); await tick();
  assert.equal(renders[0].width, 400);
  component.viewport.nativeElement.clientWidth = 300;
  await component.render();
  component.viewport.nativeElement.clientWidth = 600;
  await component.render();
  assert.equal(renders.length, 1);
  renders[0].finish(); await first; await tick();
  assert.equal(renders.length, 2);
  assert.equal(renders[1].width, 600);
  assert.equal(component.busy(), true);
  renders[1].finish(); await tick();
  assert.equal(component.busy(), false);
  assert.equal(component.error(), "");
  assert.equal(peak(), 1);
  assert.equal(timers.size, 0);
});

test("close discards queued rotation and fences a late render completion", async () => {
  const { component, renders, timers } = await harness();
  const first = component.render(); await tick();
  component.viewport.nativeElement.clientWidth = 600; await component.render();
  component.ngOnDestroy();
  assert.equal(renders[0].cancelled, true);
  renders[0].finish(); await first; await tick();
  assert.equal(renders.length, 1);
  assert.equal(component.canvas.nativeElement.width, 0);
  assert.equal(timers.size, 0);
});

test("busy zoom/page controls cannot overlap an active PDF render", async () => {
  const { component, renders } = await harness();
  component.pages.set(2);
  const first = component.render(); await tick();
  component.scale(1.25); component.fit(); component.turn(1);
  assert.equal(component.zoom(), 1); assert.equal(component.page(), 1);
  assert.equal(renders.length, 1);
  renders[0].finish(); await first;
});
