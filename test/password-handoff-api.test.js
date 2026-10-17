import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createThread } from "../packages/core/src/threads.js";
import { desktopPasswordBlind } from "../packages/core/src/password-handoff.js";
import { issueVaultThreadToken } from "../packages/core/src/vault-thread-tokens.js";
import { pairedCookie, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

// Password handoff HTTP routes: who may start, read and end a handoff.
// Synthetic only: no desktop exists, so probes report the desktop unavailable.

const CLI_TOKEN = "synthetic-cli-token-for-password-handoff-tests";

function call(port, method, pathname, { cookie, bearer, threadToken, body, origin = true } = {}) {
  const headers = origin ? { origin: `http://127.0.0.1:${port}` } : {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (threadToken) headers["x-orkestr-thread-token"] = threadToken;
  if (body !== undefined) headers["content-type"] = "application/json";
  return rawRequest(port, { method, pathname, headers, body: body === undefined ? "" : body });
}

async function seedOpenHandoff(home, record) {
  await fs.writeFile(path.join(home, "password-handoffs.json"), JSON.stringify({ handoffs: [{
    targetId: "t", origin: "https://signup.example.test", selector: "", state: "open",
    startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), ...record,
  }] }));
}

test("password handoff API: owner-only start/read/end, bound-thread status, agents refused", async (t) => {
  const server = await startFixtureServer({ ORKESTR_HOST_BOUNDARIES: "0", ORKESTR_CLI_AUTH_TOKEN: CLI_TOKEN });
  t.after(async () => {
    delete process.env.ORKESTR_CLI_AUTH_TOKEN;
    await server.close();
  });
  const { port, home } = server;
  await createThread({ id: "pw-thread", name: "Signup worker", ownerUserId: "alice" }, process.env);
  await createThread({ id: "pw-other", name: "Other worker", ownerUserId: "alice" }, process.env);
  const threadToken = await issueVaultThreadToken({ threadId: "pw-thread" }, process.env);
  const otherToken = await issueVaultThreadToken({ threadId: "pw-other" }, process.env);
  const alice = await pairedCookie({ userId: "alice", role: "user" });
  const bob = await pairedCookie({ userId: "bob", role: "user" });
  const start = { desktop: "pw-desk", threadId: "pw-thread", targetId: "t", origin: "https://signup.example.test" };

  const agentStart = await call(port, "POST", "/api/vault/password-handoffs", { bearer: CLI_TOKEN, body: start });
  assert.equal(agentStart.status, 403, "the agent CLI cannot start a handoff");
  assert.match(agentStart.text, /vault_owner_session_required/);
  assert.equal((await call(port, "POST", "/api/vault/password-handoffs", { cookie: alice, body: start, origin: false })).status, 403, "cross-origin start refused");
  const noLease = await call(port, "POST", "/api/vault/password-handoffs", { cookie: alice, body: start });
  assert.equal(noLease.status, 403, noLease.text);
  assert.match(noLease.text, /desktop_lease_required/, "the owner reaches the lease check");
  assert.equal((await call(port, "GET", "/api/vault/password-handoffs/targets?desktop=pw-desk", { cookie: alice })).status, 404);

  await seedOpenHandoff(home, { id: "pwh_api", ownerUserId: "alice", threadId: "pw-thread", desktopSlug: "pw-desk" });
  const listed = await call(port, "GET", "/api/vault/password-handoffs?desktop=pw-desk", { cookie: alice });
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.json.handoffs.map((item) => item.id), ["pwh_api"]);
  assert.deepEqual((await call(port, "GET", "/api/vault/password-handoffs", { cookie: bob })).json.handoffs, [], "other users see nothing");
  assert.equal((await call(port, "GET", "/api/vault/password-handoffs/pwh_api", { cookie: bob })).status, 404);
  assert.equal((await call(port, "GET", "/api/vault/password-handoffs", { bearer: CLI_TOKEN })).status, 403);

  const ownerStatus = await call(port, "GET", "/api/vault/password-handoffs/pwh_api", { cookie: alice });
  assert.equal(ownerStatus.status, 200, ownerStatus.text);
  assert.deepEqual([ownerStatus.json.status, ownerStatus.json.reason], ["unknown", "desktop_unavailable"]);
  const agentStatus = await call(port, "GET", "/api/vault/agent/password-handoffs/pwh_api", { bearer: CLI_TOKEN, threadToken });
  assert.equal(agentStatus.status, 200, agentStatus.text);
  assert.equal(agentStatus.json.status, "unknown");
  assert.equal((await call(port, "GET", "/api/vault/agent/password-handoffs/pwh_api", { bearer: CLI_TOKEN, threadToken: otherToken })).status, 404, "only the bound thread");
  assert.equal((await call(port, "GET", "/api/vault/agent/password-handoffs/pwh_api", { cookie: alice })).status, 403, "the agent route needs the CLI credential");

  assert.equal((await call(port, "POST", "/api/vault/password-handoffs/pwh_api/end", { bearer: CLI_TOKEN, body: {} })).status, 403, "agents cannot unblind");
  assert.equal((await call(port, "POST", "/api/vault/password-handoffs/pwh_api/end", { cookie: alice, body: { reason: "free text" } })).status, 400);
  assert.equal(await desktopPasswordBlind("pw-desk", process.env), true);
  const ended = await call(port, "POST", "/api/vault/password-handoffs/pwh_api/end", { cookie: alice, body: { reason: "signup_abandoned" } });
  assert.equal(ended.status, 200, ended.text);
  assert.equal(ended.json.state, "ended");
  assert.equal(await desktopPasswordBlind("pw-desk", process.env), false);
});
