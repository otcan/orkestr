import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { of } from "rxjs";

const source = await fs.readFile(new URL("../apps/web/src/app/composer-keyboard.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { shouldSubmitComposer } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
const enter = { key: "Enter", keyCode: 13, isComposing: false, shiftKey: false, ctrlKey: false, metaKey: false };

test("phone return inserts a newline while explicit Send shortcut remains available", () => {
  assert.equal(shouldSubmitComposer(enter, true), false);
  assert.equal(shouldSubmitComposer({ ...enter, ctrlKey: true }, true), true);
  assert.equal(shouldSubmitComposer({ ...enter, metaKey: true }, true), true);
  assert.equal(shouldSubmitComposer({ ...enter, shiftKey: true }, true), false);
  assert.equal(shouldSubmitComposer(enter, false), true);
});
test("IME composition can never submit a partially composed message", () => {
  for (const coarse of [false, true]) for (const patch of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.equal(shouldSubmitComposer({ ...enter, ctrlKey: true, ...patch }, coarse), false);
  }
});
test("mobile attachment controls retain narrow-screen, safe-area and named-input guards", async () => {
  const read = name => fs.readFile(new URL("../apps/web/src/app/" + name, import.meta.url), "utf8");
  const panel = await read("attachment-panel.css"), composer = await read("thread-composer.component.html");
  for (const edge of ["top", "right", "bottom", "left"]) assert.ok(panel.includes(`safe-area-inset-${edge}`));
  assert.match(panel, /min-width:0/);
  assert.match(panel, /overscroll-behavior:contain/);
  assert.match(composer, /name="paste-name"[^>]+\(keydown.enter\)="\$event.preventDefault\(\)"/);
  const component = await read("attachment-preview.component.ts");
  assert.match(component, /HostListener\("window:resize"\)/);
  assert.match(component, /mobileViewport\.set/);
});

test("switching previews restores the latest connected trigger, and close cancels work", async t => {
  const source = await fs.readFile(new URL("../apps/web/src/app/attachment-preview.service.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
  const api = { attachmentFeatures: () => of({ textPreview: false, archivePreview: false }) };
  const core = { Injectable: () => target => target, inject: () => api, signal: value => {
    const read = () => value; read.set = next => { value = next; }; read.update = fn => { value = fn(value); }; return read;
  } };
  const exports = {};
  new Function("require", "exports", compiled)(name => name === "@angular/core" ? core : name === "rxjs" ? { firstValueFrom: async observable => {
    let value; observable.subscribe(next => { value = next; }); return value;
  } } : {}, exports);
  const previousDocument = globalThis.document;
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  const focused = [];
  const trigger = id => ({ isConnected: true, focus: () => focused.push(id) });
  const first = trigger("first"), second = trigger("second");
  globalThis.document = { activeElement: first };
  const preview = new exports.AttachmentPreviewService();
  await preview.openPending({ name: "first.txt" });
  globalThis.document.activeElement = second;
  await preview.openPending({ name: "second.txt" });
  focused.length = 0;
  let aborted = 0, terminated = 0;
  preview.abort = { abort: () => aborted++ }; preview.worker = { terminate: () => terminated++ };
  preview.close();
  assert.deepEqual(focused, ["second"]);
  assert.equal(aborted, 1); assert.equal(terminated, 1); assert.equal(preview.state().open, false);
  globalThis.document.activeElement = first;
  await preview.openPending({ name: "first.txt" });
  first.isConnected = false; focused.length = 0; preview.close();
  assert.deepEqual(focused, []);
});
