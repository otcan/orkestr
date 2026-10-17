import assert from "node:assert/strict";
import test from "node:test";
import { getAgentJobAdapter } from "../packages/core/src/agent-job-adapters.js";
import { openAICompatibleJobAdapter as adapter } from "../packages/core/src/agent-job-openai-compatible.js";
import { discoverLocalModel, localModelConfig } from "../packages/core/src/agent-job-openai-compatible-health.js";
import { checkLocalSchema } from "../packages/core/src/agent-job-local-schema.js";
import { registerAgentJobTool } from "../packages/core/src/agent-job-tools.js";
import { completionEvents, localModelServer } from "./fixtures/local-model-server.js";

const enabled = { ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
const policy = { allow: [], deny: [], approvalRequired: [] };
const objectSchema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
function state(baseUrl, extra = {}) { return { input: { baseUrl, model: "fake-local", prompt: "A synthetic greeting", inputs: {}, tools: policy, ...extra }, transcript: [] }; }

test("local adapter is default-off; disabled/off-host configuration makes zero requests", async () => {
  let requests = 0;
  assert.equal(getAgentJobAdapter("openai-compatible", {}), null);
  assert.equal(getAgentJobAdapter("openai-compatible", enabled), adapter);
  assert.equal(getAgentJobAdapter("openai-compatible", { ORKESTR_PERSONAL_AGENT_ENABLED: "  TRUE  " }), adapter);
  const status = await discoverLocalModel({}, {}, { fetchImpl: () => { requests++; throw Error(); } });
  assert.equal(status.state, "unavailable");
  assert.equal(status.reason, "personal_agent_disabled");
  assert.equal(requests, 0);
  for (const baseUrl of ["https://example.invalid/v1", "http://localhost/v1", "http://127.0.0.1/v1?key=fake", "http://user:fake@127.0.0.1/v1", "file:///v1", "http://127.0.0.1/other"]) {
    assert.throws(() => localModelConfig(enabled, { baseUrl }));
  }
});

test("discovery reports exact installed model, missing model and unconfigured model", async t => {
  const { baseUrl } = await localModelServer(t);
  assert.equal((await discoverLocalModel(enabled, { baseUrl, model: "fake-local" })).state, "available");
  assert.equal((await discoverLocalModel(enabled, { baseUrl, model: "missing" })).reason, "local_model_not_installed");
  assert.equal((await discoverLocalModel(enabled, { baseUrl })).reason, "local_model_not_configured");
  const unavailable = await discoverLocalModel(enabled, { baseUrl }, { fetchImpl: () => { throw new Error("private-server-error"); } });
  assert.equal(unavailable.reason, "local_endpoint_unavailable");
  assert.ok(!JSON.stringify(unavailable).includes("private-server-error"));
});

test("streaming preserves split UTF-8, records usage and returns only a complete final reply", async t => {
  const events = [];
  const { baseUrl, seen } = await localModelServer(t, (_body, _req, res) => {
    const data = Buffer.from(completionEvents({ content: "Merhaba, Grüße" }));
    for (let index = 0; index < data.length; index++) res.write(data.subarray(index, index + 1));
    res.end();
  });
  const step = await adapter.step({ env: enabled, emit: e => events.push(e) }, state(baseUrl));
  assert.equal(step.output, "Merhaba, Grüße");
  assert.equal(step.type, "final");
  assert.deepEqual(events.map(e => e.type), ["message.delta", "usage"]);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].body.model, "fake-local");
});

test("truncation, empty output and invalid structured output fail closed", async t => {
  for (const response of [completionEvents({ done: false }), completionEvents({ finish: "length" }), completionEvents({ content: "" }), completionEvents({ content: '{"count":1,"extra":true}' })]) {
    const { baseUrl } = await localModelServer(t, () => response);
    await assert.rejects(adapter.step({ env: enabled }, state(baseUrl, { outputSchema: objectSchema })), /local_(completion_incomplete|reply_empty|output_invalid)/);
  }
  const { baseUrl } = await localModelServer(t, () => completionEvents({ content: '{"count":1}' }));
  assert.deepEqual((await adapter.step({ env: enabled }, state(baseUrl, { outputSchema: objectSchema }))).output, { count: 1 });
  assert.throws(() => checkLocalSchema({ type: "string", pattern: "x" }), /schema_unsupported/);
});

test("only exposed tools with validated object arguments can reach the runner", async t => {
  const unregister = registerAgentJobTool({ name: "fixture.count", inputSchema: objectSchema, perform() { throw Error("adapter_must_not_execute"); } });
  t.after(unregister);
  const allowed = { ...policy, allow: ["fixture.count"] };
  const { baseUrl, seen } = await localModelServer(t, body => completionEvents({ content: "", calls: [{ name: body.tools[0].function.name, arguments: '{"count":2}' }] }));
  const step = await adapter.step({ env: enabled }, state(baseUrl, { tools: allowed }));
  assert.deepEqual(step, { type: "tool", tool: "fixture.count", wireName: seen[0].body.tools[0].function.name, args: { count: 2 }, stepIndex: 0 });
  for (const calls of [[{ name: "unlisted", arguments: "{}" }], [{ name: "tool_0", arguments: '{"count":"two"}' }], [{ name: "tool_0", arguments: "[]" }], [{ name: "tool_0", arguments: '{"count":1}' }, { name: "tool_1", arguments: "{}" }]]) {
    const fake = await localModelServer(t, body => completionEvents({ content: "", calls: calls.map(call => ({ ...call, name: call.name === "tool_0" ? body.tools[0].function.name : call.name })) }));
    await assert.rejects(adapter.step({ env: enabled }, state(fake.baseUrl, { tools: allowed })), /local_(tool_not_exposed|tool_arguments_invalid|parallel_tools_unsupported)/);
  }
});

test("unsupported tool schema and oversized context are refused before inference", async t => {
  const unregister = registerAgentJobTool({ name: "fixture.no-schema", perform() {} }); t.after(unregister);
  const { baseUrl, seen } = await localModelServer(t);
  await assert.rejects(adapter.step({ env: enabled }, state(baseUrl, { tools: { ...policy, allow: ["fixture.no-schema"] } })), /local_tool_schema_required/);
  await assert.rejects(adapter.step({ env: enabled }, state(baseUrl, { prompt: "x".repeat(65000) })), /local_context_limit/);
  assert.equal(seen.length, 0);
});

test("HTTP errors are sanitized and redirects never reach a second server", async t => {
  const target = await localModelServer(t);
  const source = await localModelServer(t, (_b, _r, res) => { res.writeHead(307, { location: `${target.baseUrl}/chat/completions` }); return "private-error-body"; });
  await assert.rejects(adapter.step({ env: enabled }, state(source.baseUrl)), /local_endpoint_unavailable/);
  assert.equal(target.seen.length, 0);
  const error = await localModelServer(t, (_b, _r, res) => { res.statusCode = 503; return "private-error-body"; });
  await assert.rejects(adapter.step({ env: enabled }, state(error.baseUrl)), e => e.message === "local_completion_http_503" && e.retryable);
});

test("AbortSignal closes a streaming HTTP request without returning partial text", async t => {
  let started, closed;
  const start = new Promise(resolve => { started = resolve; });
  const close = new Promise(resolve => { closed = resolve; });
  const { baseUrl } = await localModelServer(t, (_b, _req, res) => { res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); res.on("close", closed); started(); });
  const controller = new AbortController();
  const step = adapter.step({ env: enabled, signal: controller.signal }, state(baseUrl));
  await start; controller.abort("synthetic_cancel");
  await assert.rejects(step);
  await Promise.race([close, new Promise((_, reject) => setTimeout(() => reject(Error("socket_not_closed")), 1000).unref())]);
});
