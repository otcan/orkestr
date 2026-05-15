import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  exchangeGmailCode,
  finishGmailOAuth,
  getGmailAccessToken,
  readGmailToken,
  refreshGmailAccessToken,
  startGmailOAuth,
} from "../packages/connectors/src/gmail.js";
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

