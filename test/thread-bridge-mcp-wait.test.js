import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";
import { createUser } from "../packages/core/src/users.js";
import { listEvents } from "../packages/storage/src/store.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
let lastAuthorization = "";
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const envKeys = ["ORKESTR_HOME", "ORKESTR_ADMIN_USER_ID", "ORKESTR_AUTH_REQUIRED", "ORKESTR_HOST_BOUNDARIES", "ORKESTR_AUTO_RUN_THREAD_INPUT",
  "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_WHATSAPP_AUTOSTART", "WHATSAPP_LOCAL_AUTOSTART", "ORKESTR_THREAD_BRIDGE_ENABLED",
  "ORKESTR_THREAD_STORE", "ORKESTR_THREAD_MESSAGE_STORE", "ORKESTR_MCP_PUBLIC_URL"];

async function startConnected(t) {
  const { startServer } = await import("../apps/server/src/server.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mcp-wait-"));
  const prior = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_AUTH_REQUIRED: "0", ORKESTR_HOST_BOUNDARIES: "0",
    ORKESTR_AUTO_RUN_THREAD_INPUT: "0", ORKESTR_RECOVER_RUNNING_ON_START: "0", ORKESTR_WHATSAPP_AUTOSTART: "0", WHATSAPP_LOCAL_AUTOSTART: "0",
    ORKESTR_THREAD_BRIDGE_ENABLED: "1", ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite",
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.ORKESTR_MCP_PUBLIC_URL = base;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeThreadMessageRegistryCache();
    for (const [key, value] of prior) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await createUser({ id: "admin" }, process.env).catch(() => null);
  await createThread({ id: "thread-w", ownerUserId: "admin", name: "Synthetic" }, process.env);
  const registration = await (await fetch(`${base}/mcp-oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Synthetic client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: REDIRECT, resource: `${base}/mcp`,
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const consentId = /name="consent_id" value="([^"]+)"/.exec(await (await fetch(`${base}/mcp-oauth/authorize?${query}`)).text())[1];
  const decision = await fetch(`${base}/mcp-oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ consent_id: consentId, decision: "approve" }) });
  const code = new URL(decision.headers.get("location")).searchParams.get("code");
  const tokens = await (await fetch(`${base}/mcp-oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: registration.client_id, code_verifier: verifier, resource: `${base}/mcp` }) })).json();
  lastAuthorization = `Bearer ${tokens.access_token}`;
  let id = 0;
  const call = (name, args, accept = "application/json, text/event-stream", signal) => fetch(`${base}/mcp`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", accept, authorization: `Bearer ${tokens.access_token}`, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args, _meta: META } }),
  });
  const sent = await (await call("send_message", { thread_id: "thread-w", text: "Synthetic request", request_id: `req-${crypto.randomUUID()}` }, "application/json")).json();
  return { base, call, messageId: sent.result.structuredContent.messageId };
}

function sseMessage(text) {
  const data = text.split("\n\n").find((block) => block.startsWith("event: message"));
  return JSON.parse(data.split("\n").find((line) => line.startsWith("data: ")).slice(6));
}

test("a long wait_for_reply streams keep-alives at once and delivers the answer when it arrives", async (t) => {
  const { call, messageId } = await startConnected(t);
  const started = Date.now();
  const response = await call("wait_for_reply", { thread_id: "thread-w", message_id: messageId, timeout_seconds: 20 });
  assert.ok(Date.now() - started < 1500, "headers are sent before any answer exists");
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  setTimeout(() => { void appendThreadMessage("thread-w", { role: "assistant", source: "claude-code", phase: "final_answer", state: "completed", text: "Synthetic answer", parentMessageId: messageId }, process.env); }, 2500);
  const text = await response.text();
  assert.match(text, /^: stream open/);
  assert.match(text, /: keep-alive/, "keep-alives flow while waiting");
  const message = sseMessage(text);
  assert.equal(message.result.structuredContent.status, "answered");
  assert.equal(message.result.structuredContent.reply.text, "Synthetic answer");

  let events = [];
  for (let attempt = 0; attempt < 40 && !events.length; attempt += 1) {
    events = (await listEvents(process.env, 200)).filter((event) => event.type === "mcp_request" && event.tool === "wait_for_reply");
    if (!events.length) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(events.at(-1).outcome, "ok");
  assert.equal(events.at(-1).transport, "sse");
  assert.ok(events.at(-1).durationMs >= 2000);
  assert.doesNotMatch(JSON.stringify(events), /Synthetic (answer|request)/, "diagnostics never contain message content");
});

test("clients that only accept JSON still get a plain response; a still_working result is not an error", async (t) => {
  const { call, messageId } = await startConnected(t);
  const response = await call("wait_for_reply", { thread_id: "thread-w", message_id: messageId, timeout_seconds: 1 }, "application/json");
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.error, undefined);
  assert.equal(body.result.structuredContent.status, "still_working");
});

test("a client disconnect cancels the wait and is recorded", async (t) => {
  const { call, messageId } = await startConnected(t);
  const controller = new AbortController();
  const response = await call("wait_for_reply", { thread_id: "thread-w", message_id: messageId, timeout_seconds: 30 }, undefined, controller.signal);
  setTimeout(() => controller.abort(), 300);
  await response.text().catch(() => null);
  let record = null;
  for (let attempt = 0; attempt < 40 && !record; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    record = (await listEvents(process.env, 200)).find((event) => event.type === "mcp_request" && event.tool === "wait_for_reply");
  }
  assert.ok(record, "the request is recorded");
  assert.equal(record.clientClosed, true);
  assert.equal(record.outcome, "client_closed");
  assert.ok(record.durationMs < 5000, "the server stopped waiting after the disconnect");
});

test("protocol errors on a long-running call keep their HTTP status instead of becoming a 200 stream", async (t) => {
  const { base, messageId } = await startConnected(t);
  const body = { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "wait_for_reply", arguments: { thread_id: "thread-w", message_id: messageId }, _meta: META } };
  const mismatch = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
    authorization: lastAuthorization, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "read_thread" }, body: JSON.stringify(body) });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.headers.get("content-type"), /application\/json/);
  assert.equal((await mismatch.json()).error.code, -32020);
  const oldVersion = { ...body, params: { ...body.params, _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } };
  const unsupported = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
    authorization: lastAuthorization, "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/call", "mcp-name": "wait_for_reply" }, body: JSON.stringify(oldVersion) });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error.code, -32022);
  const { id: _id, ...notification } = body;
  const accepted = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
    authorization: lastAuthorization, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "wait_for_reply" }, body: JSON.stringify(notification) });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get("content-type"), null);
});

test("legacy (SDK) requests record ok, tool_error and rpc_error with the JSON-RPC code", async (t) => {
  const { base } = await startConnected(t);
  const client = new Client({ name: "legacy-synthetic", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: lastAuthorization } } }));
  t.after(() => client.close());
  await client.callTool({ name: "get_thread_status", arguments: { thread_id: "thread-w" } });
  const toolError = await client.callTool({ name: "wait_for_reply", arguments: { thread_id: "thread-w", message_id: "not-a-sent-message" } });
  assert.equal(toolError.isError, true);
  // SDK 1.30 reports an unknown tool as a tool error, and a method the server
  // does not offer as a JSON-RPC error.
  assert.equal((await client.callTool({ name: "no_such_tool", arguments: {} })).isError, true);
  await assert.rejects(client.listPrompts());
  const byKey = {};
  for (let attempt = 0; attempt < 40 && Object.keys(byKey).length < 4; attempt += 1) {
    for (const event of await listEvents(process.env, 200)) {
      if (event.type === "mcp_request" && event.era === "legacy" && event.method !== "initialize" && !String(event.method).startsWith("notifications/")) byKey[event.tool || event.method] = event;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(byKey.get_thread_status?.outcome, "ok");
  assert.equal(byKey.wait_for_reply?.outcome, "tool_error");
  assert.equal(byKey.no_such_tool?.outcome, "tool_error");
  assert.equal(byKey["prompts/list"]?.outcome, "rpc_error");
  assert.equal(byKey["prompts/list"]?.rpcErrorCode, -32601);
  assert.equal(byKey.get_thread_status?.transport, "sdk");
});
