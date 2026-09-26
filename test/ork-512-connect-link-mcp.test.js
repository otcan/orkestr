import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callConnectorsMcpTool } from "../packages/connectors/src/connectors-mcp-client.js";
import { createGoogleWorkspaceConnectLink } from "../packages/connectors/src/google-workspace.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { approvePairingChallenge, pairBrowser, sessionCookieHeader } from "../packages/core/src/security.js";
import { userDataPaths } from "../packages/storage/src/paths.js";
import { createConnectorsMcpGateway } from "../scripts/orkestr-connectors-mcp.mjs";
import { fakeOAuthEnv, findFiles, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

// ORK-512: the CLI (`orkestr connect google` issues a one-time connect link)
// and orkestr_auth MCP (exact attended approval) start aliases.

async function connectLink(userId) {
  return createGoogleWorkspaceConnectLink({
    principal: userPrincipal({ id: userId, displayName: userId }),
    thread: { id: `${userId}-thread`, binding: { chatId: `${userId}-chat`, outboundAccountId: "sender" } },
  }, process.env);
}

// Opens the connect page anonymously (which creates the scoped pairing
// challenge), approves it as the CLI operator would, and returns the cookie.
async function pairForConnectLink(port, connectId) {
  const page = await rawRequest(port, { pathname: `/connect/google?connect=${encodeURIComponent(connectId)}` });
  assert.equal(page.status, 302, page.text);
  const challengeId = new URL(page.headers.location, "http://localhost").searchParams.get("challengeId");
  await approvePairingChallenge(challengeId, { env: process.env, approvedBy: "node:test" });
  const paired = await pairBrowser({ challengeId, env: process.env });
  return sessionCookieHeader(paired.token, process.env).split(";")[0];
}

test("CLI connect link: anonymous start writes nothing, the link starts OAuth once, and concurrent reuse fails", async () => {
  const fixture = await startFixtureServer();
  try {
    const link = await connectLink("firat");
    const startPath = `/connect/google/start?connect=${encodeURIComponent(link.connectId)}`;

    const anonymous = await rawRequest(fixture.port, { pathname: startPath });
    assert.equal(anonymous.status, 302);
    assert.equal(new URL(anonymous.headers.location, "http://localhost").pathname, "/setup/pairing");
    const noLink = await rawRequest(fixture.port, { pathname: "/connect/google/start" });
    assert.ok(noLink.status >= 400);
    assert.deepEqual(await findFiles(fixture.home, "gmail-state.json"), []);

    const cookie = await pairForConnectLink(fixture.port, link.connectId);
    const started = await rawRequest(fixture.port, { pathname: startPath, headers: { cookie } });
    assert.equal(started.status, 302, started.text);
    assert.match(started.headers.location, /^https:\/\/accounts\.google\.com\//);
    const stateFile = path.join(userDataPaths("firat", process.env).oauth, "gmail-state.json");
    const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(saved.connectId, link.connectId);

    const reused = await rawRequest(fixture.port, { pathname: startPath, headers: { cookie } });
    assert.equal(reused.status, 410);
    assert.match(reused.text, /google_workspace_connect_link_used/);
    assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).state, saved.state);

    const second = await connectLink("firat");
    const secondCookie = await pairForConnectLink(fixture.port, second.connectId);
    const secondPath = `/connect/google/start?connect=${encodeURIComponent(second.connectId)}`;
    const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
      rawRequest(fixture.port, { pathname: secondPath, headers: { cookie: secondCookie } })));
    assert.equal(concurrent.filter((response) => response.status === 302).length, 1);
    assert.equal(concurrent.filter((response) => response.status === 410).length, 3);
  } finally {
    await fixture.close();
  }
});

async function mcpFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ork512-mcp-"));
  const env = {
    ...process.env,
    ...fakeOAuthEnv,
    ORKESTR_HOME: home,
    ORKESTR_CONNECTORS_MCP_HOST: "127.0.0.1",
    ORKESTR_CONNECTORS_MCP_PORT: "0",
    ORKESTR_CONNECTORS_MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
    ORKESTR_CONNECTORS_MCP_TOKEN: "operator-token",
    ORKESTR_CONNECTORS_MCP_BEARER_TOKEN: "operator-token",
  };
  const gateway = createConnectorsMcpGateway({ env });
  const server = http.createServer(gateway.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  env.ORKESTR_CONNECTORS_MCP_URL = `http://127.0.0.1:${server.address().port}/mcp`;
  return {
    env,
    home,
    async close() {
      gateway.close();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

test("orkestr_auth MCP connect: no approval, replayed approval and concurrent reuse write no extra OAuth state", async () => {
  const item = await mcpFixture();
  try {
    const request = { service: "gmail", action: "connect", user_id: "admin", account_hint: "owner@example.test" };
    const pending = await callConnectorsMcpTool("orkestr_auth", request, item.env);
    assert.equal(pending.status, "approval_required");
    assert.deepEqual(await findFiles(item.home, "gmail-state.json"), []);

    const unapproved = await callConnectorsMcpTool("orkestr_auth", { ...request, approval: pending.challenge.approve_code }, item.env);
    assert.equal(unapproved.ok, false);
    assert.match(JSON.stringify(unapproved), /pairing_challenge_not_approved/);
    assert.deepEqual(await findFiles(item.home, "gmail-state.json"), []);

    await approvePairingChallenge(pending.challenge.approve_code, { env: item.env, approvedBy: "node:test" });
    const attempts = await Promise.all(Array.from({ length: 3 }, () =>
      callConnectorsMcpTool("orkestr_auth", { ...request, approval: pending.challenge.approve_code }, item.env)));
    const started = attempts.filter((result) => result.status === "ok");
    assert.equal(started.length, 1, JSON.stringify(attempts));
    assert.match(started[0].data.authorizeUrl, /^https:\/\/accounts\.google\.com\//);
    for (const result of attempts.filter((item) => item.status !== "ok")) {
      assert.match(JSON.stringify(result), /pairing_challenge_consumed/);
    }
    const [stateFile] = await findFiles(item.home, "gmail-state.json");
    const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(saved.state, new URL(started[0].data.authorizeUrl).searchParams.get("state"));

    const replay = await callConnectorsMcpTool("orkestr_auth", { ...request, approval: pending.challenge.approve_code }, item.env);
    assert.equal(replay.ok, false);
    assert.match(JSON.stringify(replay), /pairing_challenge_consumed/);
    assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).state, saved.state);
  } finally {
    await item.close();
  }
});
