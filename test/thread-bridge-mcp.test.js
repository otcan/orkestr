import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { appendThreadMessage, createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { createUser } from "../packages/core/src/users.js";
import { messageActor } from "../packages/core/src/thread-bridge.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";
import { DatabaseSync } from "node:sqlite";

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const envKeys = ["ORKESTR_HOME", "ORKESTR_ADMIN_USER_ID", "ORKESTR_AUTH_REQUIRED", "ORKESTR_HOST_BOUNDARIES", "ORKESTR_AUTO_RUN_THREAD_INPUT",
  "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_WHATSAPP_AUTOSTART", "WHATSAPP_LOCAL_AUTOSTART", "ORKESTR_THREAD_BRIDGE_ENABLED",
  "ORKESTR_THREAD_STORE", "ORKESTR_THREAD_MESSAGE_STORE", "ORKESTR_MCP_PUBLIC_URL", "ORKESTR_PROVIDER_QUOTA_PROJECTION_CONFIG", "ORKESTR_PROVIDER_QUOTA_CACHE_MS",
  "ORKESTR_WHATSAPP_INCOMING_SOURCES"];

test("messageActor never presents machine input as the owner's instruction", () => {
  assert.deepEqual(messageActor({ role: "user", source: "whatsapp_inbound" }), { kind: "human" });
  assert.deepEqual(messageActor({ role: "user", source: "ui" }), { kind: "human" });
  for (const source of ["timer_due", "thread_watch", "worker_assignment", "mailbox_route", "cli", "orkestr_task_agent_result", ""]) {
    assert.equal(messageActor({ role: "user", source }).kind, "automation", source);
  }
  assert.deepEqual(messageActor({ role: "assistant", source: "claude-code" }), { kind: "assistant" });
  assert.deepEqual(messageActor({ role: "assistant", source: "thread_bridge_agent", bridgeAgentId: "a" }), { kind: "delegated-agent", agentId: "a" });
});

async function startBridgeServer(t, enabled = "1") {
  const { startServer } = await import("../apps/server/src/server.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-bridge-mcp-"));
  const prior = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_AUTH_REQUIRED: "0", ORKESTR_HOST_BOUNDARIES: "0",
    ORKESTR_AUTO_RUN_THREAD_INPUT: "0", ORKESTR_RECOVER_RUNNING_ON_START: "0", ORKESTR_WHATSAPP_AUTOSTART: "0", WHATSAPP_LOCAL_AUTOSTART: "0",
    ORKESTR_THREAD_BRIDGE_ENABLED: enabled, ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite",
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.ORKESTR_MCP_PUBLIC_URL = base;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeThreadMessageRegistryCache();
    for (const [key, value] of prior) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
  });
  return { base, home };
}

async function connect(base) {
  const registration = await (await fetch(`${base}/mcp-oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  })).json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", state: "xyz", resource: `${base}/mcp`, scope: "threads:read threads:comment" });
  const page = await (await fetch(`${base}/mcp-oauth/authorize?${query}`)).text();
  assert.match(page, /all your threads/);
  assert.match(page, /Codex and Claude quota readings/);
  const consentId = /name="consent_id" value="([^"]+)"/.exec(page)[1];
  const decision = await fetch(`${base}/mcp-oauth/authorize`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: "null", "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ consent_id: consentId, decision: "approve" }),
  });
  assert.equal(decision.status, 302);
  const location = new URL(decision.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get("state"), "xyz");
  assert.equal(location.searchParams.get("iss"), base);
  const tokenResponse = await fetch(`${base}/mcp-oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code"), redirect_uri: REDIRECT,
      client_id: registration.client_id, code_verifier: verifier, resource: `${base}/mcp` }),
  });
  assert.equal(tokenResponse.status, 200);
  return { registration, tokens: await tokenResponse.json(), verifier, page };
}

test("thread MCP rejects oversized JSON before authentication or tool execution", async (t) => {
  const { base } = await startBridgeServer(t);
  const response = await fetch(`${base}/mcp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { padding: "x".repeat(101 * 1024) } }),
  });
  assert.equal(response.status, 413);
});

test("ChatGPT-style OAuth connection reads all threads and comments through MCP", async (t) => {
  const { base } = await startBridgeServer(t);
  await createUser({ id: "admin" }, process.env).catch(() => null);
  await createThread({ id: "thread-one", ownerUserId: "admin", name: "Sales" }, process.env);
  await createThread({ id: "thread-two", ownerUserId: "admin", name: "Jobs" }, process.env);
  await appendThreadMessage("thread-one", { role: "user", source: "whatsapp_inbound", text: "Please draft the offer", state: "completed" }, process.env);
  await appendThreadMessage("thread-one", { role: "user", source: "timer_due", text: "Daily check", state: "completed" }, process.env);
  await appendThreadMessage("thread-one", { role: "assistant", source: "claude-code", phase: "final_answer", state: "completed", text: "Offer drafted." }, process.env);

  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, `${base}/mcp`);
  assert.deepEqual(metadata.authorization_servers, [base]);
  assert.equal((await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()).registration_endpoint, `${base}/mcp-oauth/register`);
  const anonymous = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate"), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
  const badRedirect = await fetch(`${base}/mcp-oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }) });
  assert.equal(badRedirect.status, 400);

  const { registration, tokens, page: consent } = await connect(base);
  assert.doesNotMatch(consent, /WhatsApp messages/, "nothing to consent to while no WhatsApp account is enrolled");
  const client = new Client({ name: "test-dot", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["comment_on_thread", "get_provider_quotas", "get_thread_status", "list_incoming_whatsapp_messages", "list_threads", "read_changes", "read_thread", "send_message", "wait_for_reply"]);

  const listed = (await client.callTool({ name: "list_threads", arguments: {} })).structuredContent;
  assert.deepEqual(listed.threads.map((thread) => thread.name).sort(), ["Jobs", "Sales"]);
  const read = (await client.callTool({ name: "read_thread", arguments: { thread_id: "thread-one" } })).structuredContent;
  assert.deepEqual(read.messages.map((message) => message.actor.kind), ["human", "automation", "assistant"]);

  const comment = await client.callTool({ name: "comment_on_thread", arguments: { thread_id: "thread-two", text: "Two new job leads match." } });
  assert.equal(comment.isError, undefined, JSON.stringify(comment.content));
  const stored = (await listThreadMessages("thread-two", process.env)).find((message) => message.source === "thread_bridge_agent");
  assert.equal(stored.text, "Two new job leads match.");
  assert.equal(stored.bridgeAgentId, registration.client_id);
  const changes = (await client.callTool({ name: "read_changes", arguments: { cursor: listed.changesCursor } })).structuredContent;
  assert.deepEqual(changes.events, [], "the dot's own comment is not echoed back");

  const refreshed = await (await fetch(`${base}/mcp-oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: registration.client_id }) })).json();
  assert.ok(refreshed.access_token && refreshed.refresh_token !== tokens.refresh_token);
  const reused = await fetch(`${base}/mcp-oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: registration.client_id }) });
  assert.equal(reused.status, 400, "refresh tokens rotate");

  // MCP 2.0 (stateless) over HTTP on the same endpoint.
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const discover = await (await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }) })).json();
  assert.deepEqual(discover.result.capabilities, { tools: {}, events: {} });
  const modernList = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${refreshed.access_token}`, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } }) });
  assert.equal(modernList.status, 200);
  assert.equal((await modernList.json()).result.tools.length, 9);
  const modernNoToken = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: meta } }) });
  assert.equal(modernNoToken.status, 401);

  // A browser gets a page with the connection, and can revoke it there.
  assert.equal((await fetch(`${base}/mcp`)).status, 405, "MCP clients still get 405 on GET");
  const page = await (await fetch(`${base}/mcp`, { headers: { accept: "text/html" } })).text();
  assert.match(page, new RegExp(`${base}/mcp`));
  assert.match(page, /ChatGPT/);
  const grantId = /name="grant_id" value="([^"]+)"/.exec(page)[1];
  // Behind "Referrer-Policy: no-referrer" browsers send Origin: null; only a
  // same-origin Sec-Fetch-Site makes that acceptable.
  const nullCrossSite = await fetch(`${base}/mcp-oauth/connections/revoke`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: "null", "sec-fetch-site": "cross-site" }, body: new URLSearchParams({ grant_id: grantId }) });
  assert.equal(nullCrossSite.status, 403);
  const noHeaders = await fetch(`${base}/mcp-oauth/connections/revoke`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_id: grantId }) });
  assert.equal(noHeaders.status, 403);
  const crossSite = await fetch(`${base}/mcp-oauth/connections/revoke`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" }, body: new URLSearchParams({ grant_id: grantId }) });
  assert.equal(crossSite.status, 403);
  const revoke = await fetch(`${base}/mcp-oauth/connections/revoke`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ grant_id: grantId }) });
  assert.equal(revoke.status, 303);
  assert.match(await (await fetch(`${base}/mcp?revoked=1`, { headers: { accept: "text/html" } })).text(), /No assistant is connected/);
  const afterRevoke = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${refreshed.access_token}`, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: meta } }) });
  assert.equal(afterRevoke.status, 401, "revoking deletes the client's tokens");
});

// The connected assistant's quota tool end to end: real server, OAuth token,
// MCP SDK client and stateless protocol, real quota snapshot over a synthetic
// enrolled projection source (the file boundary the V2 broker writes).
test("a connected assistant reads current Codex and Claude quota over MCP without seeing account data", async (t) => {
  const { base, home } = await startBridgeServer(t);
  await createUser({ id: "admin" }, process.env).catch(() => null);
  const coreOwner = "10000000-0000-4000-8000-0000000000c1", account = "20000000-0000-4000-8000-0000000000c2";
  const sources = path.join(home, "quota-sources.json"), codexFile = path.join(home, "codex.json"), claudeFile = path.join(home, "claude.json");
  await fs.writeFile(sources, JSON.stringify({ format: "orkestr-provider-quota-sources-v1", sources: [
    { ownerUserId: "admin", coreOwnerId: coreOwner, accountRef: account, producerUid: process.getuid(), path: claudeFile },
    { ownerUserId: "admin", coreOwnerId: coreOwner, accountRef: account, producerUid: process.getuid(), path: codexFile, provider: "codex" },
  ] }), { mode: 0o600 });
  const now = Date.now();
  const projected = (provider, windows) => fs.writeFile(provider === "codex" ? codexFile : claudeFile,
    JSON.stringify({ format: "orkestr-provider-quota-v1", provider, owner_id: coreOwner, account_ref: account, windows }), { mode: 0o600 });
  await projected("codex", { seven_day: { used_percent: 21, resets_at: (now + 5 * 86_400_000) / 1000, status: null, observed_at: now - 60_000 } });
  await projected("claude", { five_hour: { used_percent: 100, resets_at: (now + 1_800_000) / 1000, status: "rejected", observed_at: now - 120_000 } });
  Object.assign(process.env, { ORKESTR_PROVIDER_QUOTA_PROJECTION_CONFIG: sources, ORKESTR_PROVIDER_QUOTA_CACHE_MS: "0" });

  const { tokens } = await connect(base);
  const client = new Client({ name: "test-dot", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
  t.after(() => client.close());
  const tool = (await client.listTools()).tools.find((entry) => entry.name === "get_provider_quotas");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["provider"]);

  const viaSdk = await client.callTool({ name: "get_provider_quotas", arguments: {} });
  assert.equal(viaSdk.isError, undefined, JSON.stringify(viaSdk.content));
  const report = viaSdk.structuredContent;
  assert.equal(report.available, true);
  const codex = report.providers.find((entry) => entry.provider === "codex");
  assert.deepEqual(codex.windows.map((entry) => [entry.window, entry.state, entry.remainingPercent]), [["five_hour", "not_reported", null], ["weekly", "current", 79]]);
  assert.equal(codex.apiCredits.state, "not_collected");
  const claude = report.providers.find((entry) => entry.provider === "claude");
  assert.deepEqual(claude.blockers.map((entry) => [entry.code, entry.window, entry.evidence]), [["rate_limited", "five_hour", "provider_status_rejected"]]);
  assert.equal(claude.windows.find((entry) => entry.window === "weekly").state, "not_reported");

  // The same read over the stateless (2026-07-28) protocol on the same endpoint.
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const modern = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${tokens.access_token}`,
    "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "get_provider_quotas" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_provider_quotas", arguments: { provider: "claude" }, _meta: meta } }) });
  assert.equal(modern.status, 200);
  const modernText = await modern.text();
  const modernReport = JSON.parse(modernText).result.structuredContent;
  assert.deepEqual(modernReport.providers.map((entry) => entry.provider), ["claude"]);
  assert.equal(modernReport.providers[0].windows[0].providerStatus, "rejected");

  for (const text of [JSON.stringify(viaSdk), modernText]) {
    for (const secret of [tokens.access_token, tokens.refresh_token, coreOwner, account, home, "account_ref", "owner_id"]) {
      assert.ok(!text.includes(secret), "no credential, account reference, owner id or source path in the answer");
    }
  }
});

// WhatsApp reading end to end: the consent page lists the owner's enrolled
// account, approving grants exactly that account, and the tool reads it over
// MCP. A connection approved before the enrollment gets nothing.
test("a connected assistant reads incoming WhatsApp messages only after consenting to the listed account", async (t) => {
  const { base, home } = await startBridgeServer(t);
  await createUser({ id: "admin" }, process.env).catch(() => null);
  const group = "120363000000000077@g.us";
  await createThread({ id: "thread-wa", ownerUserId: "admin", name: "Clients", binding: { connector: "whatsapp", chatId: group, displayName: "Clients group",
    additionalParticipantLabels: { "491700000077@c.us": "Client Person" } } }, process.env);
  const journal = path.join(home, "transport.sqlite");
  const writer = new DatabaseSync(journal);
  t.after(() => writer.close());
  writer.exec(`PRAGMA journal_mode=WAL; CREATE TABLE group_input(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE group_input_author(id TEXT PRIMARY KEY,proof TEXT NOT NULL); CREATE TABLE group_input_media(id TEXT PRIMARY KEY,path TEXT NOT NULL,filename TEXT,mimetype TEXT,size INTEGER);`);
  const id = `false_${group}_3EB0AAAA0001_200000000000077@lid`;
  const at = new Date(Date.now() - 60_000).toISOString();
  writer.prepare("INSERT INTO group_input VALUES(?,?,?,?)").run(id, group, "Can you send the offer?", at);
  writer.prepare("INSERT INTO group_input_author VALUES(?,?)").run(id, JSON.stringify({ version: "1", inputId: id, chatId: group, threadId: "thread-wa",
    authorId: "200000000000077@lid", phoneId: "491700000077@c.us", createdAt: at }));

  const before = await connect(base);
  const sources = path.join(home, "whatsapp-incoming-sources.json");
  await fs.writeFile(sources, JSON.stringify({ format: "orkestr-whatsapp-incoming-sources-v1", accounts: [
    { account: "orkestr", label: "the Orkestr number", ownerUserId: "admin", kind: "scoped_relay_journal", journalPath: journal }] }), { mode: 0o600 });
  process.env.ORKESTR_WHATSAPP_INCOMING_SOURCES = sources;
  const call = (token) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}`,
    "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "list_incoming_whatsapp_messages" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_incoming_whatsapp_messages", arguments: { account: "orkestr" },
    _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }) }).then((response) => response.json());
  const denied = await call(before.tokens.access_token);
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /bridge_whatsapp_not_granted/, "approved before the account was listed");

  const { tokens, page } = await connect(base);
  assert.match(page, /incoming WhatsApp messages<\/strong> of the Orkestr number/);
  const grants = JSON.parse(await fs.readFile(path.join(home, "thread-bridge-grants.json"), "utf8"));
  assert.deepEqual(grants.map((entry) => entry.whatsappRead), [undefined, ["orkestr"]], "the earlier connection is not widened; the new one gets the listed account");

  const client = new Client({ name: "test-dot", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
  t.after(() => client.close());
  const tool = (await client.listTools()).tools.find((entry) => entry.name === "list_incoming_whatsapp_messages");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["account", "chat", "since", "limit", "cursor"]);
  assert.deepEqual(tool.inputSchema.required, ["account"]);
  const viaSdk = await client.callTool({ name: "list_incoming_whatsapp_messages", arguments: { account: "orkestr" } });
  assert.equal(viaSdk.isError, undefined, JSON.stringify(viaSdk.content));
  const [message] = viaSdk.structuredContent.messages;
  assert.deepEqual([message.text, message.sender.name, message.sender.number, message.chat.name, message.chat.threadId], ["Can you send the offer?", "Client Person", "+49…77", "Clients group", "thread-wa"]);
  const modern = await call(tokens.access_token);
  assert.deepEqual(modern.result.structuredContent.messages, viaSdk.structuredContent.messages);
  const german = await client.callTool({ name: "list_incoming_whatsapp_messages", arguments: { account: "german" } });
  assert.match(german.content[0].text, /bridge_whatsapp_not_granted/);
  for (const leak of [tokens.access_token, journal, home, "491700000077", "200000000000077", "120363000000000077"]) {
    assert.ok(!JSON.stringify(viaSdk).includes(leak), `leaked ${leak}`);
  }
});

test("PKCE and one-time codes are enforced", async (t) => {
  const { base } = await startBridgeServer(t);
  const registration = await (await fetch(`${base}/mcp-oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json();
  const noPkce = await fetch(`${base}/mcp-oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: REDIRECT })}`);
  assert.equal(noPkce.status, 400);
  const wrongRedirect = await fetch(`${base}/mcp-oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: registration.client_id,
    redirect_uri: "https://chatgpt.com/other", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}`);
  assert.equal(wrongRedirect.status, 400);
  const consumed = await fetch(`${base}/mcp-oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: "mca_unknown", redirect_uri: REDIRECT, client_id: registration.client_id, code_verifier: "x" }) });
  assert.equal((await consumed.json()).error, "invalid_grant");
});

test("everything is hidden while the bridge is disabled", async (t) => {
  const { base } = await startBridgeServer(t, "0");
  for (const url of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
    assert.equal((await fetch(`${base}${url}`)).status, 404, url);
  }
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
  assert.equal((await fetch(`${base}/mcp-oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
});
