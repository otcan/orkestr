import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge, authorizeHttpRequest, createPairingChallenge, pairBrowser, securityStatus } from "../packages/core/src/security.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function json(response) {
  return response.json();
}

test("browser pairing protects API routes when auth is required", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-"));
  const codexHome = path.join(home, "private-codex-home");
  const bridgeUrl = "http://127.0.0.1:9/private-wa-bridge";
  const prior = saveEnv([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_RECOVER_RUNNING_ON_START",
    "ORKESTR_CODEX_BIN",
    "CODEX_HOME",
    "WHATSAPP_BRIDGE_MODE",
    "ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED",
    "WHATSAPP_BRIDGE_URL",
    "ORKESTR_PUBLIC_HTTPS_URL",
  ]);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_CODEX_BIN = "__orkestr_codex_disabled_on_macos__";
  process.env.CODEX_HOME = codexHome;
  process.env.WHATSAPP_BRIDGE_MODE = "external";
  process.env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED = "1";
  process.env.WHATSAPP_BRIDGE_URL = bridgeUrl;
  process.env.ORKESTR_PUBLIC_HTTPS_URL = "https://orkestr-private.example.test";
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const blocked = await fetch(`${baseUrl}/api/threads`);
    assert.equal(blocked.status, 401);

    const status = await json(await fetch(`${baseUrl}/api/setup/status`));
    const statusText = JSON.stringify(status);
    assert.equal(status.security.authEnabled, true);
    assert.equal(status.security.paired, false);
    assert.equal(status.redacted, true);
    assert.equal(status.home, "");
    assert.deepEqual(status.connectors, []);
    assert.deepEqual(status.config, {});
    assert.equal(status.security.bindHost, undefined);
    assert.equal(status.security.sessionCount, undefined);
    assert.equal(status.security.https.url, undefined);
    assert.equal(status.auth.keycloak, undefined);
    assert.equal(statusText.includes(home), false);
    assert.equal(statusText.includes(codexHome), false);
    assert.equal(statusText.includes(bridgeUrl), false);
    assert.equal(statusText.includes("sessionRoot"), false);

    const challenge = await json(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
    assert.equal(challenge.ok, true);
    assert.match(challenge.challengeId, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(challenge.code, undefined);

    const badPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: "missing" }),
    });
    assert.equal(badPair.status, 401);

    const unapprovedPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    assert.equal(unapprovedPair.status, 409);

    await approvePairingChallenge(challenge.challengeId);

    const pairResponse = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    assert.equal(pairResponse.status, 200);
    const cookie = pairResponse.headers.get("set-cookie") || "";
    assert.match(cookie, /orkestr_session=/);

    const allowed = await fetch(`${baseUrl}/api/threads`, { headers: { cookie } });
    assert.equal(allowed.status, 200);
    const pairedStatus = await json(await fetch(`${baseUrl}/api/setup/status`, { headers: { cookie } }));
    const pairedStatusText = JSON.stringify(pairedStatus);
    assert.notEqual(pairedStatus.redacted, true);
    assert.equal(pairedStatus.home, home);
    assert.ok(pairedStatusText.includes(codexHome));
    assert.ok(pairedStatusText.includes(bridgeUrl));

    const secondChallenge = await json(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
    const unpairedList = await fetch(`${baseUrl}/api/setup/security/challenges`);
    assert.equal(unpairedList.status, 401);

    const pairedList = await json(await fetch(`${baseUrl}/api/setup/security/challenges`, { headers: { cookie } }));
    assert.ok(pairedList.challenges.some((item) => item.id === secondChallenge.challengeId && item.status === "pending"));

    const approveFromBrowser = await json(await fetch(`${baseUrl}/api/setup/security/challenges/${secondChallenge.challengeId}/approve`, {
      method: "POST",
      headers: { cookie },
    }));
    assert.equal(approveFromBrowser.challenge.status, "approved");

    const secondPairResponse = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: secondChallenge.challengeId }),
    });
    assert.equal(secondPairResponse.status, 200);
    assert.match(secondPairResponse.headers.get("set-cookie") || "", /orkestr_session=/);

    const sessions = await json(await fetch(`${baseUrl}/api/setup/security/sessions`, { headers: { cookie } }));
    assert.ok(sessions.sessions.length >= 1);
    assert.ok(sessions.sessions[0].id);
    assert.ok(sessions.sessions[0].lastAccessedAt);
    assert.ok("lastIp" in sessions.sessions[0]);

    const deleteChallenge = await json(await fetch(`${baseUrl}/api/setup/security/challenges/${secondChallenge.challengeId}`, {
      method: "DELETE",
      headers: { cookie },
    }));
    assert.equal(deleteChallenge.deleted, secondChallenge.challengeId);
    const afterDelete = await json(await fetch(`${baseUrl}/api/setup/security/challenges`, { headers: { cookie } }));
    assert.equal(afterDelete.challenges.some((item) => item.id === secondChallenge.challengeId), false);

    const disabled = await json(await fetch(`${baseUrl}/api/setup/security/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ enabled: false }),
    }));
    assert.equal(disabled.ok, true);
    assert.equal(disabled.security.paired, false);
    assert.equal(disabled.security.authEnabled, true);

    const revokedCookieList = await fetch(`${baseUrl}/api/setup/security/sessions`, { headers: { cookie } });
    assert.equal(revokedCookieList.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});

test("reverse proxy local publish is treated as a local external bind", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-"));
  const prior = saveEnv(["ORKESTR_HOME", "ORKESTR_HOST", "ORKESTR_REVERSE_PROXY_LOCAL_BIND"]);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_HOST = "0.0.0.0";
  process.env.ORKESTR_REVERSE_PROXY_LOCAL_BIND = "1";

  try {
    const status = await securityStatus();
    assert.equal(status.bindLocal, false);
    assert.equal(status.proxyLocalBind, true);
    assert.equal(status.externallyLocal, true);
    assert.equal(status.remoteReady, true);
    assert.deepEqual(status.warnings, []);
  } finally {
    restoreEnv(prior);
  }
});

test("security status reports optional mTLS without exposing the CA path", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-mtls-"));
  const status = await securityStatus({
    ...process.env,
    ORKESTR_HOME: home,
    ORKESTR_CADDY_ENABLED: "1",
    ORKESTR_PUBLIC_HTTPS_URL: "https://orkestr.example.test",
    ORKESTR_MTLS_ENABLED: "1",
    ORKESTR_MTLS_CA_CERT: "/etc/orkestr/client-ca.pem",
    ORKESTR_MTLS_MODE: "verify_if_given",
  });

  assert.equal(status.mtls.enabled, true);
  assert.equal(status.mtls.configured, true);
  assert.equal(status.mtls.caConfigured, true);
  assert.equal(status.mtls.mode, "verify_if_given");
  assert.equal(status.mtls.caCert, undefined);
  assert.equal(JSON.stringify(status).includes("/etc/orkestr/client-ca.pem"), false);
});

test("desktop proxy routes require pairing when auth is enabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-desktop-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
  };

  const blocked = await authorizeHttpRequest({
    method: "GET",
    url: "/desktop/linkedin/vnc.html?autoconnect=1",
    headers: {},
  }, env);
  const staticAsset = await authorizeHttpRequest({
    method: "GET",
    url: "/assets/logo.svg",
    headers: {},
  }, env);

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "browser_pairing_required");
  assert.equal(staticAsset.ok, true);
});

test("whatsapp inbound machine token bypasses browser pairing only for inbound", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-wa-inbound-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_WHATSAPP_INBOUND_TOKEN: "wa-inbound-secret",
  };

  const blocked = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/inbound",
    headers: {},
  }, env);
  const badToken = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/inbound",
    headers: { authorization: "Bearer wrong-secret" },
  }, env);
  const allowed = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/inbound",
    headers: { authorization: "Bearer wa-inbound-secret" },
  }, env);
  const otherRoute = await authorizeHttpRequest({
    method: "GET",
    url: "/api/threads",
    headers: { authorization: "Bearer wa-inbound-secret" },
  }, env);

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "browser_pairing_required");
  assert.equal(badToken.ok, false);
  assert.equal(badToken.error, "browser_pairing_required");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.machineAuth, "whatsapp_inbound");
  assert.equal(allowed.principal.userId, "admin");
  assert.equal(otherRoute.ok, false);
  assert.equal(otherRoute.error, "browser_pairing_required");
});

test("paired browser sessions can open desktop routes without desktop-share challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-desktop-session-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
  };
  const challenge = await createPairingChallenge({ env });
  await approvePairingChallenge(challenge.challengeId, { env });
  const paired = await pairBrowser({ challengeId: challenge.challengeId, env });

  const allowed = await authorizeHttpRequest({
    method: "GET",
    url: "/desktop/linkedin/vnc.html?autoconnect=1&resize=scale&path=desktop/linkedin/websockify",
    headers: { cookie: `orkestr_session=${encodeURIComponent(paired.token)}` },
  }, env);
  const stillBlockedWithoutSession = await authorizeHttpRequest({
    method: "GET",
    url: "/desktop/linkedin/vnc.html?autoconnect=1&resize=scale&path=desktop/linkedin/websockify",
    headers: {},
  }, env);

  assert.equal(allowed.ok, true);
  assert.equal(allowed.principal.userId, "admin");
  assert.equal(stillBlockedWithoutSession.ok, false);
  assert.equal(stillBlockedWithoutSession.error, "browser_pairing_required");
});
