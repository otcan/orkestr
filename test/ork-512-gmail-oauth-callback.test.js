import assert from "node:assert/strict";
import test from "node:test";
import { readGmailToken } from "../packages/connectors/src/gmail.js";
import { eventsOfType, jsonPost, pairedCookie, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

// ORK-512: OAuth callbacks complete only the authorization their start created.
// Google is faked at the fetch boundary; no real account or token is used.

const callbackHost = "connect.example.test";
let exchanges = 0;

function installFakeGoogle() {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://oauth2.googleapis.com/token") {
      exchanges += 1;
      return new Response(JSON.stringify({
        access_token: `fake-access-${exchanges}`,
        refresh_token: `fake-refresh-${exchanges}`,
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.send",
      }), { headers: { "content-type": "application/json" } });
    }
    if (target.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/profile")) {
      return new Response(JSON.stringify({ emailAddress: "owner@example.test" }), { headers: { "content-type": "application/json" } });
    }
    if (target.startsWith("https://www.googleapis.com/oauth2/")) {
      return new Response(JSON.stringify({ email: "owner@example.test", email_verified: true }), { headers: { "content-type": "application/json" } });
    }
    return nativeFetch(url, options);
  };
  return () => { globalThis.fetch = nativeFetch; };
}

async function startOAuth(port, cookie) {
  const intent = (await jsonPost(port, "/api/connectors/gmail/oauth/intent", {}, { cookie })).json;
  const started = await jsonPost(port, "/api/connectors/gmail/oauth/start", intent, { cookie });
  assert.equal(started.status, 200, started.text);
  return started.json.state;
}

function callback(port, { state, code = "fake-code", host = callbackHost, cookie = "" } = {}) {
  const query = new URLSearchParams({ code });
  if (state !== undefined) query.set("state", state);
  return rawRequest(port, {
    pathname: `/oauth/gmail/callback?${query}`,
    headers: { host, ...(cookie ? { cookie } : {}) },
  });
}

async function storedAccessToken() {
  return (await readGmailToken(process.env).catch(() => ({}))).accessToken || "";
}

test("callbacks reject absent, replaced, wrong-host, wrong-principal, replayed and expired state without touching credentials", async () => {
  const fixture = await startFixtureServer();
  const restoreFetch = installFakeGoogle();
  exchanges = 0;
  try {
    const cookie = await pairedCookie();
    const otherAdmin = await pairedCookie({ userId: "ops-admin", role: "admin" });

    const replacedState = await startOAuth(fixture.port, cookie);
    const currentState = await startOAuth(fixture.port, cookie);

    const absent = await callback(fixture.port, { state: undefined });
    assert.equal(absent.status, 400);
    assert.match(absent.text, /gmail_oauth_state_required/);

    const replaced = await callback(fixture.port, { state: replacedState });
    assert.equal(replaced.status, 400);
    assert.match(replaced.text, /gmail_oauth_state_mismatch/);

    const wrongHost = await callback(fixture.port, { state: currentState, host: "attacker.example.test" });
    assert.equal(wrongHost.status, 400);
    assert.match(wrongHost.text, /gmail_oauth_state_wrong_host/);

    const wrongPrincipal = await callback(fixture.port, { state: currentState, cookie: otherAdmin });
    assert.equal(wrongPrincipal.status, 403);
    assert.match(wrongPrincipal.text, /gmail_oauth_state_wrong_principal/);

    assert.equal(exchanges, 0, "no rejected callback reaches the token endpoint");
    assert.equal(await storedAccessToken(), "");

    // The pending authorization survives the rejected attempts; the real
    // browser (anonymous on the connect host) completes it once.
    const completed = await callback(fixture.port, { state: currentState });
    assert.equal(completed.status, 200, completed.text);
    assert.equal(exchanges, 1);
    assert.equal(await storedAccessToken(), "fake-access-1");

    const replay = await callback(fixture.port, { state: currentState, code: "second-code" });
    assert.equal(replay.status, 400);
    assert.match(replay.text, /gmail_oauth_state_replayed/);
    assert.equal(exchanges, 1);
    assert.equal(await storedAccessToken(), "fake-access-1");

    process.env.ORKESTR_GMAIL_OAUTH_STATE_TTL_MS = "1000";
    const staleState = await startOAuth(fixture.port, cookie);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const expired = await callback(fixture.port, { state: staleState });
    assert.equal(expired.status, 400);
    assert.match(expired.text, /gmail_oauth_state_expired/);
    assert.equal(exchanges, 1);
    assert.equal(await storedAccessToken(), "fake-access-1");

    const reasons = (await eventsOfType("gmail_oauth_callback_rejected")).map((event) => event.reason).sort();
    assert.deepEqual(reasons, [
      "gmail_oauth_state_expired",
      "gmail_oauth_state_mismatch",
      "gmail_oauth_state_replayed",
      "gmail_oauth_state_required",
      "gmail_oauth_state_wrong_host",
      "gmail_oauth_state_wrong_principal",
    ]);
  } finally {
    restoreFetch();
    await fixture.close();
  }
});

test("the initiating signed-in principal may complete its own callback", async () => {
  const fixture = await startFixtureServer();
  const restoreFetch = installFakeGoogle();
  exchanges = 0;
  try {
    const cookie = await pairedCookie();
    const state = await startOAuth(fixture.port, cookie);
    const completed = await callback(fixture.port, { state, cookie });
    assert.equal(completed.status, 200, completed.text);
    assert.equal(await storedAccessToken(), "fake-access-1");
  } finally {
    restoreFetch();
    await fixture.close();
  }
});
