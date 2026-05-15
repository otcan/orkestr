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
import { getSetupStatus } from "../packages/core/src/setup.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

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

  const started = await startGmailOAuth(env);
  const state = JSON.parse(await fs.readFile(path.join(home, "oauth", "gmail-state.json"), "utf8"));
  const url = new URL(started.authorizeUrl);

  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("state"), state.state);
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
