import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  cleanupVirtualBrowser,
  listBrowserSessions,
  listVirtualBrowsers,
  openUrlInVirtualBrowser,
  openVirtualBrowser,
  prepareVirtualBrowser,
  stopVirtualBrowser,
} from "../packages/browsers/src/browsers.js";
import { acquireDesktopLease } from "../packages/browsers/src/desktop-leases.js";
import { listEvents } from "../packages/storage/src/store.js";

const execFileAsync = promisify(execFile);

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

test("managed desktop sessions can open a requested URL through CDP", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-browser-open-url-"));
  const openedUrls = [];
  const cdpServer = http.createServer((request, response) => {
    const requestUrl = String(request.url || "");
    if (request.method === "PUT" && requestUrl.startsWith("/json/new?")) {
      const openedUrl = decodeURIComponent(requestUrl.slice("/json/new?".length));
      openedUrls.push(openedUrl);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "page-1", type: "page", title: "Google Auth", url: openedUrl }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve) => cdpServer.listen(0, "127.0.0.1", resolve));
  const { port } = cdpServer.address();
  const cdpUrl = `http://127.0.0.1:${port}`;
  const browserctl = path.join(home, "browserctl.js");
  await fs.writeFile(browserctl, `#!/usr/bin/env node
const [command, slug] = process.argv.slice(2);
const session = {
  slug: slug || "pa",
  label: "PA Browser Desk",
  type: "desktop",
  status: "active",
  desk_url: "https://pa.example.invalid/",
  cdp_url: ${JSON.stringify(cdpUrl)},
  owner_service: "pa-browser",
  control: { start: true, stop: true, restart: true, health: true }
};
if (command === "list") {
  console.log(JSON.stringify({ ok: true, sessions: [session] }));
} else if (["health", "start", "stop", "restart"].includes(command)) {
  console.log(JSON.stringify({ ok: true, session }));
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

  try {
    const targetUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=test";
    const opened = await openUrlInVirtualBrowser("pa", targetUrl, env);

    assert.equal(opened.action, "open-url");
    assert.equal(opened.slug, "pa");
    assert.equal(opened.openedUrl, targetUrl);
    assert.equal(opened.cdpPage.url, targetUrl);
    assert.deepEqual(openedUrls, [targetUrl]);
  } finally {
    await new Promise((resolve) => cdpServer.close(resolve));
  }
});

test("oss browserctl exposes real noVNC desktop sessions in dry run", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-real-desktop-"));
  const script = path.resolve("scripts/browserctl.mjs");
  const env = {
    ...process.env,
    ORKESTR_HOME: home,
    ORKESTR_BROWSERCTL_DRY_RUN: "1",
    ORKESTR_BROWSER_DEBUG_PORT_BASE: "19322",
    ORKESTR_DESKTOP_WEB_PORT_BASE: "16080",
    ORKESTR_DESKTOP_VNC_PORT_BASE: "15901",
    ORKESTR_DESKTOP_DISPLAY_BASE: "190",
  };
  const run = async (...args) => {
    const { stdout } = await execFileAsync(process.execPath, [script, ...args], { env });
    return JSON.parse(stdout);
  };

  const initial = await run("list", "--json");
  assert.equal(initial.source, "orkestr-browserctl");
  assert.equal(initial.sessions.find((session) => session.slug === "linkedin").status, "not_prepared");

  const prepared = await run("health", "linkedin");
  assert.equal(prepared.session.status, "prepared");
  assert.match(prepared.session.desk_url, /^\/desktop\/linkedin\/vnc\.html\?/);
  assert.match(prepared.session.desk_url, /path=desktop\/linkedin\/websockify/);

  const started = await run("start", "linkedin");
  assert.equal(started.session.status, "running");
  assert.equal(started.session.access, "desk");
  assert.equal(started.session.debugPort, 19323);
  assert.equal(started.session.web_port, 16081);
  assert.equal(started.session.cdp_url, "http://127.0.0.1:19323");

  const stopped = await run("stop", "linkedin");
  assert.equal(stopped.session.status, "prepared");
  const cleaned = await run("cleanup", "linkedin", "--safe");
  assert.equal(cleaned.session.cleaned, true);
  assert.equal(cleaned.session.status, "not_prepared");
});

test("managed desktop mode can use the bundled oss browserctl script", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-bundled-browserctl-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "browserctl",
    ORKESTR_BROWSERCTL_PATH: path.resolve("scripts/browserctl.mjs"),
    ORKESTR_BROWSERCTL_DRY_RUN: "1",
    ORKESTR_BROWSER_DEBUG_PORT_BASE: "20322",
    ORKESTR_DESKTOP_WEB_PORT_BASE: "17080",
    ORKESTR_DESKTOP_VNC_PORT_BASE: "16901",
    ORKESTR_DESKTOP_DISPLAY_BASE: "200",
  };

  const prepared = await prepareVirtualBrowser("gmail", env);
  const started = await openVirtualBrowser("gmail", env);
  const payload = await listBrowserSessions(env);
  const gmail = payload.sessions.find((session) => session.slug === "gmail");

  assert.equal(payload.source, "browserctl");
  assert.equal(prepared.status, "prepared");
  assert.equal(started.status, "running");
  assert.equal(gmail.status, "running");
  assert.match(gmail.desk_url, /^\/desktop\/gmail\/vnc\.html\?/);
  assert.equal(gmail.web_port, 17082);
  assert.equal(gmail.cdp_url, "http://127.0.0.1:20324");
});
