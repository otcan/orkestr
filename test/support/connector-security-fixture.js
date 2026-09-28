import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../apps/server/src/server.js";
import { approvePairingChallenge, createPairingChallenge, pairBrowser, sessionCookieHeader } from "../../packages/core/src/security.js";
import { listEvents } from "../../packages/storage/src/store.js";

// Isolated server fixture for ORK-512/ORK-513 behavioral tests. Uses fake
// OAuth client configuration and fake hosts only; nothing leaves loopback.

export const fakeOAuthEnv = {
  GMAIL_OAUTH_CLIENT_ID: "fake-client-id",
  GMAIL_OAUTH_CLIENT_SECRET: "fake-client-secret",
  GMAIL_OAUTH_REDIRECT_URI: "https://connect.example.test/oauth/gmail/callback",
};

const managedKeys = [
  "ORKESTR_HOME",
  "ORKESTR_AUTH_REQUIRED",
  "ORKESTR_WHATSAPP_AUTOSTART",
  "WHATSAPP_LOCAL_AUTOSTART",
  "ORKESTR_WHATSAPP_ACCOUNT_IDS",
  "ORKESTR_GMAIL_AUTH_DESKTOP_SLUG",
  "ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG",
  "ORKESTR_CONNECTOR_INTENT_TTL_MS",
  "ORKESTR_GMAIL_OAUTH_START_RATE_LIMIT",
  "ORKESTR_GMAIL_OAUTH_STATE_TTL_MS",
  "ORKESTR_WHATSAPP_REPAIR_SOURCE_LIMIT",
  "ORKESTR_WHATSAPP_REPAIR_ACCOUNT_LIMIT",
  "ORKESTR_WHATSAPP_REPAIR_ALERT_THRESHOLD",
  "ORKESTR_WHATSAPP_REPAIR_QR_CONCURRENCY",
  "ORKESTR_CONNECT_PUBLIC_SETUP_URL",
  "ORKESTR_CONNECT_PUBLIC_URL",
  "ORKESTR_PUBLIC_AUTH_URL",
  "ORKESTR_WHATSAPP_REPAIR_NOTIFY_EMAIL",
  "ORKESTR_WHATSAPP_REPAIR_INTENT_TTL_MS",
  "ORKESTR_WHATSAPP_REPAIR_QR_EMAIL_COOLDOWN_MS",
  ...Object.keys(fakeOAuthEnv),
];

export async function startFixtureServer(extraEnv = {}, options = {}) {
  const prior = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]));
  for (const key of managedKeys) delete process.env[key];
  const home = options.home || await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-security-"));
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    WHATSAPP_LOCAL_AUTOSTART: "0",
    ...fakeOAuthEnv,
    ...extraEnv,
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  return {
    home,
    port,
    origin,
    async close({ keepHome = false } = {}) {
      await new Promise((resolve) => server.close(resolve));
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (!keepHome) await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Cookie header for a real paired browser session. */
export async function pairedCookie({ userId = "", role = "", instanceId = "", allowedActions, authIntent, requestedPath } = {}) {
  const challenge = await createPairingChallenge({
    env: process.env,
    ...(userId ? { userId } : {}),
    ...(role ? { role } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(allowedActions ? { allowedActions } : {}),
    ...(authIntent ? { authIntent } : {}),
    ...(requestedPath ? { requestedPath } : {}),
  });
  await approvePairingChallenge(challenge.challengeId, { approvedBy: "node:test", env: process.env });
  const paired = await pairBrowser({ challengeId: challenge.challengeId, env: process.env });
  return sessionCookieHeader(paired.token, process.env).split(";")[0];
}

/** Raw HTTP request so tests can set Host/Origin exactly like a browser or attacker would. */
export function rawRequest(port, { method = "GET", pathname = "/", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const request = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: { ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export function jsonPost(port, pathname, body, headers = {}) {
  return rawRequest(port, {
    method: "POST",
    pathname,
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}`, ...headers },
    body,
  });
}

export async function findFiles(root, name) {
  const found = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === name) found.push(full);
    }
  }
  await walk(root);
  return found;
}

export async function eventsOfType(prefix) {
  return (await listEvents(process.env, 500)).filter((event) => String(event.type || "").startsWith(prefix));
}
