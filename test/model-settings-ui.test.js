import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as rxjs from "rxjs";

const componentUrl = new URL("../apps/web/src/app/model-settings.component.ts", import.meta.url);
const catalog = {
  readOnly: false, readOnlyReason: "", model: "model-a", effort: "medium",
  models: [
    { id: "model-a", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "model-b", defaultReasoningEffort: "low", supportedReasoningEfforts: ["low"] },
  ],
};

async function componentWithApi(api, { fastTimeout = false } = {}) {
  const source = await fs.readFile(componentUrl, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
  } }).outputText;
  const exports = {};
  let definition;
  let emissions = 0;
  const deadlines = [];
  class ChangeDetectorRef {}
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === "rxjs") return { ...rxjs, timeout: (duration) => { deadlines.push(duration); return rxjs.timeout(fastTimeout ? 10 : duration); } };
    if (name === "@angular/core") return {
      Component: (value) => { definition = value; return () => {}; }, Input: () => () => {}, Output: () => () => {},
      ChangeDetectorRef, inject: token => token === ChangeDetectorRef ? { markForCheck() {} } : api,
      EventEmitter: class { emit() { emissions += 1; } },
    };
    if (name === "@angular/forms") return { FormsModule: class {} };
    if (name === "./api.service") return { ApiService: class {} };
    throw Error(`Unexpected import: ${name}`);
  } });
  return { component: new exports.ModelSettingsComponent(), definition, deadlines, emissions: () => emissions };
}

test("model controls load only on mount/change and save supported thread-scoped selections", async () => {
  const reads = [];
  const writes = [];
  const harness = await componentWithApi({
    getModelSettings(id) { reads.push(id); return rxjs.of(catalog); },
    setModelSettings(...args) { writes.push(args); return rxjs.of({ model: args[1], effort: args[2] }); },
  });
  const ui = harness.component;
  assert.equal(reads.length, 0);
  ui.threadId = "thread-a";
  ui.ngOnChanges();
  assert.deepEqual(reads, ["thread-a"]);
  assert.equal(ui.model, "model-a");
  ui.model = "model-b";
  ui.selectModel();
  assert.equal(ui.effort, "low");
  ui.save();
  assert.deepEqual(writes, [["thread-a", "model-b", "low"]]);
  assert.equal(harness.emissions(), 1);
  assert.equal(ui.saving, false);
  assert.match(ui.notice, /model-b.*low/);
  assert.deepEqual(harness.deadlines, [7000, 20000]);
  ui.ngOnDestroy();
});

test("read-only and unavailable current models do not silently submit a default", async () => {
  let settings = { ...catalog, readOnly: true, readOnlyReason: "Managed by policy" };
  let writes = 0;
  const { component: ui } = await componentWithApi({ getModelSettings: () => rxjs.of(settings), setModelSettings() { writes += 1; return rxjs.EMPTY; } });
  ui.ngOnChanges();
  ui.save();
  assert.equal(writes, 0);
  settings = { ...catalog, model: "unavailable-model" };
  ui.load();
  assert.equal(ui.model, "");
  assert.match(ui.notice, /unavailable/);
  ui.save();
  assert.equal(writes, 0);
  ui.ngOnDestroy();
});

test("uncertain save exposes the API error and refuses repeated Apply until reload", async () => {
  let writes = 0;
  const { component: ui } = await componentWithApi({
    getModelSettings: () => rxjs.of(catalog),
    setModelSettings() { writes += 1; return rxjs.throwError(() => ({ error: { error: "Model change remains unconfirmed." } })); },
  });
  ui.ngOnChanges();
  ui.save();
  assert.equal(ui.error, "Model change remains unconfirmed.");
  assert.equal(ui.reloadRequired, true);
  ui.save();
  assert.equal(writes, 1);
  ui.load();
  assert.equal(ui.reloadRequired, false);
  ui.ngOnDestroy();
});

for (const status of [400, 422]) test(`definite rejection ${status} preserves selected settings and permits retry`, async () => {
  let writes = 0;
  const { component: ui, emissions } = await componentWithApi({
    getModelSettings: () => rxjs.of(catalog),
    setModelSettings() {
      writes++;
      return writes === 1 ? rxjs.throwError(() => ({ status, error: { error: "The runtime rejected these settings." } })) : rxjs.of({ model: "model-b", effort: "low" });
    },
  });
  ui.ngOnChanges();
  ui.model = "model-b";
  ui.selectModel();
  ui.save();
  assert.equal(ui.reloadRequired, false);
  assert.equal(ui.model, "model-b");
  assert.equal(ui.effort, "low");
  assert.equal(emissions(), 0);
  ui.save();
  assert.equal(writes, 2);
  assert.equal(emissions(), 1);
  ui.ngOnDestroy();
});

test("late reads and saves cannot overwrite a newly selected thread or destroyed overlay", async () => {
  const oldRead = new rxjs.Subject();
  const oldSave = new rxjs.Subject();
  const harness = await componentWithApi({
    getModelSettings: id => id === "old" ? oldRead : rxjs.of({ ...catalog, model: "model-b", effort: "low" }),
    setModelSettings: () => oldSave,
  });
  const ui = harness.component;
  ui.threadId = "old";
  ui.ngOnChanges();
  ui.threadId = "new";
  ui.ngOnChanges();
  oldRead.next(catalog);
  assert.equal(ui.model, "model-b");
  ui.save();
  ui.ngOnDestroy();
  oldSave.next({ model: "model-a", effort: "high" });
  assert.equal(harness.emissions(), 0);
  assert.equal(ui.notice, "");
});

test("never-ending catalog requests become retryable UI errors at a bounded deadline", async () => {
  const { component: ui } = await componentWithApi({ getModelSettings: () => rxjs.NEVER }, { fastTimeout: true });
  ui.ngOnChanges();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(ui.loading, false);
  assert.match(ui.error, /Could not load model settings/);
  ui.ngOnDestroy();
});

test("model control UI retains accessibility, mobile sizing and conditional overlay placement", async () => {
  const { definition } = await componentWithApi({});
  assert.match(definition.template, /aria-label="Thread model settings"/);
  assert.match(definition.template, /role="alert"/);
  assert.match(definition.template, /settings && !settings.readOnly/);
  assert.match(definition.styles.join(" "), /min-height: 44px/);
  assert.match(definition.styles.join(" "), /flex-wrap: wrap/);
  const template = await fs.readFile(new URL("../apps/web/src/app/app.component.html", import.meta.url), "utf8");
  assert.match(template, /<app-model-settings \[threadId\]="modelThread.id"/);
});
