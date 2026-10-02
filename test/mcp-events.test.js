import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";
import { createUser } from "../packages/core/src/users.js";
import { replyToBridgeThread } from "../packages/core/src/thread-bridge.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";
import { readSubscriptions, signWebhook } from "../packages/core/src/mcp-events.js";
import { runMcpEventDelivery } from "../packages/core/src/mcp-event-delivery.js";
import { handleModernMcpRequest } from "../packages/core/src/mcp-modern-protocol.js";
import { assertPublicHttpsUrl, publicAddress, safePublicFetch } from "../packages/core/src/safe-public-fetch.js";
import { createConsent, decideConsent, exchangeMcpToken, mcpPrincipalFromAuthorization, negotiateAuthMethod, validateAuthorizeRequest } from "../packages/core/src/mcp-oauth.js";

const VERSION = "2026-07-28";
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const CALLBACK = "https://receiver.example.com/mcp-events/cb";
const principal = { kind: "delegated-agent", ownerUserId: "owner-a", agentId: "agent-a", grantId: "grant-a", issuer: "orkestr", authMethod: "orkestr-oauth", scopes: ["threads:read", "threads:comment"] };

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mcp-events-"));
  const env = { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite", ORKESTR_THREAD_BRIDGE_ENABLED: "1" };
  const grant = { id: "grant-a", ownerUserId: "owner-a", agentId: "agent-a", issuer: "orkestr", authMethod: "orkestr-oauth", enabled: true, expiresAt: "2099-01-01T00:00:00Z", observe: "all", reply: "all" };
  const writeGrants = (grants) => fs.writeFile(path.join(home, "thread-bridge-grants.json"), JSON.stringify(grants));
  await writeGrants([grant]);
  await createUser({ id: "owner-a" }, env);
  await createThread({ id: "thread-a", ownerUserId: "owner-a", name: "Sales" }, env);
  await createThread({ id: "thread-b", ownerUserId: "owner-a", name: "Jobs" }, env);
  t.after(async () => { await closeThreadMessageRegistryCache(); await fs.rm(home, { recursive: true, force: true }); });
  return { env, writeGrants };
}

function receiver({ status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options, json: JSON.parse(options.body) });
    const json = JSON.parse(options.body);
    if (json.type === "verification") return { status: 200, text: JSON.stringify({ challenge: json.challenge }) };
    return { status: typeof status === "function" ? status(calls) : status, text: "" };
  };
  return { calls, fetchImpl };
}

function rpc(method, params = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": VERSION, "io.modelcontextprotocol/clientCapabilities": {} } } };
}

function headersFor(body) {
  return { "mcp-protocol-version": VERSION, "mcp-method": body.method, ...(body.params?.name && body.method === "tools/call" ? { "mcp-name": body.params.name } : {}) };
}

async function call(body, env, eventOptions = {}) {
  return handleModernMcpRequest({ body, headers: headersFor(body), principal, env, eventOptions });
}

test("webhook signatures follow Standard Webhooks", () => {
  // Reference vector from the Standard Webhooks specification.
  const signature = signWebhook("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", "1614265330", '{"test": 2432232314}');
  assert.equal(signature, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("outbound fetches refuse private, local and non-HTTPS targets", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1"]) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("::ffff:808:808"), true);
  assert.throws(() => assertPublicHttpsUrl("http://example.com/cb"), /url_must_be_public_https/);
  assert.throws(() => assertPublicHttpsUrl("https://127.0.0.1/cb"), /url_address_not_public/);
  await assert.rejects(safePublicFetch("https://internal.example/cb", { lookup: async () => [{ address: "10.0.0.5", family: 4 }] }), /url_address_not_public/);
});

test("MCP 2.0 requests are validated against their headers and version", async (t) => {
  const { env } = await fixture(t);
  const discover = await handleModernMcpRequest({ body: { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }, headers: {}, env });
  assert.equal(discover.body.result.resultType, "complete");
  assert.deepEqual(discover.body.result.capabilities, { tools: {}, events: {} });
  assert.ok(discover.body.result.supportedVersions.includes(VERSION));

  const list = rpc("tools/list");
  const mismatch = await handleModernMcpRequest({ body: list, headers: { ...headersFor(list), "mcp-method": "tools/call" }, principal, env });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, -32020);
  const old = rpc("tools/list");
  old.params._meta["io.modelcontextprotocol/protocolVersion"] = "1900-01-01";
  const unsupported = await handleModernMcpRequest({ body: old, headers: { ...headersFor(old), "mcp-protocol-version": "1900-01-01" }, principal, env });
  assert.equal(unsupported.body.error.code, -32022);
  assert.deepEqual(unsupported.body.error.data.requested, "1900-01-01");
  assert.equal((await call(rpc("nope/nope"), env)).status, 404);

  const tools = await call(list, env);
  assert.equal(tools.body.result.cacheScope, "private");
  assert.deepEqual(tools.body.result.tools.map((tool) => tool.name), ["list_threads", "read_thread", "read_changes", "comment_on_thread", "send_message", "get_thread_status", "wait_for_reply"]);
  const callBody = rpc("tools/call", { name: "list_threads", arguments: {} });
  const listed = await call(callBody, env);
  assert.deepEqual(listed.body.result.structuredContent.threads.map((thread) => thread.id).sort(), ["thread-a", "thread-b"]);
  const nameMismatch = await handleModernMcpRequest({ body: callBody, headers: { ...headersFor(callBody), "mcp-name": "=?base64?cmVhZF90aHJlYWQ=?=" }, principal, env });
  assert.equal(nameMismatch.body.error.code, -32020);
});

test("subscriptions verify the callback, deliver signed events and advance the cursor", async (t) => {
  const { env } = await fixture(t);
  const { calls, fetchImpl } = receiver();
  const events = await call(rpc("events/list"), env);
  assert.equal(events.body.result.events[0].name, "thread.message.created");
  await assert.doesNotReject(async () => {
    const bad = await call(rpc("events/subscribe", { name: "thread.message.created", arguments: {}, delivery: { mode: "webhook", url: CALLBACK, secret: "whsec_short" } }), env, { fetchImpl });
    assert.match(bad.body.error.message, /whsec_/);
  });
  const subscribe = rpc("events/subscribe", { name: "thread.message.created", arguments: {}, delivery: { mode: "webhook", url: CALLBACK, secret: SECRET }, cursor: null });
  const first = await call(subscribe, env, { fetchImpl });
  assert.match(first.body.result.id, /^sub_/);
  assert.ok(Date.parse(first.body.result.refreshBefore) > Date.now());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].json.type, "verification");
  const again = await call(subscribe, env, { fetchImpl });
  assert.equal(again.body.result.id, first.body.result.id, "subscribe is idempotent");
  assert.equal(calls.length, 1, "verification is cached");

  await appendThreadMessage("thread-a", { role: "user", source: "whatsapp_inbound", text: "Please send the offer", state: "completed" }, env);
  await appendThreadMessage("thread-a", { role: "user", source: "timer_due", text: "Daily timer", state: "completed" }, env);
  await appendThreadMessage("thread-b", { role: "assistant", source: "claude-code", phase: "final_answer", state: "completed", text: "Offer sent." }, env);
  await replyToBridgeThread("thread-a", { requestId: "own-comment", text: "My own note" }, principal, env);
  assert.equal((await runMcpEventDelivery(env, { fetchImpl })).delivered, 2);

  const delivered = calls.slice(1);
  assert.deepEqual(delivered.map((entry) => entry.json.data.text), ["Please send the offer", "Offer sent."]);
  assert.deepEqual(delivered.map((entry) => entry.json.data.actor), ["human", "assistant"]);
  const [event] = delivered;
  assert.equal(event.json.name, "thread.message.created");
  assert.equal(event.headers["webhook-id"], event.json.eventId);
  assert.equal(event.headers["x-mcp-subscription-id"], first.body.result.id);
  assert.equal(event.headers["webhook-signature"], signWebhook(SECRET, event.headers["webhook-id"], event.headers["webhook-timestamp"], event.body));
  assert.ok(event.json.cursor);

  assert.equal((await runMcpEventDelivery(env, { fetchImpl })).delivered, 0, "nothing is delivered twice");
  const threadOnly = await call(rpc("events/subscribe", { name: "thread.message.created", arguments: { thread_id: "thread-b", actors: ["automation", "human"] }, delivery: { mode: "webhook", url: CALLBACK, secret: SECRET } }), env, { fetchImpl });
  assert.notEqual(threadOnly.body.result.id, first.body.result.id);
  assert.equal((await call(rpc("events/unsubscribe", { name: "thread.message.created", arguments: {}, delivery: { mode: "webhook", url: CALLBACK } }), env)).body.result.resultType, "complete");
  assert.deepEqual((await readSubscriptions(env)).subscriptions.map((entry) => entry.id), [threadOnly.body.result.id]);
});

test("failed deliveries retry with backoff, 410 ends the subscription, revoking access stops delivery", async (t) => {
  const { env, writeGrants } = await fixture(t);
  let failing = true;
  const { calls, fetchImpl } = receiver({ status: () => (failing ? 503 : 200) });
  await call(rpc("events/subscribe", { name: "thread.message.created", arguments: {}, delivery: { mode: "webhook", url: CALLBACK, secret: SECRET } }), env, { fetchImpl });
  await appendThreadMessage("thread-a", { role: "user", source: "ui", text: "Retry me", state: "completed" }, env);
  await runMcpEventDelivery(env, { fetchImpl });
  let [subscription] = (await readSubscriptions(env)).subscriptions;
  assert.equal(subscription.attempts, 1);
  assert.ok(Date.parse(subscription.nextAttemptAt) > Date.now());
  await runMcpEventDelivery(env, { fetchImpl });
  assert.equal(calls.filter((entry) => entry.json.data?.text === "Retry me").length, 1, "backoff is respected");

  failing = false;
  await fs.writeFile(path.join(env.ORKESTR_HOME, "secrets", "mcp-event-subscriptions.json"), JSON.stringify({
    ...(await readSubscriptions(env)), subscriptions: [{ ...subscription, nextAttemptAt: null }],
  }));
  await runMcpEventDelivery(env, { fetchImpl });
  const retried = calls.filter((entry) => entry.json.data?.text === "Retry me");
  assert.equal(retried.length, 2);
  assert.equal(retried[0].json.eventId, retried[1].json.eventId, "retries keep the event id");
  [subscription] = (await readSubscriptions(env)).subscriptions;
  assert.equal(subscription.attempts, 0);

  await writeGrants([]);
  await appendThreadMessage("thread-a", { role: "user", source: "ui", text: "After revoke", state: "completed" }, env);
  await runMcpEventDelivery(env, { fetchImpl });
  assert.equal(calls.some((entry) => entry.json.data?.text === "After revoke"), false);
  assert.deepEqual((await readSubscriptions(env)).subscriptions, []);
});

test("a 410 response removes the subscription", async (t) => {
  const { env } = await fixture(t);
  const { fetchImpl } = receiver({ status: 410 });
  await call(rpc("events/subscribe", { name: "thread.message.created", arguments: {}, delivery: { mode: "webhook", url: CALLBACK, secret: SECRET } }), env, { fetchImpl });
  await appendThreadMessage("thread-a", { role: "user", source: "ui", text: "Gone", state: "completed" }, env);
  await runMcpEventDelivery(env, { fetchImpl });
  assert.deepEqual((await readSubscriptions(env)).subscriptions, []);
});

test("OAuth accepts Client ID Metadata Documents with allowed redirect URIs", async (t) => {
  const { env } = await fixture(t);
  const clientId = "https://chatgpt.com/oauth/client-metadata.json";
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
  const doc = { client_id: clientId, client_name: "ChatGPT", redirect_uris: [redirect], token_endpoint_auth_method: "none" };
  const fetchImpl = async () => ({ status: 200, text: JSON.stringify(doc) });
  const challenge = crypto.createHash("sha256").update("v".repeat(43)).digest("base64url");
  const query = { client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" };
  const validated = await validateAuthorizeRequest(query, env, fetchImpl);
  assert.equal(validated.client.clientName, "ChatGPT");
  const otherId = "https://chatgpt.com/oauth/other.json";
  await assert.rejects(validateAuthorizeRequest({ ...query, client_id: otherId }, env, async () => ({ status: 200, text: JSON.stringify(doc) })), /invalid_client/);
});

test("ChatGPT's client metadata (none + private_key_jwt) connects as a public PKCE client", async (t) => {
  const { env } = await fixture(t);
  env.ORKESTR_MCP_PUBLIC_URL = "https://app.example.test";
  const clientId = "https://chatgpt.com/oauth/client-metadata.json";
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
  // As published by OpenAI: list of supported methods plus a legacy preference.
  const doc = {
    client_id: clientId, client_name: "ChatGPT", redirect_uris: [redirect],
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    token_endpoint_auth_method: "private_key_jwt",
  };
  const fetchImpl = async () => ({ status: 200, text: JSON.stringify(doc) });
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const request = await validateAuthorizeRequest({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge,
    code_challenge_method: "S256", resource: "https://app.example.test/mcp", state: "s1" }, env, fetchImpl);
  const consentId = await createConsent(request, { userId: "owner-a", sessionId: "session-1" }, env);
  const location = new URL(await decideConsent({ consentId, userId: "owner-a", sessionId: "session-1", approve: true }, env));
  assert.equal(location.searchParams.get("iss"), "https://app.example.test");
  const body = { grant_type: "authorization_code", code: location.searchParams.get("code"), redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: "https://app.example.test/mcp" };

  await assert.rejects(exchangeMcpToken({ ...body, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: "a.b.c" }, "", env, fetchImpl), /invalid_client/,
    "the token request must use the agreed method (none)");
  await assert.rejects(exchangeMcpToken({ ...body, code_verifier: "x".repeat(43) }, "", env, fetchImpl), /invalid_grant/, "PKCE is still enforced");
  const consentAgain = await createConsent(request, { userId: "owner-a", sessionId: "session-1" }, env);
  const code = new URL(await decideConsent({ consentId: consentAgain, userId: "owner-a", sessionId: "session-1", approve: true }, env)).searchParams.get("code");
  const tokens = await exchangeMcpToken({ ...body, code }, "", env, fetchImpl);
  assert.ok(tokens.access_token);
  const connected = await mcpPrincipalFromAuthorization(`Bearer ${tokens.access_token}`, env);
  assert.equal(connected.ownerUserId, "owner-a");
  assert.match(connected.agentId, /^mcpdoc_[0-9a-f]{24}$/);

  // A client that cannot act as a public client is refused with a clear reason.
  const keyOnly = { ...doc, client_id: "https://other.chatgpt.com/meta.json", token_endpoint_auth_methods_supported: ["private_key_jwt"] };
  await assert.rejects(validateAuthorizeRequest({ client_id: keyOnly.client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" },
    env, async () => ({ status: 200, text: JSON.stringify(keyOnly) })), /invalid_client/);
});

test("auth method negotiation prefers a mutually supported method", () => {
  assert.equal(negotiateAuthMethod({ token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], token_endpoint_auth_method: "private_key_jwt" }), "none");
  assert.equal(negotiateAuthMethod({ token_endpoint_auth_method: "client_secret_post" }), "client_secret_post");
  assert.equal(negotiateAuthMethod({}), "none");
  assert.equal(negotiateAuthMethod({ token_endpoint_auth_method: "private_key_jwt" }), "");
  assert.equal(negotiateAuthMethod({ token_endpoint_auth_methods_supported: ["private_key_jwt", "client_secret_basic"] }), "client_secret_basic");
});

test("a webhook POST failure stores only allowlisted diagnostics", async (t) => {
  const { env } = await fixture(t);
  const canary = Object.assign(new Error("private_customer_secret_abc"), { code: "sk-secretAbc123", name: "PrivateCustomerName" });
  const fetchImpl = async (url, options) => {
    const json = JSON.parse(options.body);
    if (json.type === "verification") return { status: 200, text: JSON.stringify({ challenge: json.challenge }) };
    throw canary;
  };
  await call(rpc("events/subscribe", { name: "thread.message.created", arguments: {}, delivery: { mode: "webhook", url: CALLBACK, secret: SECRET } }), env, { fetchImpl });
  await appendThreadMessage("thread-a", { role: "user", source: "ui", text: "Trigger", state: "completed" }, env);
  await runMcpEventDelivery(env, { fetchImpl });
  const [subscription] = (await readSubscriptions(env)).subscriptions;
  assert.equal(subscription.attempts, 1);
  assert.equal(subscription.lastError, "Error");
  const persisted = JSON.stringify(await readSubscriptions(env)) + JSON.stringify(await (await import("../packages/storage/src/store.js")).listEvents(env, 200));
  assert.doesNotMatch(persisted, /private_customer_secret_abc|sk-secretAbc123|PrivateCustomerName/);
});
