import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { __brokerInstanceRegistryTestInternals, encryptBrokerChannelPayload } from "../packages/core/src/broker-instance-registry.js";
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

test("public URL configuration requires pairing by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-public-"));
  const prior = saveEnv([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED",
    "ORKESTR_PRIMARY_DOMAIN",
    "ORKESTR_APP_HOST",
    "ORKESTR_AUTH_HOST",
    "ORKESTR_PUBLIC_URL",
    "ORKESTR_PUBLIC_HTTPS_URL",
    "ORKESTR_CONNECT_PUBLIC_URL",
    "ORKESTR_HOST",
  ]);
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_AUTH_REQUIRED;
  delete process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED;
  process.env.ORKESTR_PRIMARY_DOMAIN = "orkestr.example.test";
  process.env.ORKESTR_APP_HOST = "app.orkestr.example.test";
  process.env.ORKESTR_AUTH_HOST = "auth.orkestr.example.test";
  process.env.ORKESTR_HOST = "127.0.0.1";

  try {
    const status = await securityStatus();
    assert.equal(status.authRequired, true);
    assert.equal(status.authEnabled, true);

    const blocked = await authorizeHttpRequest({ method: "GET", url: "/api/threads", headers: {} });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.statusCode, 401);
    assert.equal(blocked.error, "browser_pairing_required");

    const setupStatus = await authorizeHttpRequest({ method: "GET", url: "/api/setup/status", headers: {} });
    assert.equal(setupStatus.ok, true);
  } finally {
    restoreEnv(prior);
  }
});

test("public unauthenticated mode requires explicit unsafe override", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-unsafe-public-"));
  const prior = saveEnv([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED",
    "ORKESTR_PUBLIC_URL",
    "ORKESTR_HOST",
  ]);
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_AUTH_REQUIRED;
  process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED = "1";
  process.env.ORKESTR_PUBLIC_URL = "https://app.orkestr.example.test";
  process.env.ORKESTR_HOST = "127.0.0.1";

  try {
    const status = await securityStatus();
    assert.equal(status.authRequired, false);
    assert.equal(status.authEnabled, false);

    const allowed = await authorizeHttpRequest({ method: "GET", url: "/api/threads", headers: {} });
    assert.equal(allowed.ok, true);
  } finally {
    restoreEnv(prior);
  }
});

test("scoped WhatsApp machine tokens allow only declared bridge capabilities", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-wa-scoped-bridge-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_WHATSAPP_SCOPED_TOKENS_JSON: JSON.stringify([
      {
        id: "remote-send",
        token: "send-token",
        scopes: ["whatsapp:bridge:send"],
        principalKind: "external_instance",
        principalId: "remote-instance",
        instanceId: "remote-instance",
        allowedPhoneNumbers: ["+49176123456"],
        allowedChatIds: ["49176999999@c.us"],
      },
      {
        id: "remote-read",
        token: "read-token",
        scopes: ["whatsapp:bridge:read"],
        principalKind: "external_user",
        principalId: "external-user-1",
      },
      {
        id: "remote-manage",
        token: "manage-token",
        scopes: ["whatsapp:bridge:manage"],
        principalKind: "external_instance",
        principalId: "remote-manager",
      },
    ]),
  };

  const sendAllowed = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/bridge/send-text",
    headers: { authorization: "Bearer send-token" },
  }, env);
  const readDenied = await authorizeHttpRequest({
    method: "GET",
    url: "/api/connectors/whatsapp/bridge/accounts",
    headers: { authorization: "Bearer send-token" },
  }, env);
  const readAllowed = await authorizeHttpRequest({
    method: "GET",
    url: "/api/connectors/whatsapp/bridge/accounts",
    headers: { authorization: "Bearer read-token" },
  }, env);
  const injectDenied = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/bridge/inject-message",
    headers: { authorization: "Bearer send-token" },
  }, env);
  const injectAllowed = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/bridge/inject-message",
    headers: { authorization: "Bearer manage-token" },
  }, env);

  assert.equal(sendAllowed.ok, true);
  assert.equal(sendAllowed.machineAuth, "whatsapp_bridge");
  assert.equal(sendAllowed.machineAuthContext.tokenId, "remote-send");
  assert.equal(sendAllowed.machineAuthContext.instanceId, "remote-instance");
  assert.deepEqual(sendAllowed.machineAuthContext.scopes, ["whatsapp:bridge:send"]);
  assert.deepEqual(sendAllowed.machineAuthContext.allowedPhoneNumbers, ["+49176123456"]);
  assert.deepEqual(sendAllowed.machineAuthContext.allowedChatIds, ["49176999999@c.us"]);
  assert.equal(readDenied.ok, false);
  assert.equal(readDenied.statusCode, 403);
  assert.equal(readDenied.error, "wa_token_scope_denied");
  assert.equal(readDenied.routingFailure.code, "wa_token_scope_denied");
  assert.equal(readAllowed.ok, true);
  assert.equal(readAllowed.machineAuthContext.principalKind, "external_user");
  assert.equal(injectDenied.ok, false);
  assert.equal(injectDenied.error, "wa_token_scope_denied");
  assert.equal(injectAllowed.ok, true);
  assert.equal(injectAllowed.machineAuthContext.tokenId, "remote-manage");
});

test("scoped WhatsApp inbound tokens are accepted without granting bridge send", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-wa-scoped-inbound-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_WHATSAPP_SCOPED_TOKENS_JSON: JSON.stringify([
      {
        id: "remote-inbound",
        token: "inbound-token",
        scopes: ["whatsapp:inbound"],
        principalKind: "external_instance",
        principalId: "remote-child",
        instanceId: "remote-child",
      },
    ]),
  };

  const inboundAllowed = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/inbound",
    headers: { authorization: "Bearer inbound-token" },
  }, env);
  const bridgeDenied = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/bridge/send-text",
    headers: { authorization: "Bearer inbound-token" },
  }, env);

  assert.equal(inboundAllowed.ok, true);
  assert.equal(inboundAllowed.machineAuth, "whatsapp_inbound");
  assert.equal(inboundAllowed.machineAuthContext.tokenId, "remote-inbound");
  assert.equal(bridgeDenied.ok, false);
  assert.equal(bridgeDenied.statusCode, 403);
  assert.equal(bridgeDenied.error, "wa_token_scope_denied");
});

test("non-local bind requires pairing by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-nonlocal-"));
  const prior = saveEnv([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED",
    "ORKESTR_PUBLIC_URL",
    "ORKESTR_HOST",
  ]);
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_AUTH_REQUIRED;
  delete process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED;
  delete process.env.ORKESTR_PUBLIC_URL;
  process.env.ORKESTR_HOST = "0.0.0.0";

  try {
    const status = await securityStatus();
    assert.equal(status.authRequired, true);
    assert.equal(status.authEnabled, true);

    const blocked = await authorizeHttpRequest({ method: "GET", url: "/api/users", headers: {} });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.statusCode, 401);
  } finally {
    restoreEnv(prior);
  }
});

test("browser pairing challenges reuse the same client scope and rate-limit pending spam", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-challenge-limits-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_SECURITY_CHALLENGE_CLIENT_PENDING_LIMIT: "1",
  };
  const request = {
    ip: "203.0.113.10",
    headers: { "user-agent": "node:test pairing limits" },
  };

  const first = await createPairingChallenge({
    env,
    request,
    instanceId: "demo-vm-001",
    requestedPath: "/app/",
    reusePending: true,
  });
  const reused = await createPairingChallenge({
    env,
    request,
    instanceId: "demo-vm-001",
    requestedPath: "/app/",
    reusePending: true,
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.challengeId, first.challengeId);

  await assert.rejects(
    () => createPairingChallenge({
      env,
      request,
      instanceId: "demo-vm-002",
      requestedPath: "/app/",
      reusePending: true,
    }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.message, "pairing_challenge_rate_limited");
      assert.equal(error.reason, "client_pending_limit");
      return true;
    },
  );
});

test("browser pairing attempts are rate-limited by client IP", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-pair-limits-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_SECURITY_PAIR_ATTEMPT_IP_LIMIT: "1",
  };

  await assert.rejects(
    () => pairBrowser({ env, challengeId: "missing", ip: "203.0.113.20" }),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.equal(error.message, "invalid_or_expired_pairing_challenge");
      return true;
    },
  );
  await assert.rejects(
    () => pairBrowser({ env, challengeId: "missing", ip: "203.0.113.20" }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.message, "pairing_attempt_rate_limited");
      return true;
    },
  );
});

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

    const challenge = await json(await fetch(`${baseUrl}/api/setup/security/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "demo-vm-001" }),
    }));
    assert.equal(challenge.ok, true);
    assert.match(challenge.challengeId, /^[A-Za-z0-9_-]{20,}$/);
    assert.match(challenge.challenge.approveCode, /^[A-Z0-9]{4,8}$/);
    assert.equal(challenge.challenge.instanceId, "demo-vm-001");
    assert.equal(challenge.code, undefined);

    const codeStatus = await fetch(`${baseUrl}/api/setup/security/challenges/${challenge.challenge.approveCode}`);
    assert.equal(codeStatus.status, 404);

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

    await approvePairingChallenge(challenge.challenge.approveCode);

    const codePairResponse = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challenge.approveCode }),
    });
    assert.equal(codePairResponse.status, 401);

    const pairResponse = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    assert.equal(pairResponse.status, 200);
    const pairPayload = await json(pairResponse.clone());
    assert.equal(pairPayload.session.instanceId, "demo-vm-001");
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

    const secondChallenge = await json(await fetch(`${baseUrl}/api/setup/security/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "demo-vm-002" }),
    }));
    const unpairedList = await fetch(`${baseUrl}/api/setup/security/challenges`);
    assert.equal(unpairedList.status, 401);

    const pairedList = await json(await fetch(`${baseUrl}/api/setup/security/challenges`, { headers: { cookie } }));
    assert.ok(pairedList.challenges.some((item) => item.id === secondChallenge.challengeId && item.status === "pending" && item.instanceId === "demo-vm-002"));

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

test("CLI machine auth can read full setup status when pairing is required", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-cli-setup-"));
  const token = "cli-setup-token";
  const prior = saveEnv([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_RECOVER_RUNNING_ON_START",
    "ORKESTR_CODEX_BIN",
    "CODEX_HOME",
    "ORKESTR_PUBLIC_HTTPS_URL",
  ]);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_CODEX_BIN = "__orkestr_codex_disabled_on_macos__";
  process.env.CODEX_HOME = path.join(home, "private-codex-home");
  process.env.ORKESTR_PUBLIC_HTTPS_URL = "https://orkestr-private.example.test";
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  await fs.writeFile(path.join(home, "secrets", "cli-auth.json"), JSON.stringify({
    token,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const redacted = await json(await fetch(`${baseUrl}/api/setup/status`));
    assert.equal(redacted.redacted, true);
    assert.deepEqual(redacted.connectors, []);

    const full = await json(await fetch(`${baseUrl}/api/setup/status`, {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.notEqual(full.redacted, true);
    assert.equal(full.home, home);
    assert.equal(full.connectors.some((connector) => connector.id === "codex"), true);
    assert.equal(full.connectors.some((connector) => connector.id === "whatsapp"), true);
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
  assert.equal(blocked.error, "whatsapp_inbound_token_required");
  assert.equal(blocked.routingFailure.code, "whatsapp_inbound_token_required");
  assert.equal(badToken.ok, false);
  assert.equal(badToken.error, "whatsapp_inbound_token_invalid");
  assert.equal(badToken.routingFailure.code, "whatsapp_inbound_token_invalid");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.machineAuth, "whatsapp_inbound");
  assert.equal(allowed.machineAuthContext.tokenId, "configured-inbound-token");
  assert.equal(allowed.machineAuthContext.routeKind, "whatsapp_inbound");
  assert.deepEqual(allowed.machineAuthContext.scopes, ["whatsapp:inbound"]);
  assert.equal(allowed.principal.userId, "admin");
  assert.equal(otherRoute.ok, false);
  assert.equal(otherRoute.error, "browser_pairing_required");
});

test("whatsapp bridge machine token bypasses browser pairing only for bridge routes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-wa-bridge-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_WHATSAPP_BRIDGE_TOKEN: "wa-bridge-secret",
  };

  const blocked = await authorizeHttpRequest({
    method: "GET",
    url: "/api/connectors/whatsapp/bridge/health",
    headers: {},
  }, env);
  const badToken = await authorizeHttpRequest({
    method: "GET",
    url: "/api/connectors/whatsapp/bridge/health",
    headers: { authorization: "Bearer wrong-secret" },
  }, env);
  const allowedHealth = await authorizeHttpRequest({
    method: "GET",
    url: "/api/connectors/whatsapp/bridge/health",
    headers: { authorization: "Bearer wa-bridge-secret" },
  }, env);
  const allowedSend = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/bridge/send-text",
    headers: { authorization: "Bearer wa-bridge-secret" },
  }, env);
  const otherRoute = await authorizeHttpRequest({
    method: "GET",
    url: "/api/threads",
    headers: { authorization: "Bearer wa-bridge-secret" },
  }, env);

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "whatsapp_bridge_token_required");
  assert.equal(blocked.routingFailure.code, "whatsapp_bridge_token_required");
  assert.equal(badToken.ok, false);
  assert.equal(badToken.error, "whatsapp_bridge_token_invalid");
  assert.equal(badToken.routingFailure.code, "whatsapp_bridge_token_invalid");
  assert.equal(allowedHealth.ok, true);
  assert.equal(allowedHealth.machineAuth, "whatsapp_bridge");
  assert.equal(allowedSend.ok, true);
  assert.equal(allowedSend.machineAuth, "whatsapp_bridge");
  assert.equal(otherRoute.ok, false);
  assert.equal(otherRoute.error, "browser_pairing_required");
});

test("configured WhatsApp bridge token can be constrained to router recipient allowlists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-wa-bridge-allowlist-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_WHATSAPP_BRIDGE_TOKEN: "wa-bridge-secret",
    ORKESTR_WHATSAPP_BRIDGE_ACCOUNT_ID: "responder",
    ORKESTR_WHATSAPP_BRIDGE_ALLOWED_PHONE_NUMBERS: "+49176123456,+49176999999",
  };

  const allowed = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/bridge/send-text",
    headers: { authorization: "Bearer wa-bridge-secret" },
  }, env);

  assert.equal(allowed.ok, true);
  assert.equal(allowed.machineAuth, "whatsapp_bridge");
  assert.equal(allowed.machineAuthContext.accountId, "responder");
  assert.deepEqual(allowed.machineAuthContext.allowedPhoneNumbers, ["+49176123456", "+49176999999"]);
});

test("local CLI machine token bypasses browser pairing for operator routes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-cli-token-"));
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  await fs.writeFile(path.join(home, "secrets", "cli-auth.json"), JSON.stringify({
    schemaVersion: 1,
    token: "cli-secret",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), "utf8");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
  };

  const blocked = await authorizeHttpRequest({
    method: "GET",
    url: "/api/threads",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  }, env);
  const badToken = await authorizeHttpRequest({
    method: "GET",
    url: "/api/threads",
    headers: { authorization: "Bearer wrong-secret" },
    socket: { remoteAddress: "127.0.0.1" },
  }, env);
  const remoteToken = await authorizeHttpRequest({
    method: "GET",
    url: "/api/threads",
    headers: { authorization: "Bearer cli-secret" },
    socket: { remoteAddress: "203.0.113.4" },
  }, env);
  const allowed = await authorizeHttpRequest({
    method: "GET",
    url: "/api/threads",
    headers: { authorization: "Bearer cli-secret" },
    socket: { remoteAddress: "127.0.0.1" },
  }, env);

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "browser_pairing_required");
  assert.equal(badToken.ok, false);
  assert.equal(badToken.error, "browser_pairing_required");
  assert.equal(remoteToken.ok, false);
  assert.equal(remoteToken.error, "browser_pairing_required");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.machineAuth, "cli");
  assert.equal(allowed.principal.userId, "admin");
});

test("local CLI machine token can operate WhatsApp bridge routes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-cli-wa-bridge-"));
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  await fs.writeFile(path.join(home, "secrets", "cli-auth.json"), JSON.stringify({
    schemaVersion: 1,
    token: "cli-secret",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), "utf8");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_WHATSAPP_BRIDGE_TOKEN: "wa-bridge-secret",
  };

  const allowed = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/bridge/send-text",
    headers: { authorization: "Bearer cli-secret" },
    socket: { remoteAddress: "127.0.0.1" },
  }, env);
  const badBridgeToken = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/whatsapp/bridge/send-text",
    headers: { authorization: "Bearer wrong-secret" },
    socket: { remoteAddress: "127.0.0.1" },
  }, env);

  assert.equal(allowed.ok, true);
  assert.equal(allowed.machineAuth, "cli");
  assert.equal(badBridgeToken.ok, false);
  assert.equal(badBridgeToken.error, "whatsapp_bridge_token_invalid");
});

test("shared broker authorization accepts matching encrypted proxy assertions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-broker-proxy-"));
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const broker = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const channelId = "broker-channel-one";
  const instanceId = "instance-firat";
  await fs.writeFile(path.join(home, "secrets", "broker-client-identity.json"), JSON.stringify({
    schemaVersion: 1,
    keyId: "client-key",
    publicKey: client.publicKey,
    privateKey: client.privateKey,
  }), "utf8");
  await fs.writeFile(path.join(home, "secrets", "broker-client-registration.json"), JSON.stringify({
    schemaVersion: 1,
    brokerBaseUrl: "https://broker.example.test",
    instanceId,
    channelId,
    brokerPublicKey: broker.publicKey,
    clientKeyId: "client-key",
  }), "utf8");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_SHARED_AUTHORIZATION: "1",
    ORKESTR_BROKER_INSTANCE_ID: instanceId,
  };
  const headerFor = (patch = {}) => {
    const now = Date.now();
    const body = {
      channelId,
      envelope: encryptBrokerChannelPayload({
        kind: "broker_app_proxy",
        instanceId,
        method: "GET",
        path: "/api/threads",
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 30_000).toISOString(),
        ...patch,
      }, {
        clientPrivateKey: broker.privateKey,
        brokerPublicKey: client.publicKey,
        channelId,
      }),
    };
    return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  };

  const blocked = await authorizeHttpRequest({
    method: "GET",
    url: "/api/threads",
    headers: {},
    socket: { remoteAddress: "10.43.0.10" },
  }, env);
  const allowed = await authorizeHttpRequest({
    method: "GET",
    url: "/api/threads",
    headers: { "x-orkestr-broker-auth": headerFor() },
    socket: { remoteAddress: "10.43.0.10" },
  }, env);
  const wrongPath = await authorizeHttpRequest({
    method: "GET",
    url: "/api/threads",
    headers: { "x-orkestr-broker-auth": headerFor({ path: "/api/users" }) },
    socket: { remoteAddress: "10.43.0.10" },
  }, env);

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "browser_pairing_required");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.machineAuth, "broker_proxy");
  assert.equal(allowed.principal.userId, "admin");
  assert.equal(wrongPath.ok, false);
  assert.equal(wrongPath.error, "broker_proxy_auth_path_mismatch");
});

test("broker proxy setup status is treated as paired for tenant WebUI", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-broker-setup-status-"));
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  const prior = saveEnv([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_SHARED_AUTHORIZATION",
    "ORKESTR_BROKER_INSTANCE_ID",
    "ORKESTR_RECOVER_RUNNING_ON_START",
  ]);
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const broker = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const channelId = "broker-channel-setup-status";
  const instanceId = "instance-firat";
  await fs.writeFile(path.join(home, "secrets", "broker-client-identity.json"), JSON.stringify({
    schemaVersion: 1,
    keyId: "client-key",
    publicKey: client.publicKey,
    privateKey: client.privateKey,
  }), "utf8");
  await fs.writeFile(path.join(home, "secrets", "broker-client-registration.json"), JSON.stringify({
    schemaVersion: 1,
    brokerBaseUrl: "https://broker.example.test",
    instanceId,
    channelId,
    brokerPublicKey: broker.publicKey,
    clientKeyId: "client-key",
  }), "utf8");
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_SHARED_AUTHORIZATION = "1";
  process.env.ORKESTR_BROKER_INSTANCE_ID = instanceId;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const now = Date.now();
  const header = Buffer.from(JSON.stringify({
    channelId,
    envelope: encryptBrokerChannelPayload({
      kind: "broker_app_proxy",
      instanceId,
      method: "GET",
      path: "/api/setup/status",
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
    }, {
      clientPrivateKey: broker.privateKey,
      brokerPublicKey: client.publicKey,
      channelId,
    }),
  }), "utf8").toString("base64url");

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const unpaired = await json(await fetch(`http://127.0.0.1:${port}/api/setup/status`));
    const proxied = await json(await fetch(`http://127.0.0.1:${port}/api/setup/status`, {
      headers: { "x-orkestr-broker-auth": header },
    }));

    assert.equal(unpaired.redacted, true);
    assert.equal(unpaired.security.paired, false);
    assert.notEqual(proxied.redacted, true);
    assert.equal(proxied.security.authEnabled, true);
    assert.equal(proxied.security.paired, true);
    assert.equal(proxied.security.remoteReady, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});

test("shared broker authorization tolerates stale cached registration channels", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-security-broker-proxy-stale-"));
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const broker = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const pinnedInstanceId = "instance-firat-public";
  const cachedInstanceId = "instance-firat-reregistered";
  const assertionChannelId = "broker-channel-public";
  const cachedChannelId = "broker-channel-reregistered";
  await fs.writeFile(path.join(home, "secrets", "broker-client-identity.json"), JSON.stringify({
    schemaVersion: 1,
    keyId: "client-key",
    publicKey: client.publicKey,
    privateKey: client.privateKey,
  }), "utf8");
  await fs.writeFile(path.join(home, "secrets", "broker-client-registration.json"), JSON.stringify({
    schemaVersion: 1,
    brokerBaseUrl: "https://broker.example.test",
    instanceId: cachedInstanceId,
    channelId: cachedChannelId,
    brokerPublicKey: broker.publicKey,
    clientKeyId: "client-key",
  }), "utf8");
  const now = Date.now();
  const body = {
    channelId: assertionChannelId,
    envelope: encryptBrokerChannelPayload({
      kind: "broker_app_proxy",
      instanceId: pinnedInstanceId,
      method: "GET",
      path: "/api/whereiam?cwd=%2Fworkspace",
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
    }, {
      clientPrivateKey: broker.privateKey,
      brokerPublicKey: client.publicKey,
      channelId: assertionChannelId,
    }),
  };
  const header = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const allowed = await authorizeHttpRequest({
    method: "GET",
    url: "/api/whereiam?cwd=%2Fworkspace",
    headers: { "x-orkestr-broker-auth": header },
    socket: { remoteAddress: "10.43.0.10" },
  }, {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_SHARED_AUTHORIZATION: "1",
    ORKESTR_BROKER_INSTANCE_ID: pinnedInstanceId,
  });

  assert.equal(allowed.ok, true);
  assert.equal(allowed.machineAuth, "broker_proxy");
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
