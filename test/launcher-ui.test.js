import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOidcSecuritySession } from "../packages/core/src/security.js";
import { startServer } from "../dist/server/apps/server/src/server.js";

function hostRequest(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: target, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("standalone launcher owns a small mobile shell outside the Orkestr WebUI bundle", async () => {
  const [index, script, styles, packageJson, fallback, boundaries] = await Promise.all([
    fs.readFile("apps/launcher/public/index.html", "utf8"),
    fs.readFile("apps/launcher/public/launcher.js", "utf8"),
    fs.readFile("apps/launcher/public/launcher.css", "utf8"),
    fs.readFile("package.json", "utf8"),
    fs.readFile("apps/server/src/static-fallback.ts", "utf8"),
    fs.readFile("apps/server/src/host-boundaries.ts", "utf8"),
  ]);

  assert.match(index, /viewport-fit=cover/);
  assert.match(index, /data-workspaces/);
  assert.match(index, /data-apps/);
  assert.doesNotMatch(index, /ork-root|main\.js|polyfills\.js/);
  assert.match(script, /json\("\/api\/me\/launcher"\)/);
  assert.match(script, /\/api\/instance\/accounts\/\$\{encodeURIComponent\(workspace\.publicRef\)\}\/session/);
  assert.doesNotMatch(script, /innerHTML|targetRef|tenantRef|threadId/);
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(styles, /grid-template-columns: 1fr/);
  assert.match(styles, /safe-area-inset-bottom/);
  assert.match(packageJson, /"launcher:build": "node scripts\/build-launcher\.mjs"/);
  assert.match(fallback, /dist\/launcher/);
  assert.match(fallback, /orkestrLauncherBoundary === true/);
  assert.match(boundaries, /request\.orkestrLauncherBoundary = true/);
});

test("launcher host serves the standalone bundle and refuses the Orkestr WebUI bundle", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-launcher-static-"));
  const keys = [
    "ORKESTR_HOME", "ORKESTR_PUBLIC_APPS", "ORKESTR_AUTH_PROVIDER", "ORKESTR_KEYCLOAK_OIDC_ENABLED",
    "ORKESTR_KEYCLOAK_ISSUER", "ORKESTR_KEYCLOAK_CLIENT_ID", "ORKESTR_PUBLIC_APP_URL",
    "ORKESTR_PUBLIC_LAUNCHER_URL", "ORKESTR_CONNECT_PUBLIC_URL", "ORKESTR_HOST_BOUNDARIES",
    "ORKESTR_OIDC_ALLOW_INSECURE_TESTS", "ORKESTR_AUTH_REQUIRED", "ORKESTR_RECOVER_RUNNING_ON_START",
    "ORKESTR_WHATSAPP_AUTOSTART", "WHATSAPP_LOCAL_AUTOSTART", "ORKESTR_CODEX_BIN",
  ];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_PUBLIC_APPS: "1",
    ORKESTR_AUTH_PROVIDER: "keycloak",
    ORKESTR_KEYCLOAK_OIDC_ENABLED: "1",
    ORKESTR_KEYCLOAK_ISSUER: "http://keycloak.example.test/realms/orkestr",
    ORKESTR_KEYCLOAK_CLIENT_ID: "orkestr-web",
    ORKESTR_PUBLIC_APP_URL: "http://app.example.test",
    ORKESTR_PUBLIC_LAUNCHER_URL: "http://launcher.example.test",
    ORKESTR_CONNECT_PUBLIC_URL: "http://connect.example.test",
    ORKESTR_HOST_BOUNDARIES: "1",
    ORKESTR_OIDC_ALLOW_INSECURE_TESTS: "1",
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_RECOVER_RUNNING_ON_START: "0",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    WHATSAPP_LOCAL_AUTOSTART: "0",
    ORKESTR_CODEX_BIN: "__orkestr_disabled_codex__",
  });
  const session = await createOidcSecuritySession({
    subject: "launcher-static-subject",
    issuedAt: new Date().toISOString(),
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  });
  const headers = { Host: "launcher.example.test", Cookie: `__Host-orkestr_app_session=${encodeURIComponent(session.token)}` };
  const page = await hostRequest(port, "/apps", headers);
  const html = page.body;
  assert.equal(page.status, 200, html);
  assert.match(html, /<title>Launcher · Orkestr<\/title>/);
  assert.match(html, /\/launcher\.js/);
  assert.doesNotMatch(html, /<ork-root|\/main\.js/);
  const script = await hostRequest(port, "/launcher.js", headers);
  assert.equal(script.status, 200);
  assert.match(script.body, /\/api\/me\/launcher/);
  const webUi = await hostRequest(port, "/main.js", headers);
  assert.equal(webUi.status, 404);
});
