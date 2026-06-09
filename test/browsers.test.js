import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import {
  cleanupVirtualBrowser,
  listBrowserSessions,
  listVirtualBrowsers,
  openUrlInVirtualBrowser,
  openVirtualBrowser,
  prepareVirtualBrowser,
  stopVirtualBrowser,
} from "../packages/browsers/src/browsers.js";
import { operateManagedDesktop } from "../packages/browsers/src/desktop-operator.js";
import { acquireDesktopLease, activeDesktopLeaseStatus, publicDesktopLeases } from "../packages/browsers/src/desktop-leases.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
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

test("unconfigured browser mode uses isolated profile desktops, not ambient browserctl", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-browser-default-mode-"));
  const env = { ORKESTR_HOME: home, ORKESTR_BROWSER_LAUNCH_DISABLED: "1" };

  const payload = await listBrowserSessions(env);

  assert.equal(payload.source, "profiles");
  assert.deepEqual(payload.sessions.map((browser) => browser.slug), ["desktop", "linkedin", "gmail"]);
  assert.equal(payload.sessions.some((browser) => String(browser.url || "").includes("desk.ops")), false);
});

test("visible browser slugs can limit the ops desktop list", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-visible-browsers-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_OPS_DESKTOP_SLUGS: "linkedin",
  };

  await prepareVirtualBrowser("desktop", env);
  await prepareVirtualBrowser("linkedin", env);
  const payload = await listBrowserSessions(env);

  assert.deepEqual(payload.sessions.map((browser) => browser.slug), ["linkedin"]);
  assert.equal(payload.sessions[0].configured, true);
});

test("profile desktops are isolated per non-admin user", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-user-browsers-"));
  const env = { ORKESTR_HOME: home, ORKESTR_BROWSER_LAUNCH_DISABLED: "1", ORKESTR_BROWSER_DESKTOP_MODE: "profiles" };
  const alice = userPrincipal({ id: "alice", role: "user" });
  const bob = userPrincipal({ id: "bob", role: "user" });

  const alicePrepared = await prepareVirtualBrowser("linkedin", env, { principal: alice });
  const bobInitial = await listBrowserSessions(env, { principal: bob });
  const bobPrepared = await prepareVirtualBrowser("linkedin", env, { principal: bob });
  const aliceListed = await listBrowserSessions(env, { principal: alice });

  assert.equal(alicePrepared.ownerUserId, "alice");
  assert.equal(alicePrepared.scope, "user");
  assert.equal(alicePrepared.profileDir, path.join(home, "users", "alice", "browsers", "linkedin"));
  assert.equal(bobInitial.sessions.find((browser) => browser.slug === "linkedin").configured, false);
  assert.equal(bobPrepared.ownerUserId, "bob");
  assert.equal(bobPrepared.profileDir, path.join(home, "users", "bob", "browsers", "linkedin"));
  assert.notEqual(alicePrepared.profileDir, bobPrepared.profileDir);
  assert.notEqual(alicePrepared.debugPort, bobPrepared.debugPort);
  assert.equal(aliceListed.sessions.find((browser) => browser.slug === "linkedin").configured, true);
});

test("desktop leases conflict only inside the same user scope", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-user-leases-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DESKTOP_LEASE_FILE: path.join(home, "desktop-leases.json"),
  };
  const alice = userPrincipal({ id: "alice", role: "user" });
  const bob = userPrincipal({ id: "bob", role: "user" });

  const aliceLease = await acquireDesktopLease("linkedin", { threadId: "alice-thread", threadName: "Alice" }, env, { principal: alice });
  const bobLease = await acquireDesktopLease("linkedin", { threadId: "bob-thread", threadName: "Bob" }, env, { principal: bob });
  const conflict = await acquireDesktopLease("linkedin", { threadId: "alice-other" }, env, { principal: alice });
  const aliceStatus = await activeDesktopLeaseStatus("linkedin", env, { principal: alice });
  const bobStatus = await activeDesktopLeaseStatus("linkedin", env, { principal: bob });
  const aliceLeases = await publicDesktopLeases({ principal: alice }, env);

  assert.equal(aliceLease.ok, true);
  assert.equal(aliceLease.lease.ownerUserId, "alice");
  assert.equal(bobLease.ok, true);
  assert.equal(bobLease.lease.ownerUserId, "bob");
  assert.equal(conflict.ok, false);
  assert.equal(conflict.lease.threadId, "alice-thread");
  assert.equal(aliceStatus.threadId, "alice-thread");
  assert.equal(bobStatus.threadId, "bob-thread");
  assert.deepEqual(aliceLeases.map((lease) => lease.ownerUserId), ["alice"]);
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

test("managed desktop sessions include related threads without an active lease", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-browserctl-threads-"));
  const browserctl = path.join(home, "browserctl.js");
  await fs.writeFile(browserctl, `#!/usr/bin/env node
const session = {
  slug: "linkedin",
  label: "LinkedIn",
  type: "desktop",
  status: "active",
  desk_url: "https://linkedin.example.invalid/",
  control: { start: true, stop: true, restart: true, health: true }
};
console.log(JSON.stringify({ ok: true, sessions: [session] }));
`);
  await fs.chmod(browserctl, 0o755);
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSERCTL_PATH: browserctl,
    ORKESTR_DESKTOP_LEASE_FILE: path.join(home, "desktop-leases.json"),
  };

  await createThread({ id: "sample-linkedin", name: "Sample LinkedIn", title: "Sample-Linkedin", state: "ready" }, env);
  const payload = await listBrowserSessions(env);
  const linkedin = payload.sessions.find((session) => session.slug === "linkedin");

  assert.equal(linkedin.lease, null);
  assert.deepEqual(linkedin.relatedThreads.map((thread) => thread.id), ["sample-linkedin"]);
  assert.equal(linkedin.relatedThreads[0].title, "Sample-Linkedin");
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

test("managed desktop operator observes and controls a CDP page", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-operator-"));
  let pageUrl = "https://www.linkedin.com/feed/";
  let searchValue = "";
  const server = http.createServer((request, response) => {
    const requestUrl = String(request.url || "");
    if (requestUrl === "/json/list") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{
        id: "page-1",
        type: "page",
        title: "LinkedIn Feed",
        url: pageUrl,
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/page-1`,
      }]));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw || "{}"));
      if (message.method === "Runtime.evaluate") {
        const expression = String(message.params?.expression || "");
        if (expression.includes("desktop_click_target_not_found")) {
          ws.send(JSON.stringify({ id: message.id, result: { result: { type: "object", value: { ok: true, clicked: "People", url: pageUrl } } } }));
          return;
        }
        if (expression.includes("desktop_type_target_not_found")) {
          const match = expression.match(/const nextValue = \"([^\"]*)\"/);
          searchValue = match ? JSON.parse(`"${match[1]}"`) : "";
          ws.send(JSON.stringify({ id: message.id, result: { result: { type: "object", value: { ok: true, field: "Search", url: pageUrl } } } }));
          return;
        }
        ws.send(JSON.stringify({
          id: message.id,
          result: {
            result: {
              type: "object",
              value: {
                title: "LinkedIn Feed",
                url: pageUrl,
                bodyText: `Signed in as Test User. Search value: ${searchValue}. Recent update from Example GmbH.`,
                textLength: 86,
                links: [{ text: "Example GmbH", href: "https://www.linkedin.com/company/example", selector: "a:nth-of-type(1)" }],
                fields: [{ label: "Search", selector: "input:nth-of-type(1)", value: searchValue }],
                buttons: [{ text: "People", selector: "button:nth-of-type(1)" }],
              },
            },
          },
        }));
        return;
      }
      ws.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cdpUrl = `http://127.0.0.1:${server.address().port}`;
  const browserctl = path.join(home, "browserctl.js");
  await fs.writeFile(browserctl, `#!/usr/bin/env node
const [command, slug] = process.argv.slice(2);
const session = {
  slug: slug || "linkedin",
  label: "LinkedIn",
  type: "desktop",
  status: "running",
  cdp_url: ${JSON.stringify(cdpUrl)},
  control: { start: true, stop: true, restart: true, health: true }
};
if (["list", "health", "start", "stop", "restart"].includes(command)) {
  console.log(JSON.stringify(command === "list" ? { ok: true, sessions: [session] } : { ok: true, session }));
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
    const observed = await operateManagedDesktop("linkedin", { operation: "observe" }, env);
    const typed = await operateManagedDesktop("linkedin", { operation: "type", field: "Search", value: "founder" }, env);
    const clicked = await operateManagedDesktop("linkedin", { operation: "click", text: "People" }, env);

    assert.equal(observed.ok, true);
    assert.match(observed.page.bodyText, /Signed in as Test User/);
    assert.equal(typed.actionResult.field, "Search");
    assert.equal(typed.page.fields[0].value, "founder");
    assert.equal(clicked.actionResult.clicked, "People");
    assert.equal(clicked.page.links[0].text, "Example GmbH");
  } finally {
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
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

test("oss browserctl refreshes stale prepared ports for the current scope", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-browserctl-ports-"));
  const script = path.resolve("scripts/browserctl.mjs");
  const env = (debugBase, webBase, vncBase, displayBase) => ({
    ...process.env,
    ORKESTR_HOME: home,
    ORKESTR_BROWSERCTL_DRY_RUN: "1",
    ORKESTR_BROWSER_DEBUG_PORT_BASE: String(debugBase),
    ORKESTR_DESKTOP_WEB_PORT_BASE: String(webBase),
    ORKESTR_DESKTOP_VNC_PORT_BASE: String(vncBase),
    ORKESTR_DESKTOP_DISPLAY_BASE: String(displayBase),
  });
  const run = async (runtimeEnv, ...args) => {
    const { stdout } = await execFileAsync(process.execPath, [script, ...args], { env: runtimeEnv });
    return JSON.parse(stdout);
  };

  const first = await run(env(19322, 16080, 15901, 190), "health", "desktop");
  assert.equal(first.session.debugPort, 19322);
  assert.equal(first.session.web_port, 16080);
  assert.equal(first.session.vnc_port, 15901);

  const currentScope = env(21322, 18080, 17901, 210);
  const prepared = await run(currentScope, "health", "desktop");
  const started = await run(currentScope, "start", "desktop");

  assert.equal(prepared.session.debugPort, 21322);
  assert.equal(prepared.session.web_port, 18080);
  assert.equal(prepared.session.vnc_port, 17901);
  assert.equal(started.session.debugPort, 21322);
  assert.equal(started.session.web_port, 18080);
  assert.equal(started.session.vnc_port, 17901);
  assert.equal(started.session.cdp_url, "http://127.0.0.1:21322");
});

test("managed desktop mode can use the bundled oss browserctl script", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-bundled-browserctl-"));
  const script = await fs.readFile("scripts/browserctl.mjs", "utf8");
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
  assert.match(script, /ORKESTR_BROWSER_RUN_USER/);
  assert.match(script, /ORKESTR_RUN_USER/);
  assert.match(script, /browserctl_root_requires_run_user_or_explicit_no_sandbox/);
  assert.doesNotMatch(script, /process\.getuid\?\.\(\) === 0 \|\| String\(process\.env\.ORKESTR_CHROME_NO_SANDBOX/);
  assert.equal(prepared.status, "prepared");
  assert.equal(started.status, "running");
  assert.equal(gmail.status, "running");
  assert.match(gmail.desk_url, /^\/desktop\/gmail\/vnc\.html\?/);
  assert.equal(gmail.web_port, 17082);
  assert.equal(gmail.cdp_url, "http://127.0.0.1:20324");
});

test("managed browserctl desktops use separate homes and ports per user", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-browserctl-users-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "browserctl",
    ORKESTR_BROWSERCTL_PATH: path.resolve("scripts/browserctl.mjs"),
    ORKESTR_BROWSERCTL_DRY_RUN: "1",
    ORKESTR_BROWSER_DEBUG_PORT_BASE: "22322",
    ORKESTR_DESKTOP_WEB_PORT_BASE: "19080",
    ORKESTR_DESKTOP_VNC_PORT_BASE: "18901",
    ORKESTR_DESKTOP_DISPLAY_BASE: "220",
  };
  const alice = userPrincipal({ id: "alice", role: "user" });
  const bob = userPrincipal({ id: "bob", role: "user" });

  const aliceStarted = await openVirtualBrowser("linkedin", env, "", { principal: alice });
  const bobStarted = await openVirtualBrowser("linkedin", env, "", { principal: bob });
  const alicePayload = await listBrowserSessions(env, { principal: alice });
  const bobPayload = await listBrowserSessions(env, { principal: bob });

  assert.equal(aliceStarted.ownerUserId, "alice");
  assert.equal(bobStarted.ownerUserId, "bob");
  assert.equal(aliceStarted.profile_path, path.join(home, "users", "alice", "browsers", "linkedin"));
  assert.equal(bobStarted.profile_path, path.join(home, "users", "bob", "browsers", "linkedin"));
  assert.notEqual(aliceStarted.debugPort, bobStarted.debugPort);
  assert.notEqual(aliceStarted.web_port, bobStarted.web_port);
  assert.equal(alicePayload.sessions.find((session) => session.slug === "linkedin").ownerUserId, "alice");
  assert.equal(bobPayload.sessions.find((session) => session.slug === "linkedin").ownerUserId, "bob");
});
