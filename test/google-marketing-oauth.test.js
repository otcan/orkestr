import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { readGmailToken, startGmailOAuth } from "../packages/connectors/src/gmail.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function restoreEnvValue(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("Google Marketing OAuth opens in the configured virtual desktop", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-marketing-oauth-"));
  const overlayDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-marketing-overlay-"));
  const openedUrls = [];
  const cdpServer = http.createServer((request, response) => {
    const requestUrl = String(request.url || "");
    if (request.method === "PUT" && requestUrl.startsWith("/json/new?")) {
      const openedUrl = decodeURIComponent(requestUrl.slice("/json/new?".length));
      openedUrls.push(openedUrl);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "google-auth", type: "page", title: "Google Auth", url: openedUrl }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve) => cdpServer.listen(0, "127.0.0.1", resolve));
  const { port: cdpPort } = cdpServer.address();
  const authorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=desktop-test";
  const actionScript = path.join(overlayDir, "google-marketing-action.js");
  await fs.writeFile(
    actionScript,
    `#!/usr/bin/env node
console.log(JSON.stringify({ ok: true, authorizeUrl: ${JSON.stringify(authorizeUrl)} }));
`,
  );
  await fs.chmod(actionScript, 0o755);
  await fs.writeFile(
    path.join(overlayDir, "overlay.json"),
    JSON.stringify(
      {
        connectors: {
          "google-marketing": {
            label: "Google Marketing",
            actions: {
              "start-oauth": {
                type: "command-json",
                command: [process.execPath, actionScript],
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  const browserctl = path.join(home, "browserctl.js");
  await fs.writeFile(browserctl, `#!/usr/bin/env node
const [command, slug] = process.argv.slice(2);
const session = {
  slug: slug || "pa",
  label: "PA Browser Desk",
  type: "desktop",
  status: "active",
  desk_url: "https://pa.example.invalid/",
  cdp_url: "http://127.0.0.1:${cdpPort}",
  owner_service: "pa-browser",
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
  const priorEnv = {
    ORKESTR_HOME: process.env.ORKESTR_HOME,
    ORKESTR_OVERLAY_DIR: process.env.ORKESTR_OVERLAY_DIR,
    ORKESTR_BROWSERCTL_PATH: process.env.ORKESTR_BROWSERCTL_PATH,
    ORKESTR_BROWSER_DESKTOP_MODE: process.env.ORKESTR_BROWSER_DESKTOP_MODE,
    ORKESTR_GOOGLE_MARKETING_AUTH_DESKTOP_SLUG: process.env.ORKESTR_GOOGLE_MARKETING_AUTH_DESKTOP_SLUG,
    ORKESTR_RECOVER_RUNNING_ON_START: process.env.ORKESTR_RECOVER_RUNNING_ON_START,
  };
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_OVERLAY_DIR = overlayDir;
  process.env.ORKESTR_BROWSERCTL_PATH = browserctl;
  process.env.ORKESTR_BROWSER_DESKTOP_MODE = "browserctl";
  process.env.ORKESTR_GOOGLE_MARKETING_AUTH_DESKTOP_SLUG = "pa";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/google-marketing/oauth/start`, { redirect: "manual" });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.ok(html.includes("Google Marketing authorization opened in PA Browser Desk"));
    assert.ok(html.includes("Open Virtual Browser"));
    assert.deepEqual(openedUrls, [authorizeUrl]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => cdpServer.close(resolve));
    for (const [name, value] of Object.entries(priorEnv)) restoreEnvValue(name, value);
  }
});

test("Gmail OAuth opens in the configured Google auth virtual desktop", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-oauth-desktop-"));
  const openedUrls = [];
  const cdpServer = http.createServer((request, response) => {
    const requestUrl = String(request.url || "");
    if (request.method === "PUT" && requestUrl.startsWith("/json/new?")) {
      const openedUrl = decodeURIComponent(requestUrl.slice("/json/new?".length));
      openedUrls.push(openedUrl);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "gmail-auth", type: "page", title: "Google Auth", url: openedUrl }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve) => cdpServer.listen(0, "127.0.0.1", resolve));
  const { port: cdpPort } = cdpServer.address();
  const browserctl = path.join(home, "browserctl.js");
  await fs.writeFile(browserctl, `#!/usr/bin/env node
const [command, slug] = process.argv.slice(2);
const session = {
  slug: slug || "pa",
  label: "PA Browser Desk",
  type: "desktop",
  status: "active",
  desk_url: "https://pa.example.invalid/",
  cdp_url: "http://127.0.0.1:${cdpPort}",
  owner_service: "pa-browser",
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
  const priorEnv = {
    ORKESTR_HOME: process.env.ORKESTR_HOME,
    ORKESTR_OVERLAY_DIR: process.env.ORKESTR_OVERLAY_DIR,
    ORKESTR_BROWSERCTL_PATH: process.env.ORKESTR_BROWSERCTL_PATH,
    ORKESTR_BROWSER_DESKTOP_MODE: process.env.ORKESTR_BROWSER_DESKTOP_MODE,
    ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG: process.env.ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG,
    ORKESTR_RECOVER_RUNNING_ON_START: process.env.ORKESTR_RECOVER_RUNNING_ON_START,
  };
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_OVERLAY_DIR;
  process.env.ORKESTR_BROWSERCTL_PATH = browserctl;
  process.env.ORKESTR_BROWSER_DESKTOP_MODE = "browserctl";
  process.env.ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG = "pa";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    redirectUri: "http://127.0.0.1/oauth/gmail/callback",
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/oauth/gmail/start?account=person@example.com`, { redirect: "manual" });
    const html = await response.text();
    const openedUrl = new URL(openedUrls[0]);

    assert.equal(response.status, 200);
    assert.ok(html.includes("Gmail authorization opened in PA Browser Desk"));
    assert.ok(html.includes("Open Virtual Browser"));
    assert.equal(openedUrl.hostname, "accounts.google.com");
    assert.equal(openedUrl.searchParams.get("client_id"), "client-id");
    assert.equal(openedUrl.searchParams.get("login_hint"), "person@example.com");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => cdpServer.close(resolve));
    for (const [name, value] of Object.entries(priorEnv)) restoreEnvValue(name, value);
  }
});

test("shared Google callback completes Gmail OAuth when the state belongs to Gmail", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-shared-callback-"));
  const priorEnv = {
    ORKESTR_HOME: process.env.ORKESTR_HOME,
    ORKESTR_OVERLAY_DIR: process.env.ORKESTR_OVERLAY_DIR,
    ORKESTR_RECOVER_RUNNING_ON_START: process.env.ORKESTR_RECOVER_RUNNING_ON_START,
  };
  const originalFetch = globalThis.fetch;
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_OVERLAY_DIR;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://ops-health.example.test/google-marketing/oauth/callback",
  });
  const started = await startGmailOAuth(process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();

  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("code"), "gmail-code");
      assert.equal(body.get("redirect_uri"), "https://ops-health.example.test/google-marketing/oauth/callback");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "shared-callback-access",
            refresh_token: "shared-callback-refresh",
            expires_in: 3600,
          };
        },
      };
    }
    return originalFetch(url, options);
  };

  try {
    const response = await originalFetch(
      `http://127.0.0.1:${port}/google-marketing/oauth/callback?code=gmail-code&state=${encodeURIComponent(started.state)}`,
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.ok(html.includes("Gmail authorization is complete"));
    assert.equal((await readGmailToken(process.env)).accessToken, "shared-callback-access");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries(priorEnv)) restoreEnvValue(name, value);
  }
});
