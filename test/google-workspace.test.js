import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createGoogleCalendarEvent,
  createGmailDraft,
  createGoogleWorkspaceConnectLink,
  deleteGoogleCalendarEvent,
  getGoogleDriveFile,
  getGoogleWorkspaceConnectRequest,
  googleWorkspaceBrokeredConnectorSetupHref,
  googleWorkspaceConnectHtml,
  listGoogleCalendarEvents,
  modifyGmailMessage,
  sendGmailDraft,
  startGoogleWorkspaceOAuth,
  updateGoogleCalendarEvent,
} from "../packages/connectors/src/google-workspace.js";
import {
  googleWorkspaceCapabilitiesForScopes,
  googleWorkspaceScopesForCapabilities,
  normalizeGoogleWorkspaceCapabilities,
} from "../packages/connectors/src/google-workspace-scopes.js";
import { exchangeGmailCode, finishGmailOAuth, readGmailToken } from "../packages/connectors/src/gmail.js";
import {
  __brokerInstanceRegistryTestInternals,
  decryptBrokerClientPayload,
  registerBrokerInstance,
} from "../packages/core/src/broker-instance-registry.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { connectorAuthStatus } from "../packages/connectors/src/connector-auth.js";
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

function textResponse(text, ok = true, status = 200) {
  return {
    ok,
    status,
    async text() {
      return text;
    },
  };
}

async function configureGoogle(home) {
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.example.test",
  };
  await writeConnectorConfig("gmail", {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost/oauth/gmail/callback",
  }, env);
  return env;
}

async function writeTenantBrokerClientRegistration(home, client, registration, brokerBaseUrl = "https://broker.example.test") {
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  await fs.writeFile(path.join(home, "secrets", "broker-client-identity.json"), JSON.stringify({
    privateKey: client.privateKey,
    publicKey: client.publicKey,
  }));
  await fs.writeFile(path.join(home, "secrets", "broker-client-registration.json"), JSON.stringify({
    instanceId: registration.instanceId,
    channelId: registration.channelId,
    brokerBaseUrl,
    brokerPublicKey: registration.broker.publicKey,
  }));
}

async function storeToken(env, scope, principal = null) {
  await exchangeGmailCode(
    "code-123",
    env,
    async () =>
      jsonResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope,
      }),
    principal ? { principal } : {},
  );
}

test("google workspace scope selection maps only requested capabilities", () => {
  const capabilities = normalizeGoogleWorkspaceCapabilities(["gmail_send", "gmail_drafts", "calendar_read", "calendar_actions", "drive_file"]);
  const scopes = googleWorkspaceScopesForCapabilities(capabilities);

  assert.deepEqual(capabilities, ["gmail_send", "gmail_drafts", "calendar_read", "calendar_actions", "drive_file"]);
  assert.ok(scopes.includes("openid"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.send"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.compose"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events.owned"));
  assert.equal(scopes.includes("https://www.googleapis.com/auth/calendar.events.readonly"), false);
  assert.equal(scopes.includes("https://www.googleapis.com/auth/calendar.events"), false);
  assert.ok(scopes.includes("https://www.googleapis.com/auth/drive.file"));
  assert.equal(scopes.includes("https://www.googleapis.com/auth/gmail.modify"), false);
  assert.equal(scopes.includes("https://www.googleapis.com/auth/drive.readonly"), false);

  assert.deepEqual(
    googleWorkspaceCapabilitiesForScopes("openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly"),
    ["gmail_read", "calendar_read"],
  );
  assert.deepEqual(
    googleWorkspaceCapabilitiesForScopes("openid https://www.googleapis.com/auth/calendar.events.owned"),
    ["calendar_read", "calendar_actions"],
  );
  assert.deepEqual(
    googleWorkspaceCapabilitiesForScopes("openid https://www.googleapis.com/auth/calendar.events"),
    ["calendar_read", "calendar_actions"],
  );
  assert.deepEqual(
    googleWorkspaceCapabilitiesForScopes("openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile", ["gmail_read"]),
    [],
  );
  assert.deepEqual(googleWorkspaceCapabilitiesForScopes("", ["gmail_read"]), ["gmail_read"]);
});

test("whatsapp google connect link starts user-scoped oauth with selected scopes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-start-"));
  const env = await configureGoogle(home);
  env.ORKESTR_GOOGLE_OAUTH_ALLOWED_CAPABILITIES = "all";
  env.ORKESTR_GOOGLE_OAUTH_DEFAULT_APP = "orkestr-de";
  env.ORKESTR_GOOGLE_OAUTH_APPS_JSON = JSON.stringify({
    "otcan-claw": {
      clientId: "testing-client",
      clientSecret: "testing-secret",
      approvedTesters: ["can@mayamilk.com"],
    },
  });
  const alice = userPrincipal({ id: "alice" });

  const link = await createGoogleWorkspaceConnectLink({
    principal: alice,
    thread: {
      id: "thread-1",
      binding: { chatId: "wa-chat", responderAccountId: "wa-responder" },
    },
    account: "can@mayamilk.com",
    oauthAppId: "otcan-claw",
    useMode: "explicit_only",
  }, env);
  assert.match(link.link, /^https:\/\/connect\.example\.test\/connect\/google\?connect=/);

  const request = await getGoogleWorkspaceConnectRequest(link.connectId, env);
  assert.equal(request.ok, true);
  assert.equal(request.request.userId, "alice");
  assert.equal(request.request.oauthAppId, "otcan-claw");

  const started = await startGoogleWorkspaceOAuth(env, {
    connectId: link.connectId,
    capabilities: ["gmail_read", "calendar_read"],
  });
  const statePath = path.join(userDataPaths("alice", env).oauth, "gmail-state.json");
  const savedState = JSON.parse(await fs.readFile(statePath, "utf8"));
  const url = new URL(started.authorizeUrl);
  const scopes = url.searchParams.get("scope").split(/\s+/g);

  assert.equal(savedState.provider, "google_workspace");
  assert.equal(savedState.threadId, "thread-1");
  assert.equal(savedState.chatId, "wa-chat");
  assert.equal(savedState.oauthAppId, "otcan-claw");
  assert.equal(url.searchParams.get("client_id"), "testing-client");
  assert.deepEqual(savedState.requestedCapabilities, ["gmail_read", "calendar_read"]);
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.readonly"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events.readonly"));
  assert.equal(scopes.includes("https://www.googleapis.com/auth/gmail.modify"), false);
  assert.equal(scopes.includes("https://www.googleapis.com/auth/drive.file"), false);
});

test("google workspace oauth defaults to Gmail send access", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-default-gmail-"));
  const env = await configureGoogle(home);
  const alice = userPrincipal({ id: "alice" });
  const link = await createGoogleWorkspaceConnectLink({ principal: alice, thread: { id: "thread-1" } }, env);

  const privacyConsentAt = "2026-07-23T10:00:00.000Z";
  const started = await startGoogleWorkspaceOAuth(env, {
    connectId: link.connectId,
    privacyPolicyVersion: "2026-07-23.2",
    privacyConsentAt,
  });
  const statePath = path.join(userDataPaths("alice", env).oauth, "gmail-state.json");
  const savedState = JSON.parse(await fs.readFile(statePath, "utf8"));
  const scopes = new URL(started.authorizeUrl).searchParams.get("scope").split(/\s+/g);

  assert.deepEqual(started.capabilities, ["gmail_send"]);
  assert.deepEqual(savedState.requestedCapabilities, ["gmail_send"]);
  assert.equal(savedState.privacyPolicyVersion, "2026-07-23.2");
  assert.equal(savedState.privacyConsentAt, privacyConsentAt);
  assert.equal(scopes.includes("https://www.googleapis.com/auth/gmail.readonly"), false);
  assert.equal(scopes.includes("https://www.googleapis.com/auth/gmail.modify"), false);
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.send"));
  assert.equal(scopes.includes("https://www.googleapis.com/auth/gmail.compose"), false);
});

test("google workspace oauth blocks capabilities not approved for the production client", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-scope-lock-"));
  const env = await configureGoogle(home);
  const link = await createGoogleWorkspaceConnectLink({
    principal: userPrincipal({ id: "alice" }),
    thread: { id: "thread-1" },
  }, env);

  await assert.rejects(
    startGoogleWorkspaceOAuth(env, { connectId: link.connectId, capabilities: ["gmail_read"] }),
    (error) => error.code === "google_workspace_capability_not_approved" && error.statusCode === 403,
  );
});

test("brokered google workspace oauth provisions the Gmail grant to the tenant VM", async () => {
  const parentHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-broker-parent-"));
  const tenantHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-broker-tenant-"));
  const env = await configureGoogle(parentHome);
  env.ORKESTR_GOOGLE_OAUTH_ALLOWED_CAPABILITIES = "all";
  env.ORKESTR_CONNECT_PUBLIC_URL = "https://connect.crawlerai.de";
  env.ORKESTR_PUBLIC_AUTH_URL = "https://connect.orkestr.de/setup/pairing";
  env.GMAIL_OAUTH_REDIRECT_URI = "https://app.orkestr.de/oauth/gmail/callback";
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const registration = await registerBrokerInstance({
    env: {
      ...env,
      ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
    },
    request: {
      method: "POST",
      url: "/api/broker/instances/register",
      headers: { authorization: "Bearer register-secret" },
    },
    body: {
      encryptionPublicKey: client.publicKey,
      endpointBaseUrl: "https://tenant.example.test",
    },
  });
  await writeTenantBrokerClientRegistration(tenantHome, client, registration);

  const link = await createGoogleWorkspaceConnectLink({
    principal: userPrincipal({ id: "firat" }),
    thread: {
      id: "firat-jobs",
      binding: { chatId: "firat-wa", responderAccountId: "de-wa" },
    },
    brokerInstanceId: registration.instanceId,
    brokerTenantVmId: "firat-jobs-vm",
    brokerTenantUserId: "firat",
    brokerTenantThreadId: "firat-jobs",
    brokerTenantChatId: "firat-wa",
    brokerTenantAccountId: "de-wa",
    account: "firatkahya@gmail.com",
    alias: "firat-jobs",
    useMode: "explicit_only",
    setAsThreadDefault: true,
    brokerServerRequest: true,
  }, env);
  const connectorTarget = new URL(link.link);
  assert.equal(connectorTarget.origin, "https://connect.orkestr.de");
  assert.equal(connectorTarget.pathname, `/i/${registration.instanceId}/app/connectors/gmail`);
  assert.equal(connectorTarget.searchParams.get("provider"), "google_workspace");
  assert.equal(connectorTarget.searchParams.get("action"), "connect");
  assert.equal(connectorTarget.searchParams.get("instance_id"), registration.instanceId);
  assert.equal(connectorTarget.searchParams.get("user_id"), "firat");
  assert.equal(connectorTarget.searchParams.get("thread"), "firat-jobs");
  assert.equal(connectorTarget.searchParams.get("thread_id"), "firat-jobs");
  assert.equal(connectorTarget.searchParams.get("alias"), "firat-jobs");
  assert.equal(connectorTarget.searchParams.get("use_mode"), "explicit_only");
  assert.equal(connectorTarget.searchParams.get("set_as_thread_default"), "1");
  assert.equal(connectorTarget.searchParams.get("connect"), link.connectId);
  const connectTarget = new URL(link.connectLink);
  assert.equal(connectTarget.origin, "https://connect.orkestr.de");
  assert.equal(connectTarget.pathname, `/i/${registration.instanceId}/app/connectors/gmail`);
  assert.equal(connectTarget.searchParams.get("connect"), link.connectId);
  const started = await startGoogleWorkspaceOAuth(env, {
    connectId: link.connectId,
    capabilities: ["gmail_read"],
  });
  assert.equal(started.redirectUri, "https://app.orkestr.de/oauth/gmail/callback");
  assert.equal(new URL(started.authorizeUrl).searchParams.get("login_hint"), null);
  const savedState = JSON.parse(await fs.readFile(path.join(userDataPaths("firat", env).oauth, "gmail-state.json"), "utf8"));
  assert.equal(savedState.redirectUri, "https://app.orkestr.de/oauth/gmail/callback");
  assert.equal(savedState.account, "");
  assert.equal(savedState.connectionAlias, "firat-jobs");
  assert.equal(savedState.connectionUseMode, "explicit_only");
  assert.equal(savedState.setAsThreadDefault, true);
  const calls = [];
  const brokeredAccessToken = `ya29.${"c".repeat(90)}`;
  const result = await finishGmailOAuth(
    new URLSearchParams({ code: "broker-code", state: started.state }),
    env,
    async (url, options = {}) => {
      calls.push(String(url));
      if (String(url) === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(options.body);
        assert.equal(body.get("code"), "broker-code");
        assert.equal(body.get("redirect_uri"), "https://app.orkestr.de/oauth/gmail/callback");
        return jsonResponse({
          access_token: brokeredAccessToken,
          refresh_token: "brokered-refresh",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
        });
      }
      if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        return jsonResponse({ emailAddress: "FiratKahya@Gmail.com" });
      }
      assert.equal(String(url), "https://tenant.example.test/api/broker/google-workspace/grants");
      const decrypted = await decryptBrokerClientPayload(JSON.parse(options.body), { ORKESTR_HOME: tenantHome });
      assert.equal(decrypted.payload.userId, "firat");
      assert.equal(decrypted.payload.threadId, "firat-jobs");
      assert.equal(decrypted.payload.chatId, "firat-wa");
      assert.equal(decrypted.payload.account, "firatkahya@gmail.com");
      assert.equal(decrypted.payload.connectionAlias, "firat-jobs");
      assert.equal(decrypted.payload.connectionUseMode, "explicit_only");
      assert.equal(decrypted.payload.setAsThreadDefault, true);
      assert.equal(decrypted.payload.token.accessToken, brokeredAccessToken);
      assert.equal(decrypted.payload.token.refreshToken, "brokered-refresh");
      assert.equal(decrypted.payload.token.account, "firatkahya@gmail.com");
      assert.equal(decrypted.payload.token.email, "firatkahya@gmail.com");
      return jsonResponse({ ok: true, grant: { ok: true } });
    },
  );

  assert.equal(savedState.brokerInstanceId, registration.instanceId);
  assert.equal(savedState.brokerTenantVmId, "firat-jobs-vm");
  assert.equal(result.brokered, true);
  assert.equal(result.brokerInstanceId, registration.instanceId);
  assert.deepEqual(calls, [
    "https://oauth2.googleapis.com/token",
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    "https://tenant.example.test/api/broker/google-workspace/grants",
  ]);
  assert.deepEqual(await readGmailToken(env, { userId: "firat" }), {});
});

test("brokered google workspace callback target returns to the instance connector", () => {
  const href = googleWorkspaceBrokeredConnectorSetupHref({
    brokered: true,
    brokerInstanceId: "instance-firat",
    brokerTenantUserId: "firat",
    brokerTenantThreadName: "firat-jobs",
    oauthAppId: "otcan-claw",
  }, {
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.crawlerai.de",
    ORKESTR_PUBLIC_AUTH_URL: "https://connect.orkestr.de/setup/pairing",
  });
  const target = new URL(href);

  assert.equal(target.origin, "https://connect.orkestr.de");
  assert.equal(target.pathname, "/i/instance-firat/app/connectors/gmail");
  assert.equal(target.searchParams.get("mcp"), "tools/call");
  assert.equal(target.searchParams.get("tool"), "orkestr_auth");
  assert.equal(target.searchParams.get("service"), "gmail");
  assert.equal(target.searchParams.get("provider"), "google_workspace");
  assert.equal(target.searchParams.get("action"), "connect");
  assert.equal(target.searchParams.get("instance_id"), "instance-firat");
  assert.equal(target.searchParams.get("user_id"), "firat");
  assert.equal(target.searchParams.get("thread"), "firat-jobs");
  assert.equal(target.searchParams.get("oauth_app"), "otcan-claw");
  assert.equal(target.searchParams.get("auto"), "0");
  assert.doesNotMatch(href, /crawlerai|app\.orkestr\.de|\/setup\/gmail/);
});

test("tenant google workspace connect link is created by the parent broker", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-tenant-broker-link-"));
  const broker = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_VM_ID: "firat-jobs-vm",
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, options });
    if (parsed.pathname === "/api/broker/instances/register") {
      assert.equal(options.headers.authorization, "Bearer register-secret");
      return jsonResponse({
        ok: true,
        instanceId: "instance-firat",
        channelId: "channel-firat",
        registeredAt: "2026-07-04T00:00:00.000Z",
        broker: {
          keyId: "broker-key",
          publicKey: broker.publicKey,
        },
      });
    }
    assert.equal(parsed.pathname, "/api/broker/instances/instance-firat/google-workspace/connect-link");
    assert.ok(JSON.parse(options.body).envelope);
    return jsonResponse({
      ok: true,
      connectId: "parent-connect-id",
      link: "https://connect.example.test/connect/google?connect=parent-connect-id",
      expiresAt: "2026-07-04T01:00:00.000Z",
      message: "parent broker connect message",
    });
  };

  try {
    const link = await createGoogleWorkspaceConnectLink({
      principal: userPrincipal({ id: "firat" }),
      thread: {
        id: "firat-jobs",
        binding: { chatId: "firat-wa", responderAccountId: "de-wa" },
      },
      brokerInstanceId: "stale-instance-from-agent-memory",
    }, env);

    assert.equal(link.connectId, "parent-connect-id");
    assert.equal(link.message, "parent broker connect message");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.pathname, "/api/broker/instances/instance-firat/google-workspace/connect-link");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("google workspace connect rejects tenant broker metadata without broker routing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-local-broker-denied-"));
  const env = await configureGoogle(home);

  await assert.rejects(
    createGoogleWorkspaceConnectLink({
      principal: userPrincipal({ id: "eren" }),
      thread: {
        id: "eren-jobs-slice",
        binding: { chatId: "eren-wa", responderAccountId: "sender" },
      },
      brokerInstanceId: "stale-instance-from-agent-memory",
      brokerTenantVmId: "eren-jobs-slice",
      brokerTenantUserId: "eren",
      brokerTenantThreadId: "eren-jobs-slice",
      brokerTenantChatId: "eren-wa",
      brokerTenantAccountId: "sender",
    }, env),
    /broker_google_workspace_connect_requires_parent_broker/,
  );
  await assert.rejects(
    fs.access(path.join(home, "oauth", "google-workspace-connect.json")),
    /ENOENT/,
  );
});

test("google workspace callback stores only granted partial capabilities", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-partial-"));
  const env = await configureGoogle(home);
  env.ORKESTR_GOOGLE_OAUTH_ALLOWED_CAPABILITIES = "all";
  const alice = userPrincipal({ id: "alice" });
  const link = await createGoogleWorkspaceConnectLink({ principal: alice, thread: { id: "thread-1" } }, env);
  const started = await startGoogleWorkspaceOAuth(env, {
    connectId: link.connectId,
    capabilities: ["gmail_read", "gmail_actions", "gmail_send", "gmail_drafts", "calendar_read", "calendar_actions", "drive_file"],
  });

  const result = await finishGmailOAuth(
    new URLSearchParams({ code: "callback-code", state: started.state }),
    env,
    async () =>
      jsonResponse({
        access_token: "partial-access",
        refresh_token: "partial-refresh",
        expires_in: 3600,
        scope: [
          "openid",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar.events.readonly",
          "https://www.googleapis.com/auth/calendar.events",
        ].join(" "),
      }),
  );
  const token = await readGmailToken(env, { principal: alice });
  const status = await connectorAuthStatus("gmail", env, { principal: alice });

  assert.equal(result.provider, "google_workspace");
  assert.deepEqual(result.capabilities, ["gmail_read", "calendar_read", "calendar_actions"]);
  assert.deepEqual(token.capabilities, ["gmail_read", "calendar_read", "calendar_actions"]);
  assert.deepEqual(status.capabilities, ["gmail_read", "calendar_read", "calendar_actions"]);
});

test("gmail action and draft helpers build scoped Gmail requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-gmail-actions-"));
  const env = await configureGoogle(home);
  await storeToken(
    env,
    [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.compose",
    ].join(" "),
  );

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(String(url)), options });
    if (String(url).includes("/messages/m1/modify")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { addLabelIds: [], removeLabelIds: ["INBOX"] });
      return jsonResponse({ id: "m1", labelIds: [] });
    }
    if (String(url).includes("/drafts/send")) {
      assert.deepEqual(JSON.parse(options.body), { id: "draft-1" });
      return jsonResponse({ id: "sent-1" });
    }
    if (String(url).endsWith("/drafts")) {
      const body = JSON.parse(options.body);
      const raw = Buffer.from(body.message.raw, "base64url").toString("utf8");
      assert.match(raw, /^To: person@example\.com\r\nSubject: Hello\r\n/m);
      assert.match(raw, /Draft body/);
      return jsonResponse({ id: "draft-1" });
    }
    throw new Error(`unexpected_url:${url}`);
  };

  await modifyGmailMessage({ messageId: "m1", action: "archive" }, env, fetchImpl);
  await createGmailDraft({ to: "person@example.com", subject: "Hello", body: "Draft body" }, env, fetchImpl);
  await sendGmailDraft({ draftId: "draft-1" }, env, fetchImpl);

  assert.equal(calls[0].url.pathname, "/gmail/v1/users/me/messages/m1/modify");
  assert.equal(calls[1].url.pathname, "/gmail/v1/users/me/drafts");
  assert.equal(calls[2].url.pathname, "/gmail/v1/users/me/drafts/send");
});

test("calendar and drive helpers build scoped google workspace requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-workspace-calendar-drive-"));
  const env = await configureGoogle(home);
  await storeToken(
    env,
    [
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/drive.file",
    ].join(" "),
  );

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(String(url)), options });
    const parsed = new URL(String(url));
    if (parsed.pathname === "/calendar/v3/calendars/primary/events" && (!options.method || options.method === "GET")) {
      assert.equal(parsed.searchParams.get("timeMin"), "2026-06-04T00:00:00Z");
      assert.equal(parsed.searchParams.get("timeMax"), "2026-06-05T00:00:00Z");
      return jsonResponse({ items: [{ id: "event-1", summary: "Planning" }] });
    }
    if (parsed.pathname === "/calendar/v3/calendars/primary/events" && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(parsed.searchParams.get("sendUpdates"), "none");
      assert.equal(body.summary, "Demo");
      assert.deepEqual(body.start, { dateTime: "2026-06-04T12:00:00Z" });
      assert.deepEqual(body.end, { dateTime: "2026-06-04T12:30:00Z" });
      return jsonResponse({ id: "event-2", summary: "Demo" });
    }
    if (parsed.pathname === "/calendar/v3/calendars/primary/events/event-2" && options.method === "PATCH") {
      const body = JSON.parse(options.body);
      assert.equal(body.summary, "Updated demo");
      return jsonResponse({ id: "event-2", summary: "Updated demo" });
    }
    if (parsed.pathname === "/calendar/v3/calendars/primary/events/event-2" && options.method === "DELETE") {
      assert.equal(parsed.searchParams.get("sendUpdates"), "none");
      return jsonResponse({}, true, 204);
    }
    if (parsed.pathname === "/drive/v3/files/file-1" && !parsed.searchParams.get("alt")) {
      assert.equal(parsed.searchParams.get("fields"), "id,name,mimeType,size,modifiedTime,webViewLink");
      return jsonResponse({ id: "file-1", name: "Notes.txt", mimeType: "text/plain" });
    }
    if (parsed.pathname === "/drive/v3/files/file-1" && parsed.searchParams.get("alt") === "media") {
      return textResponse("Drive file contents");
    }
    throw new Error(`unexpected_url:${url}`);
  };

  const events = await listGoogleCalendarEvents({
    calendarId: "primary",
    timeMin: "2026-06-04T00:00:00Z",
    timeMax: "2026-06-05T00:00:00Z",
    maxResults: 5,
  }, env, fetchImpl);
  const created = await createGoogleCalendarEvent({
    calendarId: "primary",
    summary: "Demo",
    startDateTime: "2026-06-04T12:00:00Z",
    endDateTime: "2026-06-04T12:30:00Z",
    sendUpdates: "none",
  }, env, fetchImpl);
  const updated = await updateGoogleCalendarEvent({
    calendarId: "primary",
    eventId: "event-2",
    summary: "Updated demo",
  }, env, fetchImpl);
  const deleted = await deleteGoogleCalendarEvent({
    calendarId: "primary",
    eventId: "event-2",
    sendUpdates: "none",
  }, env, fetchImpl);
  const file = await getGoogleDriveFile({ fileId: "file-1", includeContent: true }, env, fetchImpl);

  assert.equal(events.events[0].id, "event-1");
  assert.equal(created.event.id, "event-2");
  assert.equal(updated.event.summary, "Updated demo");
  assert.equal(deleted.eventId, "event-2");
  assert.equal(file.file.name, "Notes.txt");
  assert.equal(file.content, "Drive file contents");
});

test("google workspace connect html shows MCP context and capability controls", () => {
  const html = googleWorkspaceConnectHtml({
    connectId: "connect-1",
    request: { account: "user@example.com", brokerInstanceId: "instance-firat", userId: "firat", threadName: "firat-jobs" },
    allowedCapabilities: "all",
  });
  assert.match(html, /Connect Google Workspace/);
  assert.match(html, /name="connect"/);
  assert.match(html, /Continue to Google/);
  assert.match(html, /orkestr_auth/);
  assert.match(html, /google_workspace/);
  assert.match(html, /instance-firat/);
  assert.match(html, /firat/);
  assert.match(html, /firat-jobs/);
  assert.doesNotMatch(html, /name="account"/);
  assert.doesNotMatch(html, /type="email"/);
  assert.match(html, /name="capability"/);
  assert.match(html, /Gmail send/);
  assert.match(html, /Gmail drafts/);
  assert.match(html, /Gmail read/);
  assert.match(html, /Drive selected files/);
  assert.match(html, /value="gmail_send" checked/);
  assert.doesNotMatch(html, /value="gmail_read" checked/);
  assert.match(html, /name="privacy_consent"/);
  assert.match(html, /privacy#google-data-protection/);
});

test("google workspace connect html exposes only the approved send capability by default", () => {
  const html = googleWorkspaceConnectHtml({ connectId: "connect-1" });
  assert.match(html, /Gmail send/);
  assert.doesNotMatch(html, /Gmail read/);
  assert.doesNotMatch(html, /Gmail drafts/);
  assert.doesNotMatch(html, /Drive selected files/);
  assert.match(html, /cannot read your inbox or existing email/);
});

test("google workspace connect html discloses every selected expanded capability", () => {
  const html = googleWorkspaceConnectHtml({
    connectId: "connect-1",
    allowedCapabilities: "all",
    selectedCapabilities: ["gmail_read", "gmail_drafts", "calendar_read", "calendar_actions"],
  });
  assert.match(html, /Selected permissions:/);
  assert.match(html, /For Gmail drafts/);
  assert.match(html, /For Gmail read/);
  assert.match(html, /For Calendar read/);
  assert.match(html, /For Calendar actions/);
  assert.doesNotMatch(html, /Current permission:/);
  assert.doesNotMatch(html, /cannot read your inbox or existing email/);
});

test("google workspace preview html does not expose the OAuth start form", () => {
  const html = googleWorkspaceConnectHtml({
    connectId: "connect-1",
    request: { account: "user@example.com", brokerInstanceId: "instance-firat", userId: "firat" },
    previewOnly: true,
  });
  assert.match(html, /Open this link in a browser/);
  assert.match(html, /orkestr_auth/);
  assert.match(html, /instance-firat/);
  assert.doesNotMatch(html, /action="\/connect\/google\/start"/);
});
