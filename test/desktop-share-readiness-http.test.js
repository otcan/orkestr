import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { listDesktopShares } from "../packages/core/src/desktop-shares.js";
import { createThread } from "../packages/core/src/threads.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { advanceDesktopResourceGeneration, setThreadDesktopGrants } from "../packages/core/src/desktop-access.js";
import { acquireDesktopLease, releaseDesktopLease } from "../packages/browsers/src/desktop-leases.js";
import { listBrowserSessions } from "../packages/browsers/src/browsers.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-share-readiness-"));
  const before = { ...process.env };
  const state = path.join(home, "probe.json"), calls = path.join(home, "calls.jsonl");
  const command = path.join(home, "browserctl.cjs");
  await fs.writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const session = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
if (session.probeFailure) process.exit(1);
setTimeout(() => console.log(JSON.stringify({ok:true, sessions:[session], session})), session.delayMs || 0);
`);
  await fs.chmod(command, 0o755);
  Object.assign(process.env, {
    ORKESTR_HOME: home, ORKESTR_AUTH_REQUIRED: "0", ORKESTR_HOST_BOUNDARIES: "0",
    ORKESTR_BROWSER_DESKTOP_MODE: "browserctl", ORKESTR_BROWSERCTL_PATH: command,
    ORKESTR_BROWSER_SESSIONS_CACHE_MS: "60000", ORKESTR_DESKTOP_ACCESS_MODE: "shadow",
    ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
  });
  const set = async session => fs.writeFile(state, JSON.stringify({slug:"desktop", ...session}));
  await set({status:"degraded", visual_ok:false, readiness:{ok:false,status:"black_frame"}});
  const server = await startServer({port:0, host:"127.0.0.1"});
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    await fs.rm(home, {recursive:true, force:true, maxRetries:3, retryDelay:50});
  });
  return {
    set,
    async enforce() {
      process.env.ORKESTR_DESKTOP_ACCESS_MODE = "enforce";
      const principal = adminPrincipal("admin");
      await createThread({id:"share-thread", ownerUserId:"admin", name:"Share fixture", cwd:home});
      await advanceDesktopResourceGeneration("desktop", "admin", {reason:"fixture"});
      await setThreadDesktopGrants("share-thread", ["desktop"], {principal, reason:"fixture"});
      return principal;
    },
    async calls() { return (await fs.readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse); },
    async shares() { return (await listDesktopShares({env:process.env})).shares; },
    async post(body) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/desktops/desktop/share`, {
        method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body),
      });
      return {status:response.status, body:await response.json()};
    },
  };
}

test("share start:false rejects an unhealthy framebuffer without lifecycle commands or a share", async t => {
  const f = await fixture(t);
  const response = await f.post({start:false});
  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.match(JSON.stringify(response.body), /black_frame/);
  assert.equal((await f.shares()).length, 0);
  assert.deepEqual(await f.calls(), [["list", "--json"]]);
});

const ready = {status:"running", visual_ok:true, readiness:{ok:true,status:"ready",visualOk:true}};

test("start:false mints only from fresh positive visual evidence, never a cached success", async t => {
  const f = await fixture(t);
  await f.set(ready);
  await listBrowserSessions(process.env, {principal:adminPrincipal("admin")});
  const good = await f.post({start:false});
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body.desktopStart.requested, false);
  assert.equal((await f.shares()).length, 1);
  for (const session of [
    {status:"degraded", visual_ok:false, readiness:{ok:false,status:"white_frame"}},
    {status:"running"},
    {status:"stopped"},
    {status:"running", visual_ok:true, readiness:{ok:true,status:"ready"}, slug:"other-desktop"},
    {probeFailure:true},
  ]) {
    await f.set(session);
    assert.equal((await f.post({start:false})).status, 503);
    assert.equal((await f.shares()).length, 1);
  }
  assert.equal((await f.calls()).length, 7);
  assert.equal((await f.calls()).every(args => args.join(" ") === "list --json"), true);
});

test("unauthenticated share requests cannot probe or mint", async t => {
  const f = await fixture(t);
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  assert.equal((await f.post({start:false})).status, 401);
  assert.deepEqual(await f.calls(), []);
  assert.equal((await f.shares()).length, 0);
});

test("default share makes only one start/repair attempt and refuses its unhealthy result", async t => {
  const f = await fixture(t);
  assert.equal((await f.post({})).status, 503);
  assert.equal((await f.shares()).length, 0);
  assert.deepEqual(await f.calls(), [["start", "desktop"]]);
  await f.set(ready);
  assert.equal((await f.post({})).status, 201);
  assert.deepEqual(await f.calls(), [["start", "desktop"], ["start", "desktop"]]);
});

test("start:false preserves enforced grants, exclusive lease and fencing before probing", async t => {
  const f = await fixture(t);
  const principal = await f.enforce();
  await f.set(ready);
  assert.equal((await f.post({start:false})).status, 403);
  assert.equal((await f.post({start:false, threadId:"share-thread"})).status, 403);
  const acquired = await acquireDesktopLease("desktop", {threadId:"share-thread"}, process.env, {principal});
  assert.equal(acquired.ok, true);
  const payload = {start:false, threadId:"share-thread", fencingToken:acquired.lease.fencingToken};
  assert.equal((await f.post({...payload, fencingToken:"wrong"})).status, 409);
  assert.deepEqual(await f.calls(), []);
  const good = await f.post(payload);
  assert.equal(good.status, 201, JSON.stringify(good.body));
  await releaseDesktopLease("desktop", {threadId:"share-thread", fencingToken:payload.fencingToken}, process.env, {principal});
  assert.equal((await f.post(payload)).status, 403);
  await setThreadDesktopGrants("share-thread", [], {principal, reason:"fixture revoke"});
  assert.equal((await f.post(payload)).status, 403);
  assert.equal((await f.shares()).length, 1);
  assert.deepEqual(await f.calls(), [["list", "--json"]]);
});

test("lease or grant revoked while readiness is pending cannot mint a share", async t => {
  const f = await fixture(t);
  const principal = await f.enforce();
  await f.set({...ready, delayMs:400});
  for (const revoke of ["lease", "grant"]) {
    const acquired = await acquireDesktopLease("desktop", {threadId:"share-thread"}, process.env, {principal});
    assert.equal(acquired.ok, true);
    const before = (await f.calls()).length;
    const pending = f.post({start:false, threadId:"share-thread", fencingToken:acquired.lease.fencingToken});
    const deadline = Date.now() + 3000;
    while ((await f.calls()).length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await f.calls()).length, before + 1, "fixture probe has started");
    if (revoke === "lease") {
      await releaseDesktopLease("desktop", {threadId:"share-thread", fencingToken:acquired.lease.fencingToken}, process.env, {principal});
    } else {
      await setThreadDesktopGrants("share-thread", [], {principal, reason:"revoke during probe"});
    }
    assert.equal((await pending).status, 403);
    assert.equal((await f.shares()).length, 0);
  }
});
