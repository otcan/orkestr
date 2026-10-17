import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as rxjs from "rxjs";

const appDir = new URL("../apps/web/src/app/", import.meta.url);
const read = (name) => fs.readFile(new URL(name, appDir), "utf8");

// Compiles app TypeScript modules into one vm context. Local imports are
// compiled recursively; Angular is replaced with inert decorators.
function createLoader({ api = {}, http = null, context = {} } = {}) {
  const sandbox = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Promise, Uint32Array, Math, Date, Set, Map, Object, Array, String, Number, JSON, RegExp, Error,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    ...context,
  });
  const cache = new Map();
  const decorator = () => () => {};
  const angularCore = {
    Component: decorator, Directive: decorator, Injectable: decorator, Input: decorator, Output: decorator, ViewChild: decorator,
    EventEmitter: class { emit() {} },
    ElementRef: class {},
    inject: (token) => (token?.name === "HttpClient" ? http : api),
  };
  const external = {
    rxjs,
    "@angular/core": angularCore,
    "@angular/common/http": { HttpClient: class HttpClient {} },
    "@angular/forms": { FormsModule: class {} },
  };
  async function load(name) {
    if (cache.has(name)) return cache.get(name);
    const source = await read(`${name}.ts`);
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
    } }).outputText;
    const deps = [...compiled.matchAll(/require\("\.\/([^"]+)"\)/g)].map((match) => match[1]);
    const local = {};
    for (const dep of deps) local[dep] = await load(dep);
    const exports = {};
    const fn = vm.runInContext(`(function (exports, require) {${compiled}\n})`, sandbox);
    fn(exports, (request) => {
      if (request in external) return external[request];
      if (request.startsWith("./")) return local[request.slice(2)];
      throw new Error(`Unexpected import: ${request}`);
    });
    cache.set(name, exports);
    return exports;
  }
  return { load, sandbox };
}

// The password handoff panel only exchanges ids, origins and status words.
test("password handoff panel: lists the lease thread and https tabs, starts, shows status and ends", async () => {
  const calls = [];
  let open = [];
  const http = {
    get(url, options) {
      calls.push(["GET", url, options?.params || null]);
      if (url.endsWith("/password-handoffs")) return rxjs.of({ handoffs: open });
      if (url.endsWith("/password-handoffs/targets")) return rxjs.of({ desktopSlug: "pa-desk", threadId: "pa-thread", tabs: [{ targetId: "tab-1", origin: "https://signup.example.test" }] });
      return rxjs.of({ ...open[0], status: "accepted", chromeFilled: true });
    },
    post(url, body) {
      calls.push(["POST", url, body]);
      if (url.endsWith("/end")) { open = []; return rxjs.of({ state: "ended" }); }
      open = [{ id: "pwh_1", desktopSlug: "pa-desk", threadId: "pa-thread", origin: body.origin, state: "open", expiresAt: "" }];
      return rxjs.of(open[0]);
    },
  };
  const api = { browserSessions: () => rxjs.of({ sessions: [{ slug: "pa-desk" }] }) };
  const { load } = createLoader({ api, http, context: { document: { querySelector: () => null } } });
  const { PasswordHandoffPanelComponent, handoffStatusText } = await load("password-handoff-panel.component");
  const panel = new PasswordHandoffPanelComponent();
  await panel.openStart();
  assert.equal(panel.targets.threadId, "pa-thread");
  assert.equal(panel.targetId, "tab-1");
  await panel.start();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find((call) => call[0] === "POST")[2])), {
    desktop: "pa-desk", threadId: "pa-thread", targetId: "tab-1", origin: "https://signup.example.test",
  });
  assert.equal(panel.handoffs[0].status, "accepted");
  assert.match(handoffStatusText(panel.handoffs[0]), /Not saved yet/);
  await panel.end(panel.handoffs[0], "owner_ended");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-2))), ["POST", "/api/vault/password-handoffs/pwh_1/end", { reason: "owner_ended" }]);
  assert.equal(panel.handoffs.length, 0);
  assert.match(handoffStatusText({ status: "unknown", reason: "ambiguous_tab" }), /another tab/);
  assert.match(handoffStatusText({ status: "saved_verified" }), /Saved in Chrome/);
});

test("vault page includes the password handoff panel", async () => {
  const [component, template] = await Promise.all([read("vault-page.component.ts"), read("vault-page.component.html")]);
  assert.match(component, /PasswordHandoffPanelComponent/);
  assert.match(template, /<ork-password-handoff-panel \(reauth\)="reauthNeeded = true"><\/ork-password-handoff-panel>/);
});
