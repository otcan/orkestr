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

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    run(ms) { for (const timer of timers.filter((entry) => entry.ms === ms && !entry.cleared)) { timer.cleared = true; timer.fn(); } },
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeDocument(state = "visible") {
  return { visibilityState: state, addEventListener() {}, removeEventListener() {}, querySelector: () => null };
}

test("app shell wires the Vault page next to the instance pages", async () => {
  const [component, template, styles] = await Promise.all([
    read("app.component.ts"), read("app.component.html"), fs.readFile(new URL("../styles.css", appDir), "utf8"),
  ]);
  assert.match(component, /import \{ VaultPageComponent \} from "\.\/vault-page\.component"/);
  assert.match(component, /type Panel = .*"instanceVault"/);
  assert.match(component, /parts\[0\] === "vault" \|\| \(parts\[0\] === "ng" && parts\[1\] === "vault"\)\) return "instanceVault"/);
  assert.match(component, /panel === "instanceVault"\) return this\.instancePath\("\/vault"\)/);
  assert.match(component, /globalThis\.document\.title = "Vault · Orkestr"/);
  assert.match(template, /\(click\)="openPanel\('instanceVault'\)">Vault<\/button>/);
  assert.match(template, /<ork-vault-page \[threads\]="threads"><\/ork-vault-page>/);
  assert.match(styles, /ork-vault-page\n\) > \.panel-body/);
});

test("vault API service uses the agreed endpoints", async () => {
  const calls = [];
  const record = (method) => (url, body) => { calls.push([method, url, body]); return rxjs.of({}); };
  const http = { get: record("GET"), post: record("POST"), patch: record("PATCH"), put: record("PUT"), delete: record("DELETE") };
  const { load } = createLoader({ http, context: { document: fakeDocument() } });
  const { VaultApiService } = await load("vault-api.service");
  const api = new VaultApiService();
  api.items();
  api.createItem({ name: "Example" });
  api.updateItem("item/1", { password: "" });
  api.deleteItem("item-1");
  api.reveal("item-1");
  api.totp("item-1");
  api.totpSecret("item-1");
  api.importItems("auto", "csv");
  api.setGrants("item-1", ["thread-a"]);
  api.approvals();
  api.decideApproval("ap-1", "approve");
  api.decideApproval("ap-1", "deny");
  api.status();
  assert.deepEqual(calls.map(([method, url]) => `${method} ${url}`), [
    "GET /api/vault/items",
    "POST /api/vault/items",
    "PATCH /api/vault/items/item%2F1",
    "DELETE /api/vault/items/item-1",
    "POST /api/vault/items/item-1/reveal",
    "GET /api/vault/items/item-1/totp",
    "POST /api/vault/items/item-1/totp-secret",
    "POST /api/vault/import",
    "PUT /api/vault/items/item-1/grants",
    "GET /api/vault/approvals",
    "POST /api/vault/approvals/ap-1/approve",
    "POST /api/vault/approvals/ap-1/deny",
    "GET /api/vault/status",
  ]);
  assert.deepEqual(plain(calls[2][2]), { password: "" });
  assert.deepEqual(plain(calls[7][2]), { format: "auto", content: "csv" });
  assert.deepEqual(plain(calls[8][2]), { threadIds: ["thread-a"] });
});

async function vaultPage(api, context = {}) {
  const timers = fakeTimers();
  const document = fakeDocument();
  const { load, sandbox } = createLoader({ api, context: { document, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, ...context } });
  const { VaultPageComponent } = await load("vault-page.component");
  return { page: new VaultPageComponent(), timers, document, sandbox, load };
}

test("reveal asks the user to sign in again when the vault needs reauth", async () => {
  const reauth = { status: 401, error: { error: "vault_reauth_required" } };
  const { page, load } = await vaultPage({ reveal: () => rxjs.throwError(() => reauth), totpSecret: () => rxjs.throwError(() => reauth) });
  const item = { id: "item-1", name: "Example", hasPassword: true, hasTotp: true, threadGrants: [] };
  await page.showPassword(item);
  assert.equal(page.reauthNeeded, true);
  assert.equal(page.revealed, null);
  assert.equal(page.error, "");
  page.reauthNeeded = false;
  await page.exportSecret(item);
  assert.equal(page.reauthNeeded, true);

  const secrets = await load("vault-secrets");
  assert.equal(secrets.vaultReauthUrl({ pathname: "/i/demo/app/vault", search: "?q=1" }), "/auth/login?return=%2Fi%2Fdemo%2Fapp%2Fvault%3Fq%3D1");
  assert.equal(secrets.isVaultReauthRequired({ status: 401, error: { error: "unauthorized" } }), false);
  const template = await read("vault-page.component.html");
  assert.match(template, /\(click\)="signInAgain\(\)">Sign in again to reveal<\/button>/);
  assert.match(await read("vault-page.component.ts"), /signInAgain\(\): void \{[\s\S]+?location\?\.assign\(vaultReauthUrl\(\)\)/);
});

test("approvals banner approves and denies pending code requests", async () => {
  const decisions = [];
  const pending = [
    { id: "ap-1", itemId: "item-1", itemName: "Example Mail", threadId: "thread-a", threadName: "Inbox helper", status: "pending" },
    { id: "ap-2", itemId: "item-2", itemName: "Example Bank", threadId: "thread-b", threadName: "Finance", status: "pending" },
    { id: "ap-3", itemId: "item-2", itemName: "Example Bank", threadId: "thread-b", threadName: "Finance", status: "denied" },
  ];
  let list = pending;
  const { page } = await vaultPage({
    approvals: () => rxjs.of({ approvals: list }),
    decideApproval: (id, decision) => { decisions.push([id, decision]); list = list.filter((entry) => entry.id !== id); return rxjs.of({ approval: {} }); },
  });
  await page.loadApprovals();
  assert.deepEqual(page.approvals.map((approval) => approval.id), ["ap-1", "ap-2"]);
  await page.decide(page.approvals[0], "approve");
  await page.decide(page.approvals[0], "deny");
  assert.deepEqual(decisions, [["ap-1", "approve"], ["ap-2", "deny"]]);
  assert.equal(page.approvals.length, 0);

  const [template, component] = await Promise.all([read("vault-page.component.html"), read("vault-page.component.ts")]);
  assert.match(template, /approval\.threadName[\s\S]+?wants a code for[\s\S]+?approval\.itemName/);
  assert.match(template, /\(click\)="decide\(approval, 'approve'\)"[^>]*>Approve<\/button>/);
  assert.match(template, /\(click\)="decide\(approval, 'deny'\)"[^>]*>Deny<\/button>/);
  assert.match(component, /const approvalPollMs = 10_000;/);
});

test("password generator uses crypto.getRandomValues and honours length and charsets", async () => {
  let randomCalls = 0;
  const crypto = { getRandomValues: (array) => { randomCalls += 1; return globalThis.crypto.getRandomValues(array); } };
  const { load } = createLoader({ context: { crypto } });
  const { generatePassword, passwordCharsetChars } = await load("vault-secrets");
  const all = { lower: true, upper: true, digits: true, symbols: true };
  assert.equal(generatePassword(24, all).length, 24);
  assert.ok(randomCalls >= 24);
  assert.equal(generatePassword(3, all).length, 12);
  assert.equal(generatePassword(500, all).length, 64);
  const digitsOnly = generatePassword(40, { lower: false, upper: false, digits: true, symbols: false });
  assert.match(digitsOnly, new RegExp(`^[${passwordCharsetChars.digits}]{40}$`));
  const mixed = generatePassword(12, { lower: true, upper: true, digits: false, symbols: false });
  assert.match(mixed, /[a-z]/);
  assert.match(mixed, /[A-Z]/);
  assert.doesNotMatch(mixed, /[0-9!@#$%^&*]/);
  const source = await read("vault-secrets.ts");
  assert.match(source, /globalThis\.crypto\.getRandomValues/);
  assert.doesNotMatch(source, /Math\.random/);
});

test("revealed secrets are cleared after 30 seconds and when leaving the page", async () => {
  const { page, timers } = await vaultPage({ reveal: () => rxjs.of({ password: "example-only", notes: "" }) });
  const item = { id: "item-1", name: "Example", hasPassword: true, hasTotp: false, threadGrants: [] };
  await page.showPassword(item);
  assert.equal(page.revealed?.value, "example-only");
  timers.run(30_000);
  assert.equal(page.revealed, null);
  await page.showPassword(item);
  page.ngOnDestroy();
  assert.equal(page.revealed, null);
  const template = await read("vault-page.component.html");
  assert.match(template, /@if \(revealed\?\.itemId === item\.id\)/);
  assert.doesNotMatch(await read("vault-page.component.ts"), /console\./);
});

test("authenticator codes are fetched only for visible rows while the page is visible", async () => {
  const fetched = [];
  const { page, document } = await vaultPage({ totp: (id) => { fetched.push(id); return rxjs.of({ code: "123456", expiresInSeconds: 20, period: 30, digits: 6 }); } });
  const rows = [
    { id: "a", name: "A", hasTotp: true, hasPassword: false, threadGrants: [] },
    { id: "b", name: "B", hasTotp: true, hasPassword: false, threadGrants: [] },
    { id: "c", name: "C", hasTotp: false, hasPassword: true, threadGrants: [] },
  ];
  page.items = rows;
  page.setRowVisible(rows[0], true);
  page.setRowVisible(rows[2], true);
  await page.tick();
  assert.deepEqual(fetched, ["a"]);
  assert.equal(page.totp.code("a")?.code, "123456");
  await page.tick();
  assert.deepEqual(fetched, ["a"], "a live code is not refetched before it expires");

  page.totp.codes.clear();
  document.visibilityState = "hidden";
  page.setRowVisible(rows[1], true);
  await page.tick();
  assert.deepEqual(fetched, ["a"], "hidden page does not fetch codes");
  document.visibilityState = "visible";
  page.setRowVisible(rows[0], false);
  await page.tick();
  assert.deepEqual(fetched, ["a", "b"]);
});

test("vault fields opt out of autofill and analytics", async () => {
  const [form, page, imports] = await Promise.all([
    read("vault-item-form.component.html"), read("vault-page.component.html"), read("vault-import-dialog.component.html"),
  ]);
  assert.match(form, /name="password"[^>]*autocomplete="new-password"[^>]*data-analytics-ignore/);
  assert.match(form, /<form[^>]*autocomplete="off"/);
  assert.match(page, /class="vault-code-digits" data-analytics-ignore data-private/);
  assert.match(imports, /name="content"[^>]*autocomplete="off"[^>]*data-analytics-ignore/);
});
