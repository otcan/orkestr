import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { safeErrorDiagnostics } from "../packages/core/src/safe-error-diagnostics.js";
import { sleep } from "../packages/core/src/thread-bridge-messaging.js";
import { listEvents } from "../packages/storage/src/store.js";
// Nest helpers are TypeScript compiled by build:server; tests import the dist build.
import { captureResponseOutcome, respondWithMcpException, streamMcpResponse, trackMcpRequest } from "../dist/server/apps/server/src/modules/threads/mcp-http.js";
import { runMcpEventDelivery } from "../packages/core/src/mcp-event-delivery.js";
import { mutateSubscriptions, readSubscriptions } from "../packages/core/src/mcp-events.js";

const PRIVATE = "Synthetic private text: customer 0000-SYNTHETIC";

function fakeResponse() {
  const response = new EventEmitter();
  Object.assign(response, {
    statusCode: 200, headers: {}, body: "", writableFinished: false, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    flushHeaders() { this.headersSent = true; },
    write(chunk) { this.body += String(chunk); this.headersSent = true; return true; },
    end(chunk) { if (chunk) this.body += String(chunk); this.writableFinished = true; this.emit("close"); return this; },
  });
  return response;
}

async function withHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mcp-diag-"));
  const prior = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    if (prior === undefined) delete process.env.ORKESTR_HOME; else process.env.ORKESTR_HOME = prior;
    await fs.rm(home, { recursive: true, force: true });
  });
}

async function recordedEvents(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const events = (await listEvents(process.env, 50)).filter(predicate);
    if (events.length) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

// Canaries shaped like every pattern a regex-based filter would have trusted.
const CANARY_MESSAGE = "private_customer_secret_abc";
const CANARY_CODE = "sk-secretAbc123";
const CANARY_NAME = "PrivateCustomerName";
const CANARIES = /private_customer_secret_abc|sk-secretAbc123|PrivateCustomerName|Synthetic private text/;

function canaryError() {
  return Object.assign(new Error(CANARY_MESSAGE), { code: CANARY_CODE, name: CANARY_NAME });
}

test("diagnostics emit only allowlisted classes and codes plus an opaque id", () => {
  for (const error of [canaryError(), new Error(CANARY_MESSAGE), Object.assign(new Error("x"), { code: CANARY_CODE }), Object.assign(new Error(PRIVATE), { name: CANARY_NAME })]) {
    const diagnostics = safeErrorDiagnostics(error);
    assert.equal(diagnostics.errorClass, "Error");
    assert.equal(diagnostics.errorCode, null);
    assert.match(diagnostics.errorId, /^err_[0-9a-f]{16}$/);
    assert.doesNotMatch(JSON.stringify(diagnostics), CANARIES);
  }
  assert.equal(safeErrorDiagnostics(new TypeError(PRIVATE)).errorClass, "TypeError");
  assert.equal(safeErrorDiagnostics(new Error("bridge_grant_revoked")).errorCode, "bridge_grant_revoked", "a known code is emitted as the allowlisted constant");
  assert.equal(safeErrorDiagnostics(Object.assign(new Error(PRIVATE), { code: "ECONNRESET" })).errorCode, "ECONNRESET");
  assert.equal(safeErrorDiagnostics(null).errorClass, "Error");
});

test("the catch-all MCP response records no canary and correlates by id", async (t) => {
  await withHome(t);
  const response = fakeResponse();
  response.json = function json(value) { this.body = JSON.stringify(value); this.end(); return this; };
  const request = { body: { jsonrpc: "2.0", id: 3, method: "tools/list" } };
  const record = trackMcpRequest(request, response, { era: "2026-07-28" });
  respondWithMcpException(response, record, 3, canaryError());
  const [event] = await recordedEvents((entry) => entry.type === "mcp_request");
  assert.equal(event.outcome, "exception");
  assert.equal(event.errorClass, "Error");
  assert.equal(event.errorCode, null);
  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body).error.data.errorId, event.errorId);
  assert.doesNotMatch(JSON.stringify(await listEvents(process.env, 50)) + response.body, CANARIES);
});

test("MCP event delivery failures persist no canary", async (t) => {
  await withHome(t);
  const subscription = { id: "sub_synthetic", agentId: "agent-x", ownerUserId: "owner-x", url: "https://receiver.example.com/cb",
    secret: `whsec_${Buffer.alloc(32, 3).toString("base64")}`, refreshBefore: "2099-01-01T00:00:00Z", cursor: "" };
  await mutateSubscriptions(process.env, (state) => { state.subscriptions = [subscription]; });
  // Pump-level failure (anything thrown while processing a subscription).
  await runMcpEventDelivery(process.env, { deliverFn: async () => { throw canaryError(); } });
  const [failure] = await recordedEvents((entry) => entry.type === "mcp_event_delivery_failed");
  assert.equal(failure.errorClass, "Error");
  assert.equal(failure.errorCode, null);
  const persisted = JSON.stringify(await readSubscriptions(process.env)) + JSON.stringify(await listEvents(process.env, 50));
  assert.doesNotMatch(persisted, CANARIES);
});

test("an exception during a streamed MCP call is recorded without its message and correlated by id", async (t) => {
  await withHome(t);
  const response = fakeResponse();
  const request = { body: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "wait_for_reply" } } };
  response.req = request;
  const record = trackMcpRequest(request, response, { era: "2026-07-28" });
  await streamMcpResponse(response, record, async () => { throw Object.assign(new Error(PRIVATE), { code: CANARY_CODE, name: CANARY_NAME }); });
  const [event] = await recordedEvents((entry) => entry.type === "mcp_request");
  assert.equal(event.outcome, "exception");
  assert.equal(event.rpcErrorCode, -32603);
  assert.equal(event.errorClass, "Error");
  const payload = JSON.parse(response.body.split("\n").find((line) => line.startsWith("data: ")).slice(6));
  assert.equal(payload.error.code, -32603);
  assert.equal(payload.error.data.errorId, event.errorId, "the client gets the same opaque id");
  assert.equal(event.errorCode, null);
  assert.doesNotMatch(JSON.stringify(await listEvents(process.env, 50)), CANARIES);
  assert.doesNotMatch(response.body, CANARIES);
});

test("legacy responses are classified from the written body", () => {
  const classify = (contentType, body) => {
    const response = fakeResponse();
    const outcome = captureResponseOutcome(response);
    response.write(body);
    response.end();
    return outcome();
  };
  assert.deepEqual(classify("json", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } })), { outcome: "ok" });
  assert.deepEqual(classify("json", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } })), { outcome: "tool_error" });
  assert.deepEqual(classify("sse", `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x" } })}\n\n`), { outcome: "rpc_error", rpcErrorCode: -32602 });
  assert.deepEqual(classify("json", ""), { outcome: "no_body" });
  // The SDK's HTTP adapter writes Uint8Array chunks.
  const response = fakeResponse();
  const outcome = captureResponseOutcome(response);
  response.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true } })));
  response.end();
  assert.deepEqual(outcome(), { outcome: "tool_error" });
});

test("long waits do not accumulate abort listeners", async () => {
  const controller = new AbortController();
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    for (let index = 0; index < 300; index += 1) await sleep(1, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "every completed sleep removed its listener");
    const pending = sleep(10_000, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    controller.abort();
    await pending;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await sleep(10_000, controller.signal); // already aborted: returns at once
  } finally {
    process.off("warning", onWarning);
  }
  assert.equal(warnings.includes("MaxListenersExceededWarning"), false);
});
