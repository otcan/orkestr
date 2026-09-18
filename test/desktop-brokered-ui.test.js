import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as rxjs from "rxjs";

const opsComponentUrl = new URL("../apps/web/src/app/ops-page.component.ts", import.meta.url);
const userDeskComponentUrl = new URL("../apps/web/src/app/user-desk-page.component.ts", import.meta.url);
const userDeskTemplateUrl = new URL("../apps/web/src/app/user-desk-page.component.html", import.meta.url);

test("desktop open controls exchange the current Keycloak session for brokered desktop access", async () => {
  const [opsComponent, userDeskComponent, userDeskTemplate] = await Promise.all([
    fs.readFile(opsComponentUrl, "utf8"),
    fs.readFile(userDeskComponentUrl, "utf8"),
    fs.readFile(userDeskTemplateUrl, "utf8"),
  ]);

  assert.match(opsComponent, /async openBrowserDesktop[\s\S]+?openDesktopSession\(slug, request\)/);
  assert.match(opsComponent, /if \(threadId\) return \{ threadId, start: false \};/);
  assert.match(userDeskComponent, /async openDesktop[\s\S]+?openDesktopSession\(slug, \{[\s\S]+?start: false/);
  assert.match(opsComponent, /async shareDesktop[\s\S]+?createDesktopShare\(slug, request\)/);
  assert.match(userDeskComponent, /async shareDesktop[\s\S]+?createDesktopShare\(slug, \{[\s\S]+?start: false/);
  assert.match(userDeskTemplate, /\(click\)="openDesktop\(browser\)"/);
  assert.doesNotMatch(userDeskTemplate, /\[href\]="browserOpenUrl\(browser\)"/);
});

test("user desktop lifecycle controls exchange the live lease for a single-use capability", async () => {
  const userDeskComponent = await fs.readFile(userDeskComponentUrl, "utf8");

  assert.match(userDeskComponent, /issueDesktopCapability\(threadId, \{[\s\S]+?fencingToken,[\s\S]+?scope: "lifecycle"/);
  assert.match(userDeskComponent, /browserAction\(slug, action, \{[\s\S]+?desktopCapability: issued\.capability/);
});

test("desktop inventory bounds refreshes and keeps reservation loading independent", async () => {
  const [userDeskComponent, userDeskTemplate] = await Promise.all([
    fs.readFile(userDeskComponentUrl, "utf8"),
    fs.readFile(userDeskTemplateUrl, "utf8"),
  ]);

  assert.match(userDeskComponent, /Promise\.allSettled\(/);
  assert.match(userDeskComponent, /timeout\(\{ first: 7_000 \}\)/);
  assert.match(userDeskComponent, /inventoryUnavailable = true/);
  assert.match(userDeskTemplate, /Desktop inventory unavailable/);
  assert.match(userDeskTemplate, /!inventoryUnavailable && !reservationsUnavailable/);
});

async function deskWithApi(api) {
  const source = await fs.readFile(userDeskComponentUrl, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (name) => {
    if (name === "rxjs") return rxjs;
    if (name === "@angular/core") return { Component: () => () => {}, Input: () => () => {}, inject: () => api };
    if (name === "@angular/common") return { DatePipe: class {} };
    if (name === "./api.service") return { ApiService: class {} };
    throw new Error(`Unexpected import: ${name}`);
  } });
  const desk = new exports.UserDeskPageComponent();
  desk.threads = [{ id: "thread-a" }];
  return desk;
}

test("reservation failures retain only a same-thread snapshot, block actions, and recover", async () => {
  const browser = { slug: "desk", status: "running" };
  const lease = { desktopSlug: "desk", threadId: "thread-a", fencingToken: "test-only" };
  let inventory = rxjs.of({ ok: true, sessions: [browser] });
  let reservations = rxjs.of({ ok: true, desktopLeases: [lease] });
  const desk = await deskWithApi({ browserSessions: () => inventory, desktopLeases: () => reservations });
  await desk.load();
  assert.equal(desk.browserLease(browser), lease);
  assert.equal(desk.actionBusy(browser), false);
  for (const failure of [rxjs.throwError(() => new Error("unavailable")), rxjs.of({ ok: false })]) {
    reservations = failure;
    await desk.load();
    assert.equal(desk.browserLease(browser), lease);
    assert.equal(desk.availableCount(), null);
    assert.equal(desk.leaseLabel(null), "Reservation status unknown");
    assert.equal(desk.actionBusy(browser), true);
    // No mutation API or window exists in this harness: any attempted action fails.
    await desk.acquireDesk(browser);
    await desk.releaseDesk(browser);
    await desk.shareDesktop(browser);
    await desk.openDesktop(browser);
    await desk.browserAction(browser, "stop");
  }
  inventory = rxjs.throwError(() => new Error("inventory unavailable"));
  reservations = rxjs.of({ ok: true, desktopLeases: [lease] });
  await desk.load();
  assert.equal(desk.inventoryUnavailable, true);
  assert.equal(desk.leases[0], lease);
  inventory = rxjs.of({ ok: true, sessions: [browser] });
  reservations = rxjs.of({ ok: true, desktopLeases: [] });
  await desk.load();
  assert.equal(desk.inventoryUnavailable, false);
  assert.equal(desk.reservationsUnavailable, false);
  assert.equal(desk.availableCount(), 1);
  assert.equal(desk.leaseLabel(null), "Available");
  assert.equal(desk.actionBusy(browser), false);
  desk.leases = [lease];
  desk.threads = [{ id: "thread-b" }];
  reservations = rxjs.throwError(() => new Error("unavailable"));
  await desk.load();
  assert.equal(desk.leases.length, 0);
  assert.equal(desk.actionBusy(browser), true);
});

test("late inventory and lease responses cannot overwrite a newer thread refresh", async () => {
  const oldInventory = new rxjs.Subject();
  const oldLeases = new rxjs.Subject();
  const desk = await deskWithApi({
    browserSessions: (id) => id === "thread-a" ? oldInventory : rxjs.of({ sessions: [{ slug: "new" }] }),
    desktopLeases: (_, id) => id === "thread-a" ? oldLeases : rxjs.of({ ok: true, desktopLeases: [] }),
  });
  const pending = desk.load();
  desk.threads = [{ id: "thread-b" }];
  await desk.load();
  oldInventory.next({ sessions: [{ slug: "old" }] });
  oldLeases.next({ ok: true, desktopLeases: [{ desktopSlug: "old" }] });
  await pending;
  assert.equal(desk.browsers[0].slug, "new");
  assert.equal(desk.leases.length, 0);
  assert.equal(desk.busy, false);
});
