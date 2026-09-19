import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { registerDesktopProxy } from "../dist/server/apps/server/src/desktop-proxy.js";
import { createThread } from "../dist/server/packages/core/src/threads.js";
import { adminPrincipal } from "../dist/server/packages/core/src/principal.js";
import { advanceDesktopResourceGeneration, setThreadDesktopGrants } from "../dist/server/packages/core/src/desktop-access.js";
import { createDesktopShare, openDesktopShare, approveDesktopShareChallenge, revokeDesktopShare } from "../dist/server/packages/core/src/desktop-shares.js";

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

test("real proxy cold asset fanout uses one raw lookup with enforced grants and approved share", async (t) => {
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  Object.assign(process.env, {
    ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "desktop-proxy-init-")),
    ORKESTR_DESKTOP_ACCESS_MODE: "enforce", ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_BROWSER_DESKTOP_MODE: "browserctl", ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "desk", ORKESTR_BROWSER_SESSIONS_URL: "",
  });
  let assetRequests = 0;
  const assetPort = await listen(t, http.createServer((req, res) => {
    assetRequests++;
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("export const fixture = true;");
  }));
  let reads = 0;
  const inventoryPort = await listen(t, http.createServer(async (req, res) => {
    reads++;
    assert.equal(req.method, "GET");
    assert.equal(req.headers["x-orkestr-owner-user-id"], "admin");
    assert.equal(req.headers["x-orkestr-thread-id"], "fixture-thread");
    await delay(250);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, sessions: [{ slug: "desk", status: "running", ownerUserId: "admin", web_port: assetPort }] }));
  }));
  process.env.ORKESTR_BROWSER_API_URL = `http://127.0.0.1:${inventoryPort}`;
  const principal = adminPrincipal("admin");
  await createThread({ id: "fixture-thread", ownerUserId: "admin", name: "Fixture", cwd: process.env.ORKESTR_HOME });
  await advanceDesktopResourceGeneration("desk", "admin", { reason: "fixture" });
  await setThreadDesktopGrants("fixture-thread", ["desk"], { principal, reason: "fixture" });
  const created = await createDesktopShare({ desktopSlug: "desk", principal, threadId: "fixture-thread" });
  const url = new URL(created.url);
  const opened = await openDesktopShare({ shareId: url.pathname.split("/").at(-1), key: url.searchParams.get("key"), subdomain: created.subdomain });
  const approved = await approveDesktopShareChallenge(opened.attempt.challenge, { approvedBy: "fixture" });
  let handler;
  registerDesktopProxy({ use: (_, fn) => { handler = fn; } });
  const proxyPort = await listen(t, http.createServer((req, res) => {
    // Authentication itself is covered by security.test.js; emulate its verified
    // outputs here to exercise the real proxy, policy store and raw adapter.
    req.orkestrPrincipal = principal;
    req.orkestrDesktopShare = approved.share;
    req.orkestrDesktopShareAttempt = approved.attempt;
    handler(req, res);
  }));
  const request = () => fetch(`http://127.0.0.1:${proxyPort}/desktop/desk/core/rfb.js`);
  for (const count of [6, 16, 44]) {
    const before = reads;
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: count }, async () => {
      const res = await request();
      assert.equal(res.status, 200);
      assert.match(await res.text(), /fixture = true/);
    }));
    assert.equal(results.length, count);
    assert.equal(reads - before, 1, "each cold wave should have one raw target read");
    assert.ok(performance.now() - start < 3000, "local fixture fanout budget");
    t.diagnostic(`${count} real proxy requests: ${Math.round(performance.now() - start)}ms, one target read`);
  }
  assert.equal(assetRequests, 66);
  await revokeDesktopShare(approved.share.id, { reason: "fixture" });
  assert.notEqual((await request()).status, 200);
  assert.equal(assetRequests, 66, "revoked share cannot contact upstream");
  await setThreadDesktopGrants("fixture-thread", [], { principal, reason: "fixture" });
  const readsBeforeDenied = reads;
  assert.notEqual((await request()).status, 200);
  assert.equal(reads, readsBeforeDenied, "denied grant cannot initiate target lookup");
});
