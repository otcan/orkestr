import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getConnectorStatuses } from "../packages/connectors/src/connectors.js";
import { startGmailOAuth } from "../packages/connectors/src/gmail.js";
import {
  parentConnectorAppStatus,
  parentConnectorProvider,
  parentConnectorProviderDefinitions,
  parentConnectorRuntimeConfig,
} from "../packages/connectors/src/parent-connector-apps.js";
import { getWhatsAppStatus } from "../packages/connectors/src/whatsapp.js";

function isolatedExternalWhatsAppEnv(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    WHATSAPP_BRIDGE_MODE: "external",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ...extra,
  };
}

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("parent connector registry includes WhatsApp as a parent bridge", () => {
  const whatsapp = parentConnectorProvider("whatsapp");
  const status = parentConnectorAppStatus({
    provider: "whatsapp",
    runtimeStatus: { mode: "local", state: "paired" },
  });

  assert.equal(whatsapp.authMode, "parent_bridge");
  assert.equal(whatsapp.userBindingKind, "chat_binding");
  assert.equal(status.parentManaged, true);
  assert.equal(status.parentAppConfigured, true);
  assert.equal(status.userSurface, "chat");
});

test("external WhatsApp bridge status hides parent bridge internals", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-parent-wa-status-"));
  const env = isolatedExternalWhatsAppEnv(home, {
    WHATSAPP_BRIDGE_URL: "http://wa.local",
    WHATSAPP_BRIDGE_TOKEN: "bridge-secret",
  });
  const status = await getWhatsAppStatus(env, async (url, options = {}) => {
    assert.equal(String(options.headers?.authorization || ""), "Bearer bridge-secret");
    if (String(url).endsWith("/health")) {
      return response({
        ok: true,
        mode: "local",
        state: "ready",
        ready: true,
        clientReady: true,
        accounts: [{
          accountId: "sender",
          label: "sender",
          state: "idle",
          ready: true,
          authenticated: true,
          sessionRoot: "/home/openclaw/.orkestr-production/whatsapp-bridge/sessions/session-codex-whatsapp",
          clientId: "codex-whatsapp",
          token: "must-not-leak",
        }],
      });
    }
    throw new Error(`unexpected_url:${url}`);
  });
  const serialized = JSON.stringify(status);

  assert.equal(status.state, "paired");
  assert.equal(status.accounts[0].accountId, "sender");
  assert.equal(status.accounts[0].ready, true);
  assert.doesNotMatch(serialized, /sessionRoot|orkestr-production|clientId|must-not-leak|bridge-secret/);
});

test("parent connector statuses do not expose secrets", () => {
  const status = parentConnectorAppStatus({
    provider: "gmail",
    config: {
      clientId: "gmail-client",
      clientSecret: "gmail-secret-value",
      redirectUri: "https://example.test/oauth/gmail/callback",
    },
  });

  assert.equal(status.parentAppConfigured, true);
  assert.equal(JSON.stringify(status).includes("gmail-secret-value"), false);
  assert.deepEqual(status.missingParentConfigKeys, []);
});

test("parent connector registry models missing and partial OAuth app config", () => {
  const gmail = parentConnectorAppStatus({
    provider: "gmail",
    config: {
      clientId: "gmail-client",
      redirectUri: "https://example.test/oauth/gmail/callback",
    },
  });
  const definitions = parentConnectorProviderDefinitions();

  assert.equal(gmail.parentAppConfigured, false);
  assert.equal(gmail.parentAppPartiallyConfigured, true);
  assert.deepEqual(gmail.missingParentConfigKeys, ["clientSecret"]);
  assert.ok(definitions.find((definition) => definition.provider === "jira"));
  assert.ok(definitions.find((definition) => definition.provider === "shopify"));
});

test("gmail OAuth start uses parent app config from service env", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-parent-gmail-env-"));
  const env = isolatedExternalWhatsAppEnv(home, {
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
  });

  const started = await startGmailOAuth(env, { account: "person@example.com" });
  const savedState = JSON.parse(await fs.readFile(path.join(home, "oauth", "gmail-state.json"), "utf8"));
  const authorizeUrl = new URL(started.authorizeUrl);

  assert.equal(authorizeUrl.searchParams.get("client_id"), "gmail-client-env");
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "https://example.test/oauth/gmail/callback");
  assert.equal(authorizeUrl.searchParams.get("login_hint"), "person@example.com");
  assert.equal(savedState.account, "person@example.com");
});

test("gmail OAuth derives redirect URI from public Orkestr URL when unset", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-parent-gmail-public-url-"));
  const env = isolatedExternalWhatsAppEnv(home, {
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    ORKESTR_PUBLIC_HTTPS_URL: "https://orkestr.example.test/",
  });

  const started = await startGmailOAuth(env);
  const authorizeUrl = new URL(started.authorizeUrl);

  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "https://orkestr.example.test/oauth/gmail/callback");
});

test("OAuth public broker base overrides stale persisted connector redirects", () => {
  const runtime = parentConnectorRuntimeConfig("gmail", {
    clientId: "gmail-client",
    clientSecret: "gmail-secret",
    redirectUri: "https://private.example.test/oauth/gmail/callback",
  }, {
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.example.com/",
  });

  assert.equal(runtime.redirectUri, "https://connect.example.com/oauth/gmail/callback");
});

test("provider-specific OAuth redirect env wins over the public broker base", () => {
  const runtime = parentConnectorRuntimeConfig("gmail", {
    clientId: "gmail-client",
    clientSecret: "gmail-secret",
    redirectUri: "https://private.example.test/oauth/gmail/callback",
  }, {
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.example.com/",
    GMAIL_OAUTH_REDIRECT_URI: "https://gmail.example.test/oauth/gmail/callback",
  });

  assert.equal(runtime.redirectUri, "https://gmail.example.test/oauth/gmail/callback");
});

test("setup connector statuses expose parent-managed connector metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-parent-connector-status-"));
  const env = isolatedExternalWhatsAppEnv(home, {
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
    MICROSOFT_OAUTH_CLIENT_ID: "microsoft-client-env",
  });

  const statuses = await getConnectorStatuses({ env, home });
  const byId = Object.fromEntries(statuses.map((connector) => [connector.id, connector]));

  assert.equal(byId.whatsapp.details.parentConnector.authMode, "parent_bridge");
  assert.equal(byId.whatsapp.details.parentConnector.parentManaged, true);
  assert.equal(byId.gmail.state, "partial");
  assert.equal(byId.gmail.details.parentConnector.parentAppConfigured, true);
  assert.equal(byId.outlook.details.parentConnector.parentAppConfigured, true);
  assert.equal(byId.jira.details.parentConnector.parentManaged, true);
  assert.equal(byId.shopify.details.parentConnector.parentManaged, true);
});
