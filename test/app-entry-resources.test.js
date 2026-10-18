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

async function setupLoader() {
  return (await compile("apps/web/src/app/app-setup-refresh.ts", name => {
    if (name === "rxjs") return rxjs;
    throw new Error(name);
  })).startAppSetupRefresh;
}

async function shellHarness() {
  const source = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const file = ts.createSourceFile("app.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AppComponent");
  const refresh = declaration.members.find(node => node.name?.getText(file) === "refresh").getText(file);
  const compiled = ts.transpileModule(`class Harness { ${refresh} }; exports.Harness = Harness;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, firstValueFrom: rxjs.firstValueFrom, refreshAppExtras: await extrasLoader(), startAppSetupRefresh: await setupLoader() });
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
    refreshGeneration: 0, ownerLoginChecked: true, refreshClaudeRuntimeReady: async () => {}, runtimeGateActive: () => false,
    loadInstanceAccounts: () => {}, isPairingRequiredFromSetup: () => false,
    bootstrapAttachmentEncryption: async () => {}, redirectPairedBrowserFromPairingPath: async () => false,
    uiRuntimeReady: () => true, applyThreadListMeta: () => {}, trackThreadActivity: () => {},
    canonicalizeInstanceRoute: () => false, canonicalizeCurrentThreadRoute: () => false,
    seedReadStateIfNeeded: () => {}, normalizeUserModeView: () => false, shouldAutoOpenFirstRunWizard: () => false,
    defaultInstanceRootToLauncher: () => false, isRouteLevelUserPanel: () => true, selectedThread: () => null,
    syncThreadMetaDraft: () => {}, syncThreadBindingDraft: () => {}, syncThreadTextState: () => {},
    loadSelectedThread: async () => {}, updateDocumentTitle: () => {}, connectSummaryStream: () => {},
    isPairingRequiredError: error => error?.message === "browser_pairing_required",
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

test("authenticated conversation and messages display while setup probes are still pending", async () => {
  const { app, pending } = await shellHarness();
  const setup = new rxjs.Subject();
  app.api.setupStatus = () => setup;
  let loaded = false;
  app.loadSelectedThread = async () => { loaded = true; };
  const refresh = app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.appReady, true);
  assert.equal(app.threads[0].id, "example");
  assert.equal(loaded, true);
  assert.equal(app.setupStatus, undefined);
  assert.equal(app.busy, false);
  setup.next({ agentRuntime: { ready: true } });
  await refresh;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.setupStatus.agentRuntime.ready, true);
  pending.complete();
});

test("setup failure does not discard authenticated conversation data", async () => {
  const { app, pending } = await shellHarness();
  app.api.setupStatus = () => rxjs.throwError(() => new Error("diagnostics unavailable"));
  await app.refresh();
  assert.equal(app.threads[0].id, "example");
  assert.equal(app.appReady, true);
  assert.equal(app.error, "");
  pending.complete();
});

test("rejected protected thread or user requests cannot open conversations before setup", async () => {
  for (const denied of ["threads", "currentUser"]) {
    const { app, pending } = await shellHarness();
    const setup = new rxjs.Subject();
    app.api.setupStatus = () => setup;
    app.api[denied] = () => rxjs.throwError(() => new Error("browser_pairing_required"));
    await app.refresh();
    assert.equal(app.pairingRequired, true);
    assert.equal(app.threads, undefined);
    assert.equal(pending.observed, false);
    app.cancelSetupRefresh();
  }
});

test("replacement refresh cancels setup and late stale core responses cannot overwrite current threads", async () => {
  const { app, pending } = await shellHarness();
  const setup = new rxjs.Subject(), threads = new rxjs.Subject();
  app.api.setupStatus = () => setup;
  app.api.threads = () => threads;
  const stale = app.refresh();
  app.api.setupStatus = () => rxjs.of({ agentRuntime: { ready: true } });
  app.api.threads = () => rxjs.of({ threads: [{ id: "new" }] });
  await app.refresh();
  assert.equal(setup.observed, false);
  threads.next({ threads: [{ id: "old" }] });
  await stale;
  assert.equal(app.threads[0].id, "new");
  assert.equal(app.busy, false);
  pending.complete();
});

test("setup cancellation suppresses late asynchronous failures and timeout is handled", async () => {
  const start = await setupLoader();
  let fail, failures = 0;
  const cancel = start(rxjs.of({}), {
    apply: () => new Promise((resolve, reject) => { fail = reject; }),
    failed: () => { failures++; },
  });
  cancel(); fail(new Error("late"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failures, 0);
  await new Promise(resolve => {
    start(rxjs.NEVER, { apply: async () => assert.fail("unexpected result"), failed: () => { failures++; resolve(); } }, 10);
  });
  assert.equal(failures, 1);
});

test("a late pairing denial during owner-status loading cannot be cleared by the core refresh", async () => {
  const { app, pending } = await shellHarness();
  const setup = new rxjs.Subject();
  let finishOwner;
  app.ownerLoginChecked = false;
  app.loadOwnerLoginStatus = () => new Promise(resolve => { finishOwner = resolve; });
  app.api.setupStatus = () => setup;
  app.appReady = true;
  app.threads = [{ id: "cached-thread" }];
  let enrollments = 0, messageLoads = 0, revealedAfterDenial = false, denied = false;
  app.bootstrapAttachmentEncryption = async () => { enrollments++; };
  app.loadSelectedThread = async () => { messageLoads++; };
  app.renderNow = () => {
    if (denied && app.appReady && !app.pairingRequired) revealedAfterDenial = true;
  };
  // The template gives pairing precedence even when previously loaded data exists.
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  assert.match(template, /^@if \(pairingRequired\)/);
  const refresh = app.refresh();
  await new Promise(resolve => setImmediate(resolve));
  denied = true;
  setup.error(new Error("browser_pairing_required"));
  assert.equal(app.pairingRequired, true);
  finishOwner(); await refresh;
  assert.equal(app.pairingRequired, true);
  assert.equal(enrollments, 0, "denial prevents attachment enrollment");
  assert.equal(messageLoads, 0);
  assert.equal(revealedAfterDenial, false, "cached threads stay behind the pairing gate");
  assert.equal(app.threads[0].id, "cached-thread", "denied continuation never applies fetched threads");
  assert.equal(pending.observed, false);
});
