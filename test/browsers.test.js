import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupVirtualBrowser,
  listBrowserSessions,
  listVirtualBrowsers,
  openVirtualBrowser,
  prepareVirtualBrowser,
  stopVirtualBrowser,
} from "../packages/browsers/src/browsers.js";
import { acquireDesktopLease } from "../packages/browsers/src/desktop-leases.js";
import { listEvents } from "../packages/storage/src/store.js";

test("virtual browsers can be prepared without launching Chrome", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-browsers-"));
  const env = { ORKESTR_HOME: home, ORKESTR_BROWSER_LAUNCH_DISABLED: "1", ORKESTR_BROWSER_DESKTOP_MODE: "profiles" };

  const prepared = await prepareVirtualBrowser("linkedin", env);
  const opened = await openVirtualBrowser("linkedin", env);
  const browsers = await listVirtualBrowsers(env);
  const events = await listEvents(env);

  assert.equal(prepared.slug, "linkedin");
  assert.equal(opened.launched, false);
  assert.equal(opened.debugPort, 9223);
  assert.equal(browsers.find((browser) => browser.slug === "linkedin").configured, true);
  assert.equal(browsers.find((browser) => browser.slug === "linkedin").type, "desktop");
  assert.equal(events.at(-1).type, "browser_open_requested");
});

test("virtual browser management exposes stop and cleanup actions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-browsers-"));
  const env = { ORKESTR_HOME: home, ORKESTR_BROWSER_LAUNCH_DISABLED: "1", ORKESTR_BROWSER_DESKTOP_MODE: "profiles" };

  await prepareVirtualBrowser("desktop", env);
  const stopped = await stopVirtualBrowser("desktop", env);
  const cleaned = await cleanupVirtualBrowser("desktop", env);
  const browsers = await listVirtualBrowsers(env);
  const desktop = browsers.find((browser) => browser.slug === "desktop");

  assert.equal(stopped.slug, "desktop");
  assert.equal(cleaned.cleaned, true);
  assert.equal(desktop.configured, false);
  assert.equal(desktop.status, "not_prepared");
});

test("managed desktop sessions come from browserctl and include leases", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-browserctl-"));
  const browserctl = path.join(home, "browserctl.js");
  await fs.writeFile(browserctl, `#!/usr/bin/env node
const [command, slug] = process.argv.slice(2);
const target = slug && !slug.startsWith("--") ? slug : "pa";
const session = {
  slug: target,
  label: "PA Browser Desk",
  type: "desktop",
  status: "active",
  desk_url: "https://pa.example.invalid/",
  cdp_url: "http://127.0.0.1:19323",
  owner_service: "pa-browser",
  control: { start: true, stop: true, restart: true, health: true },
  profile_path: "/tmp/pa-profile"
};
if (command === "list") {
  console.log(JSON.stringify({ ok: true, sessions: [session] }));
} else if (["health", "start", "stop", "restart"].includes(command)) {
  console.log(JSON.stringify({ ok: true, session: { ...session, slug } }));
} else {
  process.stderr.write("unsupported");
  process.exit(2);
}
`);
  await fs.chmod(browserctl, 0o755);
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSERCTL_PATH: browserctl,
    ORKESTR_DESKTOP_LEASE_FILE: path.join(home, "desktop-leases.json"),
  };

  await acquireDesktopLease("pa", { threadId: "thread-a", threadName: "Thread A", purpose: "test" }, env);
  const payload = await listBrowserSessions(env);
  const started = await openVirtualBrowser("pa", env);
  const pa = payload.sessions.find((session) => session.slug === "pa");

  assert.equal(payload.source, "browserctl");
  assert.equal(payload.sessions.length, 1);
  assert.equal(pa.cdp_url, "http://127.0.0.1:19323");
  assert.equal(pa.lease.threadId, "thread-a");
  assert.equal(pa.leaseOwnerLabel, "Thread A");
  assert.equal(started.action, "start");
  assert.equal(started.source, "browserctl");
});
