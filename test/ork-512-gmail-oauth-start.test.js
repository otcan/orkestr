import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setGmailOAuthBrowserOpenerForTest } from "../dist/server/apps/server/src/modules/connectors/gmail-oauth-start-page.js";
import { createUser } from "../packages/core/src/users.js";
import { userDataPaths } from "../packages/storage/src/paths.js";
import {
  eventsOfType,
  findFiles,
  jsonPost,
  pairedCookie,
  rawRequest,
  startFixtureServer,
} from "./support/connector-security-fixture.js";

// ORK-512: every Gmail OAuth start alias, exercised through the real HTTP
// server, security middleware and controllers with fake OAuth configuration.

async function stateFiles(home) {
  return findFiles(home, "gmail-state.json");
}

test("anonymous requests to every OAuth start alias write no state, clear no error, open no browser and emit no start", async () => {
  const fixture = await startFixtureServer({ ORKESTR_GMAIL_AUTH_DESKTOP_SLUG: "gmail-auth-desk" });
  const opened = [];
  setGmailOAuthBrowserOpenerForTest(async (slug, url) => { opened.push({ slug, url }); return { label: slug }; });
  try {
    const errorFile = path.join(fixture.home, "secrets", "gmail-error.json");
    await fs.mkdir(path.dirname(errorFile), { recursive: true });
    await fs.writeFile(errorFile, JSON.stringify({ message: "prior failure" }));
    // A real intent exists; an anonymous caller that somehow learned it still cannot use it.
    const adminCookie = await pairedCookie();
    const leaked = await jsonPost(fixture.port, "/api/connectors/gmail/oauth/intent", {}, { cookie: adminCookie });
    assert.equal(leaked.status, 201, leaked.text);

    const attempts = [
      ["GET", "/oauth/gmail/start?account=victim%40example.test"],
      ["HEAD", "/oauth/gmail/start"],
      ["POST", "/oauth/gmail/start"],
      ["GET", "/api/connectors/gmail/oauth/start?account=victim%40example.test"],
      ["HEAD", "/api/connectors/gmail/oauth/start"],
      ["POST", "/api/connectors/gmail/oauth/start"],
      ["POST", "/api/connectors/gmail/oauth/intent"],
      ["POST", "/api/users/alice/connectors/gmail/oauth/intent"],
      ["POST", "/api/users/alice/connectors/gmail/oauth/start"],
      ["GET", "/google-marketing/oauth/start"],
    ];
    for (const [method, pathname] of attempts) {
      const body = method === "POST" ? { intentId: leaked.json.intentId, token: leaked.json.token, account: "victim@example.test" } : "";
      const response = await rawRequest(fixture.port, {
        method,
        pathname,
        headers: body ? { "content-type": "application/json", origin: fixture.origin } : {},
        body,
      });
      assert.ok([401, 404].includes(response.status), `${method} ${pathname} -> ${response.status} ${response.text}`);
    }

    assert.deepEqual(await stateFiles(fixture.home), []);
    assert.equal(JSON.parse(await fs.readFile(errorFile, "utf8")).message, "prior failure");
    assert.deepEqual(opened, []);
    assert.deepEqual((await eventsOfType("gmail_oauth_started")).concat(await eventsOfType("google_workspace_oauth_started")), []);
    // The leaked intent was never consumed by the anonymous attempts.
    const consumed = await jsonPost(fixture.port, "/api/connectors/gmail/oauth/start", {
      intentId: leaked.json.intentId,
      token: leaked.json.token,
    }, { cookie: adminCookie });
    assert.equal(consumed.status, 200, consumed.text);
  } finally {
    setGmailOAuthBrowserOpenerForTest(null);
    await fixture.close();
  }
});

test("connector onboarding: an intent starts OAuth once with its bound parameters", async () => {
  const fixture = await startFixtureServer();
  try {
    const cookie = await pairedCookie();
    const intent = await jsonPost(fixture.port, "/api/connectors/gmail/oauth/intent", {
      account: "Owner@Example.test",
      threadId: "thread-onboarding",
      useMode: "explicit_only",
    }, { cookie });
    assert.equal(intent.status, 201, intent.text);
    assert.ok(intent.json.expiresAt);

    const started = await jsonPost(fixture.port, "/api/connectors/gmail/oauth/start", {
      intentId: intent.json.intentId,
      token: intent.json.token,
    }, { cookie });
    assert.equal(started.status, 200, started.text);
    const authorizeUrl = new URL(started.json.authorizeUrl);
    assert.equal(authorizeUrl.origin, "https://accounts.google.com");
    assert.equal(authorizeUrl.searchParams.get("login_hint"), "owner@example.test");
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "https://connect.example.test/oauth/gmail/callback");
    const [stateFile] = await stateFiles(fixture.home);
    const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(saved.state, started.json.state);
    assert.equal(saved.threadId, "thread-onboarding");
    assert.equal(saved.connectionUseMode, "explicit_only");
    assert.equal(saved.initiatorUserId, "admin");
    assert.equal((await eventsOfType("google_workspace_oauth_started")).length, 1);

    // Replay of the consumed intent fails and leaves the pending state alone.
    const before = await fs.readFile(stateFile, "utf8");
    const replay = await jsonPost(fixture.port, "/api/connectors/gmail/oauth/start", {
      intentId: intent.json.intentId,
      token: intent.json.token,
    }, { cookie });
    assert.equal(replay.status, 403);
    assert.equal(replay.json.error, "connector_use_intent_replayed");
    assert.equal(await fs.readFile(stateFile, "utf8"), before);
    assert.equal((await eventsOfType("connector_use_intent_replayed")).length, 1);
  } finally {
    await fixture.close();
  }
});

test("intent substitution, wrong host, cross-site origin, another principal and expiry cannot start OAuth", async () => {
  const fixture = await startFixtureServer();
  try {
    const cookie = await pairedCookie();
    const otherAdminCookie = await pairedCookie({ userId: "ops-admin", role: "admin" });
    const mint = async (body = {}, headers = {}) => jsonPost(fixture.port, "/api/connectors/gmail/oauth/intent", body, { cookie, ...headers });
    const start = async (body, headers = {}) => jsonPost(fixture.port, "/api/connectors/gmail/oauth/start", body, { cookie, ...headers });

    const substituted = (await mint({ account: "owner@example.test" })).json;
    const substitution = await start({ ...substituted, account: "attacker@example.test" });
    assert.equal(substitution.status, 403);
    assert.equal(substitution.json.error, "connector_use_intent_binding_mismatch");
    // The tampered intent is burned, even for its legitimate parameters.
    assert.equal((await start({ intentId: substituted.intentId, token: substituted.token })).json.error, "connector_use_intent_replayed");

    const hostBound = (await mint()).json;
    const wrongHost = await start(hostBound, { host: "attacker.example.test" });
    assert.equal(wrongHost.status, 403);
    assert.equal(wrongHost.json.error, "origin_not_allowed");
    const wrongHostSameOrigin = await start(hostBound, { host: "attacker.example.test", origin: "http://attacker.example.test" });
    assert.equal(wrongHostSameOrigin.status, 403);
    assert.equal(wrongHostSameOrigin.json.error, "connector_use_intent_host_mismatch");

    const crossSite = await mint({}, { origin: "https://attacker.example.test" });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.json.error, "origin_not_allowed");
    const fetchMetadata = await mint({}, { origin: "", "sec-fetch-site": "cross-site" });
    assert.equal(fetchMetadata.status, 403);

    const adminIntent = (await mint()).json;
    const otherPrincipal = await start(adminIntent, { cookie: otherAdminCookie });
    assert.equal(otherPrincipal.status, 401, otherPrincipal.text);
    assert.equal(otherPrincipal.json.error, "connector_use_intent_not_found");

    process.env.ORKESTR_CONNECTOR_INTENT_TTL_MS = "1000";
    const shortLived = (await mint()).json;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const expired = await start(shortLived);
    assert.equal(expired.status, 401);
    assert.equal(expired.json.error, "connector_use_intent_expired");

    assert.deepEqual(await stateFiles(fixture.home), []);
    const rejections = (await eventsOfType("connector_use_intent_rejected")).map((event) => event.reason).sort();
    assert.deepEqual(rejections, ["binding_mismatch", "expired", "host_mismatch", "not_found"]);
  } finally {
    await fixture.close();
  }
});

test("OAuth starts are rate limited per principal with durable counters", async () => {
  const fixture = await startFixtureServer({ ORKESTR_GMAIL_OAUTH_START_RATE_LIMIT: "2" });
  try {
    const cookie = await pairedCookie();
    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      const intent = (await jsonPost(fixture.port, "/api/connectors/gmail/oauth/intent", {}, { cookie })).json;
      const started = await jsonPost(fixture.port, "/api/connectors/gmail/oauth/start", intent, { cookie });
      statuses.push(started.status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    const stored = await findFiles(fixture.home, "gmail-oauth-start.json");
    assert.equal(stored.length, 1);
    assert.equal((await fs.readFile(stored[0], "utf8")).includes("admin"), false, "rate-limit keys are hashed");
  } finally {
    await fixture.close();
  }
});

test("legacy /oauth/gmail/start renders a form; only the POST gesture starts OAuth and opens the browser stub", async () => {
  const fixture = await startFixtureServer({ ORKESTR_GMAIL_AUTH_DESKTOP_SLUG: "gmail-auth-desk" });
  const opened = [];
  setGmailOAuthBrowserOpenerForTest(async (slug, url) => { opened.push({ slug, url }); return { label: "Stub desk" }; });
  try {
    const cookie = await pairedCookie();
    const head = await rawRequest(fixture.port, { method: "HEAD", pathname: "/oauth/gmail/start", headers: { cookie } });
    assert.equal(head.status, 200);
    const page = await rawRequest(fixture.port, { pathname: "/oauth/gmail/start?account=owner%40example.test", headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.text, /<form method="post" action="\/oauth\/gmail\/start">/);
    assert.deepEqual(await stateFiles(fixture.home), []);
    assert.deepEqual(opened, []);
    assert.equal((await eventsOfType("connector_use_intent_created")).length, 1, "HEAD does not mint an intent");

    const field = (name) => page.text.match(new RegExp(`name="${name}" value="([^"]*)"`))[1];
    const form = new URLSearchParams({ intentId: field("intentId"), token: field("token"), account: field("account") }).toString();
    const post = (headers = {}) => rawRequest(fixture.port, {
      method: "POST",
      pathname: "/oauth/gmail/start",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: fixture.origin, ...headers },
      body: form,
    });
    const crossSite = await post({ origin: "https://attacker.example.test" });
    assert.equal(crossSite.status, 403);
    assert.deepEqual(opened, []);

    const submitted = await post();
    assert.equal(submitted.status, 200, submitted.text);
    assert.match(submitted.text, /Gmail auth opened/);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].slug, "gmail-auth-desk");
    assert.match(opened[0].url, /^https:\/\/accounts\.google\.com\//);
    assert.equal(new URL(opened[0].url).searchParams.get("login_hint"), "owner@example.test");
    assert.equal((await stateFiles(fixture.home)).length, 1);

    const replay = await post();
    assert.equal(replay.status, 403);
    assert.equal(opened.length, 1);

    const aliceCookie = await pairedCookie({ userId: "alice", role: "user" });
    const nonAdmin = await rawRequest(fixture.port, { pathname: "/oauth/gmail/start", headers: { cookie: aliceCookie } });
    assert.equal(nonAdmin.status, 401);
  } finally {
    setGmailOAuthBrowserOpenerForTest(null);
    await fixture.close();
  }
});

test("admin user OAuth alias binds the target user, account and initiator", async () => {
  const fixture = await startFixtureServer();
  try {
    await createUser({ id: "alice", displayName: "Alice", email: "alice@example.test", phone: "+15550100001" }, process.env);
    await createUser({ id: "bob", displayName: "Bob", email: "bob@example.test", phone: "+15550100002" }, process.env);
    const cookie = await pairedCookie();
    const aliceCookie = await pairedCookie({ userId: "alice", role: "user" });
    const denied = await jsonPost(fixture.port, "/api/users/alice/connectors/gmail/oauth/intent", {}, { cookie: aliceCookie });
    assert.equal(denied.status, 403);

    const intent = (await jsonPost(fixture.port, "/api/users/alice/connectors/gmail/oauth/intent", { account: "alice@example.test" }, { cookie })).json;
    const wrongUser = await jsonPost(fixture.port, "/api/users/bob/connectors/gmail/oauth/start", intent, { cookie });
    assert.equal(wrongUser.status, 403);
    assert.equal(wrongUser.json.error, "connector_use_intent_subject_mismatch");

    const second = (await jsonPost(fixture.port, "/api/users/alice/connectors/gmail/oauth/intent", { account: "alice@example.test" }, { cookie })).json;
    const substituted = await jsonPost(fixture.port, "/api/users/alice/connectors/gmail/oauth/start", { ...second, account: "attacker@example.test" }, { cookie });
    assert.equal(substituted.status, 403);
    assert.deepEqual(await stateFiles(fixture.home), []);

    const third = (await jsonPost(fixture.port, "/api/users/alice/connectors/gmail/oauth/intent", { account: "alice@example.test" }, { cookie })).json;
    const started = await jsonPost(fixture.port, "/api/users/alice/connectors/gmail/oauth/start", third, { cookie });
    assert.equal(started.status, 200, started.text);
    const saved = JSON.parse(await fs.readFile(path.join(userDataPaths("alice", process.env).oauth, "gmail-state.json"), "utf8"));
    assert.equal(saved.userId, "alice");
    assert.equal(saved.initiatorUserId, "admin");
    assert.equal(saved.account, "alice@example.test");
  } finally {
    await fixture.close();
  }
});
