import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as rxjs from "rxjs";

async function compile(file, require, extra = {}) {
  const source = await fs.readFile(file, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require, ...extra });
  return exports;
}

async function extrasLoader() {
  return (await compile("apps/web/src/app/app-refresh-extras.ts", name => {
    if (name === "rxjs") return rxjs;
    throw new Error(name);
  })).refreshAppExtras;
}

test("optional setup panels update separately when another connector hangs or fails", async () => {
  const refresh = await extrasLoader();
  const whatsapp = new rxjs.Subject();
  const values = {};
  const done = refresh({
    systemSummary: () => rxjs.of({ cpu: { percent: 0 } }),
    timers: () => rxjs.throwError(() => new Error("unavailable")),
    whatsappStatus: () => whatsapp,
    version: () => rxjs.of({ version: "example" }),
  }, Object.fromEntries(["system", "timers", "whatsapp", "version"].map(key => [key, value => { values[key] = value; }])));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values.system.cpu.percent, 0);
  assert.equal(values.version.version, "example");
  assert.equal(values.whatsapp, undefined);
  whatsapp.error(new Error("offline"));
  await done;
});

async function shellHarness() {
  const source = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const file = ts.createSourceFile("app.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AppComponent");
  const refresh = declaration.members.find(node => node.name?.getText(file) === "refresh").getText(file);
  const compiled = ts.transpileModule(`class Harness { ${refresh} }; exports.Harness = Harness;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, firstValueFrom: rxjs.firstValueFrom, refreshAppExtras: await extrasLoader() });
  const pending = new rxjs.Subject();
  const app = Object.assign(new exports.Harness(), {
    api: {
      threads: () => rxjs.of({ threads: [{ id: "example" }] }),
      setupStatus: () => rxjs.of({ agentRuntime: { ready: true } }),
      currentUser: () => rxjs.of({ user: { role: "admin" } }),
      instanceContext: () => rxjs.of({ instance: {} }),
      systemSummary: () => pending, timers: () => pending, whatsappStatus: () => pending, version: () => pending,
    },
    sharedAppActive: () => false, publicAppsActive: () => false, connectorLoginActive: () => false,
    ownerLoginChecked: true, refreshClaudeRuntimeReady: async () => {}, runtimeGateActive: () => false,
    loadInstanceAccounts: () => {}, isPairingRequiredFromSetup: () => false,
    bootstrapAttachmentEncryption: async () => {}, redirectPairedBrowserFromPairingPath: async () => false,
    uiRuntimeReady: () => true, applyThreadListMeta: () => {}, trackThreadActivity: () => {},
    canonicalizeInstanceRoute: () => false, canonicalizeCurrentThreadRoute: () => false,
    seedReadStateIfNeeded: () => {}, normalizeUserModeView: () => false, shouldAutoOpenFirstRunWizard: () => false,
    defaultInstanceRootToLauncher: () => false, isRouteLevelUserPanel: () => true, selectedThread: () => null,
    syncThreadMetaDraft: () => {}, syncThreadBindingDraft: () => {}, syncThreadTextState: () => {},
    loadSelectedThread: async () => {}, updateDocumentTitle: () => {}, connectSummaryStream: () => {},
    renderNow: () => {}, errorText: error => String(error), enterPairingRequired: () => { app.pairingRequired = true; },
  });
  return { app, pending };
}

test("conversations render before optional requests, preserving the attachment setup gate", async () => {
  const { app, pending } = await shellHarness();
  let finishEncryption;
  app.bootstrapAttachmentEncryption = () => new Promise(resolve => { finishEncryption = resolve; });
  const refresh = app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(app.appReady, true, "required encryption initialization is still awaited");
  finishEncryption();
  await refresh;
  assert.equal(app.appReady, true);
  assert.equal(app.threads[0].id, "example");
  assert.equal(app.busy, false);
  assert.equal(app.error, "");
  pending.error(new Error("offline"));
});

test("an unpaired browser stays behind pairing and starts no optional panel requests", async () => {
  const { app, pending } = await shellHarness();
  app.isPairingRequiredFromSetup = () => true;
  await app.refresh();
  assert.equal(app.pairingRequired, true);
  assert.notEqual(app.appReady, true);
  assert.equal(pending.observed, false);
});

async function resources(api) {
  const cdr = { markForCheck() {} };
  class ApiService {}
  class ChangeDetectorRef {}
  const exported = await compile("apps/web/src/app/system-resources.component.ts", name => {
    if (name === "rxjs") return rxjs;
    if (name === "@angular/core") return { Component: () => () => {}, ChangeDetectorRef, inject: token => token === ApiService ? api : cdr };
    if (name === "@angular/common") return { DatePipe: class {} };
    if (name === "./api.service") return { ApiService };
    throw new Error(name);
  }, { setInterval, clearInterval });
  return new exported.SystemResourcesComponent();
}

test("resource readings distinguish a real zero from missing data and preserve a stale sample on error", async () => {
  let response = rxjs.of({ generatedAt: "2026-01-01T12:00:00Z", cpu: { percent: 0 }, memory: { percent: 25 } });
  const panel = await resources({ systemSummary: () => response, systemProcesses: () => { throw new Error("not requested"); } });
  assert.equal(panel.percent("cpu.percent"), "—");
  await panel.refresh();
  assert.equal(panel.percent("cpu.percent"), "0.0%");
  assert.equal(panel.percent("memory.percent"), "25.0%");
  assert.equal(panel.percent("disk.percent"), "—");
  response = rxjs.throwError(() => new Error("offline"));
  await panel.refresh();
  assert.equal(panel.sampledAt(), "2026-01-01T12:00:00Z");
  assert.match(panel.error, /last sample/);
  assert.equal(panel.busy, false);
});

test("resource refresh cannot pile up overlapping polls or restart after destruction", async () => {
  const response = new rxjs.Subject();
  let count = 0;
  const panel = await resources({ systemSummary: () => { count += 1; return response; } });
  const first = panel.refresh();
  await panel.refresh();
  assert.equal(count, 1);
  response.next({ cpu: { percent: 10 } });
  await first;
  panel.ngOnDestroy();
  await panel.refresh();
  assert.equal(count, 1);
});

test("System and other instance screens keep their own URL when a conversation was previously selected", async () => {
  const source = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const file = ts.createSourceFile("app.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AppComponent");
  const names = ["canonicalizeCurrentThreadRoute", "isGlobalPanel"];
  const methods = declaration.members.filter(node => names.includes(node.name?.getText(file))).map(node => node.getText(file)).join("\n");
  const compiled = ts.transpileModule(`class Harness { ${methods} }; exports.Harness = Harness;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  const app = new exports.Harness();
  app.selectedThread = () => ({ id: "previous-conversation" });
  app.canonicalPanelUrl = () => { throw new Error("instance screens must not become thread URLs"); };
  for (const panel of ["instanceSettings", "instanceApps", "instanceDesktops", "instanceTimers", "instanceVault", "files"]) {
    app.activePanel = panel;
    assert.equal(app.canonicalizeCurrentThreadRoute(), false, panel);
  }
});
