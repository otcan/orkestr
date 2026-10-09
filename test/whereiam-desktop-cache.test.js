import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { whereAmI } from "../packages/core/src/whereiam.js";
import { createThread } from "../packages/core/src/threads.js";
import { cachedWhereamiDesktopInventory, resetWhereamiDesktopInventoryCache } from "../packages/core/src/whereiam-desktop-cache.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeLoader(delayMs = 0) {
  const loader = async () => {
    loader.calls += 1;
    const call = loader.calls;
    if (delayMs) await sleep(delayMs);
    if (loader.fail) throw new Error("browserctl_down");
    return { ok: true, source: "browserctl", sessions: [{ slug: `desk-${call}` }] };
  };
  loader.calls = 0;
  loader.fail = false;
  return loader;
}

test("whereiam desktop cache reuses fresh inventory without reloading", async () => {
  resetWhereamiDesktopInventoryCache();
  const env = { ORKESTR_HOME: "/tmp/fake-whereiam-fresh", ORKESTR_DESKTOP_INVENTORY_CACHE_MS: "60000" };
  const load = fakeLoader();
  const first = await cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load);
  const second = await cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load);
  assert.equal(load.calls, 1);
  assert.equal(second, first);
  await cachedWhereamiDesktopInventory(env, { threadId: "thread-b" }, load);
  assert.equal(load.calls, 2, "cache is scoped per thread");
});

test("whereiam desktop cache serves expired inventory immediately and refreshes in background", async () => {
  resetWhereamiDesktopInventoryCache();
  const env = { ORKESTR_HOME: "/tmp/fake-whereiam-stale", ORKESTR_DESKTOP_INVENTORY_CACHE_MS: "20", ORKESTR_WHEREIAM_DESKTOP_STALE_MS: "60000" };
  const load = fakeLoader(150);
  await cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load);
  await sleep(30);
  const startedAt = Date.now();
  const stale = await cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load);
  assert.ok(Date.now() - startedAt < 100);
  assert.equal(stale.stale, true);
  assert.equal(stale.sessions[0].slug, "desk-1");
  await sleep(200);
  const refreshed = await cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load);
  assert.equal(refreshed.sessions[0].slug, "desk-2");
});

test("whereiam desktop cache bounds a cold inventory read by the budget", async () => {
  resetWhereamiDesktopInventoryCache();
  const env = { ORKESTR_HOME: "/tmp/fake-whereiam-cold", ORKESTR_WHEREIAM_DESKTOP_BUDGET_MS: "50" };
  const load = fakeLoader(300);
  const startedAt = Date.now();
  const pending = await cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load);
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(pending.pending, true);
  assert.equal(pending.error, "desktop_inventory_pending");
  assert.deepEqual(pending.sessions, []);
  await sleep(350);
  const loaded = await cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load);
  assert.equal(load.calls, 1, "the pending read finished in the background and filled the cache");
  assert.equal(loaded.sessions[0].slug, "desk-1");
});

test("whereiam desktop cache surfaces cold failures and keeps stale data on refresh failure", async () => {
  resetWhereamiDesktopInventoryCache();
  const env = { ORKESTR_HOME: "/tmp/fake-whereiam-fail", ORKESTR_DESKTOP_INVENTORY_CACHE_MS: "20" };
  const load = fakeLoader();
  load.fail = true;
  await assert.rejects(cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load), /browserctl_down/);
  load.fail = false;
  await cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load);
  load.fail = true;
  await sleep(30);
  const stale = await cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load);
  await sleep(10);
  assert.equal(stale.stale, true);
  const again = await cachedWhereamiDesktopInventory(env, { threadId: "thread-a" }, load);
  assert.equal(again.sessions[0].slug, "desk-2");
});

test("whereAmI answers within the desktop budget when browserctl list is slow", async () => {
  resetWhereamiDesktopInventoryCache();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-whereiam-slow-desktops-"));
  const workspace = path.join(home, "workspaces", "demo");
  await fs.mkdir(workspace, { recursive: true });
  const browserctl = path.join(home, "browserctl.js");
  await fs.writeFile(browserctl, "#!/usr/bin/env node\nsetTimeout(() => process.stdout.write(JSON.stringify({ ok: true, sessions: [] })), 3_000);\n", "utf8");
  await fs.chmod(browserctl, 0o755);
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "browserctl",
    ORKESTR_BROWSERCTL_PATH: browserctl,
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
    ORKESTR_WHEREIAM_DESKTOP_BUDGET_MS: "200",
  };
  await createThread({ id: "demo-thread", name: "Demo", cwd: workspace, workspace }, env);

  const startedAt = Date.now();
  const payload = await whereAmI({ cwd: workspace }, env);

  assert.ok(Date.now() - startedAt < 2_000, `whereAmI took ${Date.now() - startedAt} ms`);
  assert.equal(payload.thread.id, "demo-thread");
  assert.equal(payload.desktops.livePending, true);
  assert.equal(payload.desktops.error, "desktop_inventory_pending");
});
