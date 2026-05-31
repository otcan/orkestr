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
  startGmailOAuth,
} from "../packages/connectors/src/gmail.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { getSetupStatus } from "../packages/core/src/setup.js";
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
        scope: "gmail",
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
