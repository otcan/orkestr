import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as rxjs from "rxjs";
import * as links from "../apps/web/src/app/thread-link-index.js";

async function harness({ permission = "granted", threadResponse = rxjs.of({ threads: [] }) } = {}) {
  const source = await fs.readFile("apps/web/src/app/gmail-browser-notification.service.ts", "utf8");
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
  } }).outputText;
  const shown = [], storage = new Map();
  let threadRequests = 0;
  class Notification {
    static permission = permission;
    constructor(title, options) { this.title = title; this.options = options; shown.push(this); }
    close() {}
  }
  const api = {
    gmailNotifications: () => rxjs.of({ notifications: [] }),
    threads: () => { threadRequests += 1; return threadResponse; },
  };
  const context = {
    exports: {}, Notification, URL, setInterval, clearInterval,
    location: { origin: "https://example.com", href: "" },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    require(name) {
      if (name === "rxjs") return rxjs;
      if (name === "@angular/core") return { Injectable: () => () => {}, inject: () => api };
      if (name === "./api.service") return { ApiService: class {} };
      if (name === "./thread-link-index.js") return links;
      throw new Error(name);
    },
  };
  vm.runInNewContext(output, context);
  return { service: new context.exports.GmailBrowserNotificationService(), context, shown, threadRequests: () => threadRequests };
}

const rule = { id: "example-rule", label: "Inbox", targetType: "thread", target: "example-thread", lastDeliveredAt: "2026-01-01T12:00:00Z" };
const changed = { ...rule, lastDeliveredAt: "2026-01-01T12:01:00Z" };

test("page entry and unchanged Gmail polls do not request the conversation list", async () => {
  const h = await harness();
  await h.service.sync();
  await h.service.sync([rule]);
  await h.service.sync([rule]);
  assert.equal(h.threadRequests(), 0);
  assert.equal(h.shown.length, 0);
});

test("a new visible notification resolves its canonical thread link once and stays deduplicated", async () => {
  const canonicalUrl = "https://example.com/instance/ins_example/thread/thr_example";
  const h = await harness({ threadResponse: rxjs.of({ threads: [{ id: rule.target, canonicalUrl }] }) });
  await h.service.sync([rule]);
  await h.service.sync([changed]);
  await h.service.sync([changed]);
  assert.equal(h.threadRequests(), 1);
  assert.equal(h.shown.length, 1);
  h.shown[0].onclick();
  assert.equal(h.context.location.href, canonicalUrl);
});

test("disabled browser notifications and non-thread destinations need no thread links", async () => {
  for (const permission of ["denied", "default"]) {
    const h = await harness({ permission });
    await h.service.sync([rule]);
    await h.service.sync([changed]);
    assert.equal(h.threadRequests(), 0);
    assert.equal(h.shown.length, 0);
  }
  const h = await harness();
  await h.service.sync([{ ...rule, targetType: "whatsapp" }]);
  await h.service.sync([{ ...changed, targetType: "whatsapp" }]);
  assert.equal(h.threadRequests(), 0);
  assert.equal(h.shown.length, 1);
});

test("a failed link lookup still shows the notification and uses the route fallback", async () => {
  const h = await harness({ threadResponse: rxjs.throwError(() => new Error("offline")) });
  await h.service.sync([rule]);
  await h.service.sync([changed]);
  assert.equal(h.shown.length, 1);
  h.shown[0].onclick();
  assert.equal(h.context.location.href, "/thread/example-thread");
  await h.service.sync([changed]);
  assert.equal(h.shown.length, 1);
});

test("an in-flight link lookup cannot duplicate a notification on overlapping polls", async () => {
  const response = new rxjs.Subject();
  const h = await harness({ threadResponse: response });
  await h.service.sync([rule]);
  const sync = h.service.sync([changed]);
  await h.service.sync([changed]);
  assert.equal(h.threadRequests(), 1);
  response.next({ threads: [] });
  await sync;
  assert.equal(h.shown.length, 1);
});
