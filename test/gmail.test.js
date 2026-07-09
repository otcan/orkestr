import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  exchangeGmailCode,
  finishGmailOAuth,
  getGmailAccessToken,
  getGmailMessage,
  listGmailMessages,
  normalizeGmailMessage,
  readGmailToken,
  refreshGmailAccessToken,
  saveBrokeredGmailGrant,
  startGmailOAuth,
} from "../packages/connectors/src/gmail.js";
import { connectorAuthStatus } from "../packages/connectors/src/connector-auth.js";
import { __brokerInstanceRegistryTestInternals } from "../packages/core/src/broker-instance-registry.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { getSetupStatus } from "../packages/core/src/setup.js";
import { userScopedCapabilityHints } from "../packages/core/src/user-skills.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { userDataPaths } from "../packages/storage/src/paths.js";

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

async function writeBrokerClientRegistration(home, { instanceId = "instance-1", channelId = "channel-1", brokerBaseUrl = "https://broker.example.test" } = {}) {
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const broker = __brokerInstanceRegistryTestInternals.createX25519Identity();
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  await fs.writeFile(path.join(home, "secrets", "broker-client-identity.json"), JSON.stringify({
    privateKey: client.privateKey,
    publicKey: client.publicKey,
  }));
  await fs.writeFile(path.join(home, "secrets", "broker-client-registration.json"), JSON.stringify({
    instanceId,
    channelId,
    brokerBaseUrl,
    brokerPublicKey: broker.publicKey,
  }));
  return { client, broker };
}

test("gmail oauth start builds an authorize URL and saves state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-start-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:19812/oauth/gmail/callback",
  }, env);

  const started = await startGmailOAuth(env, { account: "person@example.com" });
  const state = JSON.parse(await fs.readFile(path.join(home, "oauth", "gmail-state.json"), "utf8"));
  const url = new URL(started.authorizeUrl);

  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("state"), state.state);
  assert.equal(url.searchParams.get("login_hint"), "person@example.com");
  assert.equal(state.account, "person@example.com");
});

test("gmail oauth start clears stale user-scoped oauth errors", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-clear-error-"));
  const env = { ORKESTR_HOME: home };
  const principal = userPrincipal({ id: "firat", displayName: "Firat" });
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:19812/oauth/gmail/callback",
  }, env);

  const paths = userDataPaths("firat", env);
  const errorPath = path.join(paths.secrets, "gmail-error.json");
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(errorPath, JSON.stringify({ message: "Malformed auth code.", updatedAt: new Date().toISOString() }));

  const before = await getSetupStatus({ env, principal });
  assert.equal(before.connectors.find((connector) => connector.id === "gmail")?.state, "broken");

  const started = await startGmailOAuth(env, { principal, account: "person@example.com" });
  assert.equal(new URL(started.authorizeUrl).hostname, "accounts.google.com");
  await assert.rejects(fs.access(errorPath), /ENOENT/);

  const after = await getSetupStatus({ env, principal });
  assert.equal(after.connectors.find((connector) => connector.id === "gmail")?.state, "partial");
});

test("gmail oauth start can use service env app credentials", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-env-start-"));
  const env = {
    ORKESTR_HOME: home,
    GMAIL_OAUTH_CLIENT_ID: "env-client-id",
    GMAIL_OAUTH_CLIENT_SECRET: "env-client-secret",
    ORKESTR_PUBLIC_HTTPS_URL: "https://orkestr.example.test/",
  };

  const started = await startGmailOAuth(env, { account: "person@example.com" });
  const url = new URL(started.authorizeUrl);

  assert.equal(url.searchParams.get("client_id"), "env-client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "https://orkestr.example.test/oauth/gmail/callback");
  assert.equal(started.redirectUri, "https://orkestr.example.test/oauth/gmail/callback");
});

test("gmail oauth uses the public broker callback and exchanges with the started redirect", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-broker-start-"));
  const env = {
    ORKESTR_HOME: home,
    GMAIL_OAUTH_CLIENT_ID: "env-client-id",
    GMAIL_OAUTH_CLIENT_SECRET: "env-client-secret",
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.example.com/",
  };

  const started = await startGmailOAuth(env, { account: "person@example.com" });
  const savedState = JSON.parse(await fs.readFile(path.join(home, "oauth", "gmail-state.json"), "utf8"));
  const url = new URL(started.authorizeUrl);

  assert.equal(url.searchParams.get("redirect_uri"), "https://connect.example.com/oauth/gmail/callback");
  assert.equal(savedState.redirectUri, "https://connect.example.com/oauth/gmail/callback");

  const result = await finishGmailOAuth(
    new URLSearchParams({ code: "callback-code", state: started.state }),
    {
      ...env,
      GMAIL_OAUTH_REDIRECT_URI: "https://wrong.example.test/oauth/gmail/callback",
    },
    async (_url, options) => {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("redirect_uri"), "https://connect.example.com/oauth/gmail/callback");
      return jsonResponse({
        access_token: "broker-access",
        refresh_token: "broker-refresh",
        expires_in: 60,
      });
    },
  );

  assert.equal(result.ok, true);
  assert.equal((await readGmailToken(env)).accessToken, "broker-access");
});

test("brokered gmail oauth uses app callback instead of connector auth host", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-brokered-app-callback-"));
  const env = {
    ORKESTR_HOME: home,
    GMAIL_OAUTH_CLIENT_ID: "env-client-id",
    GMAIL_OAUTH_CLIENT_SECRET: "env-client-secret",
    ORKESTR_PUBLIC_APP_URL: "https://app.orkestr.de",
    ORKESTR_PUBLIC_AUTH_URL: "https://connect.orkestr.de/setup/pairing",
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.orkestr.de",
  };

  const started = await startGmailOAuth(env, {
    account: "person@example.com",
    brokerInstanceId: "instance-firat",
    brokerTenantVmId: "firat-jobs-vm",
    brokerTenantUserId: "firat",
  });
  const savedState = JSON.parse(await fs.readFile(path.join(home, "oauth", "gmail-state.json"), "utf8"));
  const url = new URL(started.authorizeUrl);

  assert.equal(started.redirectUri, "https://app.orkestr.de/oauth/gmail/callback");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.orkestr.de/oauth/gmail/callback");
  assert.equal(savedState.redirectUri, "https://app.orkestr.de/oauth/gmail/callback");
});

test("tenant gmail oauth state is prefixed for callback routing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-tenant-state-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_VM_ID: "tenant-demo-vm",
  };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://orkestr.example.test/oauth/gmail/callback",
  }, env);

  const started = await startGmailOAuth(env, { account: "person@example.com" });
  const savedState = JSON.parse(await fs.readFile(path.join(home, "oauth", "gmail-state.json"), "utf8"));
  const url = new URL(started.authorizeUrl);

  assert.match(started.state, /^tenant:tenant-demo-vm:/);
  assert.equal(savedState.state, started.state);
  assert.equal(savedState.tenantVmId, "tenant-demo-vm");
  assert.equal(url.searchParams.get("state"), started.state);
  assert.equal(url.searchParams.get("redirect_uri"), "https://orkestr.example.test/oauth/gmail/callback");
});

test("gmail authorization code is exchanged and stored securely", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-exchange-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);

  const token = await exchangeGmailCode("code-123", env, async (_url, options) => {
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "code-123");
    return jsonResponse({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      scope: "gmail",
      token_type: "Bearer",
    });
  });
  const stored = await readGmailToken(env);

  assert.equal(token.accessToken, "access-1");
  assert.equal(stored.refreshToken, "refresh-1");
});

test("gmail callback validates state and exchanges tokens", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-callback-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  const started = await startGmailOAuth(env);
  const query = new URLSearchParams({ code: "callback-code", state: started.state });

  const result = await finishGmailOAuth(query, env, async () =>
    jsonResponse({
      access_token: "access-callback",
      refresh_token: "refresh-callback",
      expires_in: 60,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal((await readGmailToken(env)).accessToken, "access-callback");
});

test("gmail callback resolves missing account from the Gmail profile", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-profile-callback-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  const accessToken = `ya29.${"a".repeat(90)}`;
  const started = await startGmailOAuth(env);
  const query = new URLSearchParams({ code: "callback-code", state: started.state });

  const result = await finishGmailOAuth(query, env, async (url) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return jsonResponse({
        access_token: accessToken,
        refresh_token: "refresh-callback",
        expires_in: 60,
      });
    }
    if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
      return jsonResponse({ emailAddress: "Person@Example.COM" });
    }
    throw new Error(`unexpected_url:${url}`);
  });
  const stored = await readGmailToken(env);

  assert.equal(result.account, "person@example.com");
  assert.equal(stored.account, "person@example.com");
});

test("gmail callback stores the Google account actually selected by the user", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-selected-account-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  const accessToken = `ya29.${"m".repeat(90)}`;
  const started = await startGmailOAuth(env, { account: "person@example.com" });
  const query = new URLSearchParams({ code: "callback-code", state: started.state });

  const result = await finishGmailOAuth(query, env, async (url) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return jsonResponse({
        access_token: accessToken,
        refresh_token: "refresh-callback",
        expires_in: 60,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      });
    }
    if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
      return jsonResponse({ emailAddress: "other@example.com" });
    }
    throw new Error(`unexpected_url:${url}`);
  });
  const stored = await readGmailToken(env);

  assert.equal(result.account, "other@example.com");
  assert.equal(stored.account, "other@example.com");
});

test("gmail connector status backfills a missing account from the Gmail profile", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-profile-status-"));
  const env = { ORKESTR_HOME: home };
  const accessToken = `ya29.${"b".repeat(90)}`;
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await exchangeGmailCode("code-123", env, async () =>
    jsonResponse({
      access_token: accessToken,
      refresh_token: "refresh-1",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      token_type: "Bearer",
    }),
  );

  const status = await connectorAuthStatus("gmail", env, {
    forceProfileLookup: true,
    fetchImpl: async (url) => {
      assert.equal(String(url), "https://gmail.googleapis.com/gmail/v1/users/me/profile");
      return jsonResponse({ emailAddress: "Connected@Example.COM" });
    },
  });
  const stored = await readGmailToken(env);

  assert.equal(status.state, "connected");
  assert.equal(status.account, "connected@example.com");
  assert.equal(stored.account, "connected@example.com");
});

test("gmail connector status backfills a missing account from Google userinfo", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-userinfo-status-"));
  const env = { ORKESTR_HOME: home };
  const accessToken = `ya29.${"u".repeat(90)}`;
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await exchangeGmailCode("code-123", env, async () =>
    jsonResponse({
      access_token: accessToken,
      refresh_token: "refresh-1",
      expires_in: 3600,
      scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
      token_type: "Bearer",
    }),
  );

  const status = await connectorAuthStatus("gmail", env, {
    fetchImpl: async (url) => {
      if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        return jsonResponse({ error: { message: "Request had insufficient authentication scopes." } }, false, 403);
      }
      if (String(url) === "https://www.googleapis.com/oauth2/v3/userinfo") {
        return jsonResponse({ email: "Selected@Example.COM" });
      }
      throw new Error(`unexpected_url:${url}`);
    },
  });
  const stored = await readGmailToken(env);

  assert.equal(status.state, "partial");
  assert.equal(status.connected, false);
  assert.equal(status.account, "selected@example.com");
  assert.equal(stored.account, "selected@example.com");
});

test("gmail oauth remembers the originating thread for callback notifications", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-callback-thread-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  const started = await startGmailOAuth(env, {
    account: "person@example.com",
    thread: {
      id: "thread-1",
      binding: {
        chatId: "wa-chat",
        responderAccountId: "wa-responder",
      },
    },
  });

  const result = await finishGmailOAuth(
    new URLSearchParams({ code: "callback-code", state: started.state }),
    env,
    async () =>
      jsonResponse({
        access_token: "access-callback",
        refresh_token: "refresh-callback",
        expires_in: 60,
      }),
  );

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.chatId, "wa-chat");
  assert.equal(result.accountId, "wa-responder");
  assert.equal(result.account, "person@example.com");
});

test("gmail oauth testing allowlist requires and validates the requested account", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-approved-testers-"));
  const env = {
    ORKESTR_HOME: home,
    GMAIL_OAUTH_CLIENT_ID: "client-id",
    GMAIL_OAUTH_CLIENT_SECRET: "client-secret",
    GMAIL_OAUTH_REDIRECT_URI: "http://localhost/callback",
    GMAIL_OAUTH_APPROVED_TESTERS: "approved@example.com",
  };

  await assert.rejects(
    () => startGmailOAuth(env),
    /gmail_account_required_for_tester_check/,
  );
  await assert.rejects(
    () => startGmailOAuth(env, { account: "other@example.com" }),
    /gmail_account_not_approved_for_testing/,
  );

  const started = await startGmailOAuth(env, { account: "approved@example.com" });
  const url = new URL(started.authorizeUrl);
  assert.equal(url.searchParams.get("login_hint"), "approved@example.com");
});

test("gmail callback rejects unknown OAuth state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-unknown-state-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);

  await assert.rejects(
    () => finishGmailOAuth(new URLSearchParams({ code: "callback-code", state: "unknown-state" }), env, async () => jsonResponse({})),
    /gmail_oauth_state_mismatch/,
  );
});

test("gmail oauth stores non-admin user tokens outside global secrets", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-user-oauth-"));
  const env = { ORKESTR_HOME: home };
  const alice = userPrincipal({ id: "alice" });
  const bob = userPrincipal({ id: "bob" });
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);

  const started = await startGmailOAuth(env, { account: "alice@example.com", principal: alice });
  const alicePaths = userDataPaths("alice", env);
  const savedState = JSON.parse(await fs.readFile(path.join(alicePaths.oauth, "gmail-state.json"), "utf8"));
  const result = await finishGmailOAuth(
    new URLSearchParams({ code: "alice-code", state: started.state }),
    env,
    async () =>
      jsonResponse({
        access_token: "alice-access",
        refresh_token: "alice-refresh",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      }),
  );

  assert.equal(savedState.userId, "alice");
  assert.equal(result.userId, "alice");
  assert.equal((await readGmailToken(env, { principal: alice })).accessToken, "alice-access");
  assert.deepEqual(await readGmailToken(env), {});
  assert.deepEqual(await readGmailToken(env, { principal: bob }), {});

  let status = await getSetupStatus({ env, home, principal: alice });
  let gmail = status.connectors.find((connector) => connector.id === "gmail");
  assert.equal(gmail.state, "connected");

  status = await getSetupStatus({ env, home, principal: bob });
  gmail = status.connectors.find((connector) => connector.id === "gmail");
  assert.equal(gmail.state, "partial");
});

test("expired gmail tokens refresh with the stored refresh token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-refresh-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await exchangeGmailCode("code-123", env, async () =>
    jsonResponse({
      access_token: "access-old",
      refresh_token: "refresh-old",
      expires_in: 1,
    }),
  );

  const refreshed = await refreshGmailAccessToken(env, async (_url, options) => {
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "refresh-old");
    return jsonResponse({
      access_token: "access-new",
      expires_in: 3600,
    });
  });

  assert.equal(refreshed.accessToken, "access-new");
  assert.equal(refreshed.refreshToken, "refresh-old");
  assert.equal(await getGmailAccessToken(env), "access-new");
});

test("brokered gmail grants refresh through the parent broker without local OAuth config", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-broker-refresh-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_VM_ID: "firat-jobs-vm",
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
  };
  await writeBrokerClientRegistration(home, {
    instanceId: "instance-firat",
    channelId: "channel-firat",
    brokerBaseUrl: "https://broker.example.test",
  });
  await saveBrokeredGmailGrant({
    userId: "firat",
    account: "firat@example.com",
    provider: "google_workspace",
    brokerInstanceId: "instance-firat",
    requestedCapabilities: ["gmail_read"],
    requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    token: {
      accessToken: "access-old",
      refreshToken: "refresh-owned-by-tenant",
      expiresAt: 1,
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    },
  }, env);

  const refreshed = await refreshGmailAccessToken(env, async (url, options = {}) => {
    assert.equal(String(url), "https://broker.example.test/api/broker/instances/instance-firat/google-workspace/refresh-token");
    const body = JSON.parse(options.body);
    assert.equal(body.channelId, "channel-firat");
    assert.ok(body.envelope);
    return jsonResponse({
      ok: true,
      token: {
        access_token: "access-new",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      },
    });
  }, { userId: "firat" });
  const stored = await readGmailToken(env, { userId: "firat" });
  const capabilities = await userScopedCapabilityHints({ userId: "firat" }, env);

  assert.equal(refreshed.accessToken, "access-new");
  assert.equal(refreshed.refreshToken, "refresh-owned-by-tenant");
  assert.equal(stored.accessToken, "access-new");
  assert.equal(stored.account, "firat@example.com");
  assert.equal(stored.brokered, true);
  assert.equal(stored.brokerInstanceId, "instance-firat");
  assert.deepEqual(capabilities.connectorAuth.gmail.capabilities, ["gmail_read"]);
});

test("gmail status does not treat base Google identity scopes as Gmail access", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-base-scopes-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_VM_ID: "firat-jobs-vm",
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
  };
  await writeBrokerClientRegistration(home, {
    instanceId: "instance-firat",
    channelId: "channel-firat",
    brokerBaseUrl: "https://broker.example.test",
  });
  await saveBrokeredGmailGrant({
    userId: "firat",
    account: "firat@example.com",
    provider: "google_workspace",
    brokerInstanceId: "instance-firat",
    requestedCapabilities: ["gmail_read"],
    requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    token: {
      accessToken: "access-profile-only",
      refreshToken: "refresh-owned-by-tenant",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      grantedScopes: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ],
    },
  }, env);

  const status = await connectorAuthStatus("gmail", env, { userId: "firat" });
  const capabilities = await userScopedCapabilityHints({ userId: "firat" }, env);

  assert.equal(status.state, "partial");
  assert.equal(status.connected, false);
  assert.deepEqual(status.capabilities, []);
  assert.deepEqual(status.grantedScopes, [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ]);
  assert.equal(capabilities.gmail, false);
  assert.equal(capabilities.scopedConnectors.gmail, false);
  assert.deepEqual(capabilities.connectorAuth.gmail.capabilities, []);
});

test("gmail connector status refreshes expired brokered tokens before account lookup", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-broker-profile-refresh-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_VM_ID: "firat-jobs-vm",
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
  };
  await writeBrokerClientRegistration(home, {
    instanceId: "instance-firat",
    channelId: "channel-firat",
    brokerBaseUrl: "https://broker.example.test",
  });
  await saveBrokeredGmailGrant({
    userId: "firat",
    provider: "google_workspace",
    brokerInstanceId: "instance-firat",
    requestedCapabilities: ["gmail_read"],
    requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    token: {
      accessToken: "expired-access",
      refreshToken: "refresh-owned-by-tenant",
      expiresAt: 1,
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    },
  }, env);
  const refreshedAccessToken = `ya29.${"d".repeat(90)}`;
  const calls = [];

  const status = await connectorAuthStatus("gmail", env, {
    userId: "firat",
    fetchImpl: async (url, options = {}) => {
      calls.push(String(url));
      if (String(url) === "https://broker.example.test/api/broker/instances/instance-firat/google-workspace/refresh-token") {
        return jsonResponse({
          ok: true,
          token: {
            access_token: refreshedAccessToken,
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/gmail.readonly",
          },
        });
      }
      if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        assert.equal(options.headers.authorization, `Bearer ${refreshedAccessToken}`);
        return jsonResponse({ emailAddress: "Firat@Example.COM" });
      }
      throw new Error(`unexpected_url:${url}`);
    },
  });
  const stored = await readGmailToken(env, { userId: "firat" });

  assert.equal(status.account, "firat@example.com");
  assert.equal(stored.account, "firat@example.com");
  assert.deepEqual(calls, [
    "https://broker.example.test/api/broker/instances/instance-firat/google-workspace/refresh-token",
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  ]);
});

test("gmail oauth token failures are reflected in setup status", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-error-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);

  await assert.rejects(
    () =>
      exchangeGmailCode("bad-code", env, async () =>
        jsonResponse({ error: "invalid_grant", error_description: "Bad code" }, false, 400),
      ),
    /Bad code/,
  );
  const status = await getSetupStatus({ env, home });
  const gmail = status.connectors.find((connector) => connector.id === "gmail");
  assert.equal(gmail.state, "broken");
  assert.equal(gmail.details.error, "Bad code");
});

test("successful gmail oauth clears previous token error status", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-error-clear-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await assert.rejects(
    () =>
      exchangeGmailCode("bad-code", env, async () =>
        jsonResponse({ error: "invalid_grant", error_description: "Bad code" }, false, 400),
      ),
    /Bad code/,
  );

  await exchangeGmailCode(
    "good-code",
    env,
    async () =>
      jsonResponse({
        access_token: "access-ok",
        refresh_token: "refresh-ok",
        expires_in: 3600,
      }),
    { account: "person@example.com" },
  );

  const status = await getSetupStatus({ env, home });
  const gmail = status.connectors.find((connector) => connector.id === "gmail");
  assert.equal(gmail.state, "connected");
  assert.equal(gmail.details.account, "person@example.com");
  assert.equal(gmail.details.error, undefined);
});

test("gmail message list uses stored access token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-list-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await exchangeGmailCode("code-123", env, async () =>
    jsonResponse({
      access_token: "access-list",
      refresh_token: "refresh-list",
      expires_in: 3600,
    }),
  );

  const result = await listGmailMessages({ maxResults: 2, query: "from:recruiter" }, env, async (url, options) => {
    assert.equal(url.pathname, "/gmail/v1/users/me/messages");
    assert.equal(url.searchParams.get("maxResults"), "2");
    assert.equal(url.searchParams.get("q"), "from:recruiter");
    assert.equal(options.headers.authorization, "Bearer access-list");
    return jsonResponse({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
  });

  assert.equal(result.messages[0].id, "m1");
});

test("gmail message list reads the scoped user access token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-user-list-"));
  const env = { ORKESTR_HOME: home };
  const alice = userPrincipal({ id: "alice" });
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await exchangeGmailCode(
    "code-123",
    env,
    async () =>
      jsonResponse({
        access_token: "alice-access-list",
        refresh_token: "alice-refresh-list",
        expires_in: 3600,
      }),
    { principal: alice },
  );

  const result = await listGmailMessages({ maxResults: 1 }, env, async (_url, options) => {
    assert.equal(options.headers.authorization, "Bearer alice-access-list");
    return jsonResponse({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
  }, { principal: alice });

  assert.equal(result.messages[0].id, "m1");
});

test("gmail message fetch normalizes headers and text", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-fetch-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/callback",
  }, env);
  await exchangeGmailCode("code-123", env, async () =>
    jsonResponse({
      access_token: "access-fetch",
      refresh_token: "refresh-fetch",
      expires_in: 3600,
    }),
  );

  const message = await getGmailMessage("m1", env, async (url, options) => {
    assert.equal(url.pathname, "/gmail/v1/users/me/messages/m1");
    assert.equal(url.searchParams.get("format"), "full");
    assert.equal(options.headers.authorization, "Bearer access-fetch");
    return jsonResponse({
      id: "m1",
      threadId: "t1",
      snippet: "Snippet",
      payload: {
        headers: [
          { name: "Subject", value: "Recruiting" },
          { name: "From", value: "recruiter@example.com" },
          { name: "Date", value: "Fri, 15 May 2026 10:00:00 +0000" },
        ],
        parts: [
          {
            mimeType: "text/plain",
            body: { data: Buffer.from("Plain body", "utf8").toString("base64url") },
          },
        ],
      },
    });
  });

  assert.equal(message.subject, "Recruiting");
  assert.equal(message.from, "recruiter@example.com");
  assert.equal(message.text, "Plain body");
});

test("gmail message normalization falls back to snippet", () => {
  const message = normalizeGmailMessage({
    id: "m2",
    threadId: "t2",
    snippet: "Only snippet",
    payload: { headers: [{ name: "Subject", value: "Hello" }] },
  });
  assert.equal(message.subject, "Hello");
  assert.equal(message.text, "Only snippet");
});
