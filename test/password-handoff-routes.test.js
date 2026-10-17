import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { attachDesktopProxyUpgrade, registerDesktopProxy } from "../dist/server/apps/server/src/desktop-proxy.js";
import { BrowsersController } from "../dist/server/apps/server/src/modules/browsers/browsers.controller.js";
import { dataPaths } from "../packages/storage/src/paths.js";

// Server paths refuse a password-blind desktop before any upstream work.
// The open handoff is written straight to the store (synthetic, no Chrome).
async function openHandoff(t, slug) {
  const file = path.join(dataPaths(process.env).home, "password-handoffs.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const prior = await fs.readFile(file, "utf8").catch(() => null);
  await fs.writeFile(file, JSON.stringify({ handoffs: [{
    id: "pwh_route-test", ownerUserId: "owner", threadId: "pa-thread", desktopSlug: slug, targetId: "t", origin: "https://signup.example.test",
    selector: "", state: "open", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(),
  }] }));
  t.after(() => (prior === null ? fs.rm(file, { force: true }) : fs.writeFile(file, prior)));
}

const ownerSession = { id: "sess-owner" };
const ownerRequest = (extra = {}) => ({ orkestrSecuritySession: ownerSession, orkestrPrincipal: { kind: "user", userId: "owner", role: "admin" }, headers: {}, ...extra });

test("browser-session actions on a blind desktop: agents, machine auth and other users get 423", async (t) => {
  await openHandoff(t, "blind-desk");
  const controller = new BrowsersController();
  const denied = [
    { ...ownerRequest(), orkestrMachineAuth: "cli" },
    { ...ownerRequest(), orkestrSecuritySession: { id: "s", shareId: "share-1" } },
    ownerRequest({ orkestrPrincipal: { kind: "user", userId: "someone-else", role: "admin" } }),
    { headers: {} },
  ];
  for (const request of denied) {
    for (const action of ["stop", "navigate", "restart"]) {
      await assert.rejects(controller.browserSessionAction(request, "blind-desk", action, {}), (error) => {
        const response = error.getResponse?.() || {};
        return error.getStatus?.() === 423 && JSON.stringify(response).includes("desktop_password_blind");
      });
    }
  }
  await assert.rejects(controller.browserSessionAction(ownerRequest(), "blind-desk", "no-such-action", {}), (error) => !JSON.stringify(error.getResponse?.() || error.message).includes("desktop_password_blind"), "the owner's own session passes the blind guard");
});

test("desktop HTTP and websocket proxy refuse a blind desktop before resolving it", async (t) => {
  await openHandoff(t, "blind-desk");
  let handler = null;
  registerDesktopProxy({ use: (_prefix, fn) => { handler = fn; } });
  const send = async (request) => {
    const result = {};
    await new Promise((resolve) => {
      handler(request, { writeHead: (code) => { result.status = code; }, end: (body) => { result.body = String(body); resolve(); } });
    });
    return result;
  };
  for (const request of [{ originalUrl: "/desktop/blind-desk/vnc.html", url: "/blind-desk/vnc.html", headers: {}, orkestrMachineAuth: "cli" },
    { ...ownerRequest(), originalUrl: "/desktop/blind-desk/vnc.html", url: "/blind-desk/vnc.html", orkestrDesktopShare: { id: "share-1" } }]) {
    const result = await send(request);
    assert.equal(result.status, 423);
    assert.match(result.body, /desktop_password_blind/);
  }

  const prior = process.env.ORKESTR_HOST_BOUNDARIES;
  process.env.ORKESTR_HOST_BOUNDARIES = "0";
  t.after(() => (prior === undefined ? delete process.env.ORKESTR_HOST_BOUNDARIES : (process.env.ORKESTR_HOST_BOUNDARIES = prior)));
  const server = new EventEmitter();
  attachDesktopProxyUpgrade(server);
  const socket = new PassThrough();
  let response = "";
  socket.on("data", (chunk) => { response += chunk; });
  // The local operator proxy is machine auth, not a vault-owner session.
  await server.listeners("upgrade")[0]({ url: "/desktop/blind-desk/websockify", headers: { host: "localhost" }, rawHeaders: [], orkestrTrustedOperatorProxy: true }, socket, Buffer.alloc(0));
  assert.match(response, /^HTTP\/1.1 423 /);
  assert.match(response, /desktop_password_blind/);
  assert.equal(socket.destroyed, true);
});

test("viewer websockets still connecting when a handoff starts never get through", async (t) => {
  // Same module instance as the compiled proxy, so its disconnect notice fires.
  const { startPasswordHandoff } = await import("../dist/server/packages/core/src/password-handoff.js");
  const file = path.join(dataPaths(process.env).home, "password-handoffs.json");
  const prior = await fs.readFile(file, "utf8").catch(() => null);
  await fs.rm(file, { force: true });
  t.after(() => (prior === null ? fs.rm(file, { force: true }) : fs.writeFile(file, prior)));
  const priorBoundaries = process.env.ORKESTR_HOST_BOUNDARIES;
  process.env.ORKESTR_HOST_BOUNDARIES = "0";
  t.after(() => (priorBoundaries === undefined ? delete process.env.ORKESTR_HOST_BOUNDARIES : (process.env.ORKESTR_HOST_BOUNDARIES = priorBoundaries)));
  const server = new EventEmitter();
  attachDesktopProxyUpgrade(server);
  const handler = server.listeners("upgrade")[0];
  const viewers = [];
  // Viewers start at staggered points around the handoff start.
  for (let index = 0; index < 6; index += 1) {
    const socket = new PassThrough();
    let response = "";
    socket.on("data", (chunk) => { response += chunk; });
    viewers.push({ socket, response: () => response, done: handler({ url: "/desktop/race-desk/websockify", headers: { host: "localhost" }, rawHeaders: [], orkestrTrustedOperatorProxy: true }, socket, Buffer.alloc(0)) });
    if (index === 2) {
      await startPasswordHandoff(
        { kind: "user", userId: "owner", role: "admin", vaultOwner: true, recentAuthAt: new Date().toISOString() },
        { desktopSlug: "race-desk", threadId: "pa-thread", targetId: "t", origin: "https://signup.example.test" },
        process.env,
        {
          activeDesktopLeaseStatus: async () => ({ active: true, threadId: "pa-thread" }),
          readManagedDesktopSession: async () => ({ cdp_url: "http://127.0.0.1:9", profileDir: "" }),
          probePasswordField: async () => ({ ok: true, field: { found: true, isPassword: true, filled: false } }),
        },
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(viewers.map((viewer) => viewer.done));
  for (const viewer of viewers) {
    assert.equal(viewer.socket.destroyed, true);
    assert.doesNotMatch(viewer.response(), /^HTTP\/1.1 101 /);
  }
});

test("a desktop share opened for the owner's own session views a blind desktop; unbound shares do not", async (t) => {
  await openHandoff(t, "blind-desk");
  let handler = null;
  registerDesktopProxy({ use: (_prefix, fn) => { handler = fn; } });
  const send = (request) => new Promise((resolve) => {
    const result = {};
    handler({ originalUrl: "/desktop/blind-desk/vnc.html", url: "/blind-desk/vnc.html", headers: {}, ...request }, {
      writeHead: (code) => { result.status = code; }, end: (body) => { result.body = String(body); resolve(result); },
    });
  });
  const share = { id: "share-1" };
  const shareViewer = { kind: "user", userId: "owner", role: "admin" };
  const unbound = await send({ orkestrDesktopShare: share, orkestrSecuritySession: null, orkestrPrincipal: shareViewer });
  assert.equal(unbound.status, 423, "a link-only share is not the owner");
  const otherUser = await send({ orkestrDesktopShare: share, orkestrSecuritySession: { id: "sess-b", userId: "someone-else" }, orkestrPrincipal: shareViewer });
  assert.equal(otherUser.status, 423, "a share bound to another user's session is not the owner");
  const bound = await send({ orkestrDesktopShare: share, orkestrSecuritySession: { id: "sess-owner", userId: "owner" }, orkestrPrincipal: shareViewer });
  assert.notEqual(bound.status, 423, bound.body);
  assert.doesNotMatch(bound.body, /desktop_password_blind/, "the owner's own session-bound share passes the blind guard");
});
