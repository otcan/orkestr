import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordCreditUsage, creditUsageSummary } from "../packages/core/src/credit-usage.js";
import { drainAllPendingThreadInputs } from "../packages/core/src/runtime-leases.js";
import { buildTenantApiAgentInstructions, processApiAgentThreadInput, threadUsesApiAgent } from "../packages/core/src/tenant-api-agent.js";
import { runTenantApiAgentTool, tenantApiAgentToolDefinitions } from "../packages/core/src/tenant-api-agent-tools.js";
import { listGmailNotificationsForPrincipal } from "../packages/core/src/gmail-notifications.js";
import { createTimer, listTimers, markDueTimers } from "../packages/core/src/timers.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { appendThreadMessage, createThread, enqueueThreadInputForPrincipal, getThread, listThreadMessages } from "../packages/core/src/threads.js";
import { createTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import { readUserPrivateIdentities, upsertUser } from "../packages/core/src/users.js";
import { listFilesForPrincipal } from "../packages/core/src/workspace-files.js";
import { initialQueueDeliveryState, routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { userDataPaths } from "../packages/storage/src/paths.js";
import { listEvents } from "../packages/storage/src/store.js";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

const GENERIC_TOOL_FALLBACK_TEXT = "I can't truthfully complete or claim external browser, workspace, file, or account work from this chat without a tool result. Workspace and live browser execution are not available in this chat right now.";

test("tenant api-agent strict tool schemas satisfy OpenAI requirements", () => {
  const assertStrictObjectSchemas = (schema = {}, label = "schema") => {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes("object")) {
      assert.equal(schema.additionalProperties, false, `${label} object schema should set additionalProperties false`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      assertStrictObjectSchemas(child, `${label}.${key}`);
    }
    if (schema.items) assertStrictObjectSchemas(schema.items, `${label}[]`);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      for (const [index, child] of (schema[key] || []).entries()) {
        assertStrictObjectSchemas(child, `${label}.${key}[${index}]`);
      }
    }
  };
  for (const tool of tenantApiAgentToolDefinitions()) {
    if (tool.type !== "function" || tool.strict !== true) continue;
    const properties = Object.keys(tool.parameters?.properties || {});
    const required = tool.parameters?.required;
    assert.ok(Array.isArray(required), `${tool.name} strict schema should define required`);
    assert.deepEqual(properties.filter((key) => !required.includes(key)), [], `${tool.name} strict schema should require every property`);
    assertStrictObjectSchemas(tool.parameters, tool.name);
  }
});

function tenantContextFromInstructions(instructions = "") {
  const match = String(instructions).match(/Tenant context JSON: (\{.*\})$/m);
  assert.ok(match, "instructions should include tenant context JSON");
  return JSON.parse(match[1]);
}

async function allowSanitizerEnv(home, extra = {}) {
  const script = path.join(home, "allow-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  JSON.parse(input);",
      "  console.log(JSON.stringify({ allow: true, reason: 'test-allow', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    ORKESTR_HOME: home,
    OPENAI_API_KEY: "sk-test",
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
    ...extra,
  };
}

test("tenant api-agent answers non-admin WhatsApp thread without Codex delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-answer-"));
  const env = await allowSanitizerEnv(home);
  await createThread({
    id: "otcantest",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executorId: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });
  const input = await enqueueThreadInputForPrincipal("otcantest", {
    text: "hi",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, principal, env);
  const calls = [];
  const result = await processApiAgentThreadInput("otcantest", env, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return response({
        id: "resp_api_agent_1",
        model: "gpt-5-mini",
        output_text: "Hi. What would you like to work on?",
        output: [],
        usage: { input_tokens: 120, output_tokens: 9, input_tokens_details: { cached_tokens: 0 } },
      });
    },
  });
  const messages = await listThreadMessages("otcantest", env);
  const current = messages.find((message) => message.id === input.id);
  const assistant = messages.find((message) => message.role === "assistant");
  const usage = await creditUsageSummary({ tenantId: "otcan" }, env);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "gpt-5-mini");
  assert.equal(calls[0].body.metadata.orkestr_runtime, "api-agent");
  const context = tenantContextFromInstructions(calls[0].body.instructions);
  assert.equal(context.capabilities.whatsapp, true);
  assert.equal(context.capabilities.scopedConnectors.whatsapp, true);
  assert.equal(context.capabilities.desktops, false);
  assert.equal(context.capabilities.gmail, false);
  assert.equal(context.capabilities.linkedin, false);
  assert.equal(context.capabilities.workspace.executionAvailable, false);
  assert.equal(context.capabilities.workspace.connected, false);
  assert.equal(context.capabilities.workspace.connectionAvailable, true);
  assert.equal(context.capabilities.workspace.actionTool, "orkestr_connect_workspace_runtime");
  assert.equal(Object.hasOwn(context.capabilities, "codexEscalation"), false);
  assert.equal(context.capabilities.enabledSkills.includes("whatsapp"), true);
  assert.equal(context.capabilities.enabledSkills.includes("gmail"), false);
  assert.equal(context.capabilities.enabledSkills.includes("outlook"), false);
  assert.equal(context.capabilities.skills.find((skill) => skill.id === "whatsapp")?.enabled, true);
  assert.equal(context.capabilities.skills.find((skill) => skill.id === "gmail")?.enabled, false);
  assert.equal(context.capabilities.skills.find((skill) => skill.id === "gmail")?.registryEnabled, true);
  assert.equal(current.state, "completed");
  assert.equal(current.deliveryState, "delivered");
  assert.equal(assistant.source, "api-agent");
  assert.equal(assistant.parentMessageId, input.id);
  assert.equal(assistant.text.includes("Codex"), false);
  assert.equal(usage.count, 1);
  assert.equal(usage.byModel["gpt-5-mini"] > 0, true);
});

test("tenant api-agent keeps timers available when capability lookup falls back", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-capability-fallback-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const paths = userDataPaths("otcan", env);
  await fs.mkdir(paths.root, { recursive: true });
  await fs.writeFile(paths.skills, "{not-valid-json", "utf8");
  const thread = await createThread({
    id: "otcan-capability-fallback",
    ownerUserId: "otcan",
    name: "otcan capability fallback",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-capability" },
  }, env);

  const instructions = await buildTenantApiAgentInstructions(thread, [], env);
  const context = tenantContextFromInstructions(instructions);
  const events = await listEvents(env, 20);

  assert.equal(context.capabilities.timers, true);
  assert.equal(context.capabilities.whatsapp, true);
  assert.ok(context.capabilities.enabledSkills.includes("timers"));
  assert.equal(context.capabilities.skills.find((skill) => skill.id === "timers")?.available, true);
  assert.equal(events.some((event) =>
    event.type === "api_agent_capability_decision" &&
    event.threadId === thread.id &&
    event.capability === "timers" &&
    event.result === "fallback_available"
  ), true);
});

test("tenant api-agent repairs bare acknowledgements for identity and capability turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-repair-"));
  const env = await allowSanitizerEnv(home);
  await createThread({
    id: "otcantest-repair",
    ownerUserId: "otcan",
    name: "otcantest",
    bindingName: "orkestr.example.test",
    runtimeKind: "api-agent",
    executorId: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", displayName: "orkestr.example.test", outboundAccountId: "wa-1" },
  }, env);
  await appendThreadMessage("otcantest-repair", {
    role: "user",
    text: "who am I?",
    state: "completed",
  }, env);
  await appendThreadMessage("otcantest-repair", {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text: "You are the person messaging this WhatsApp chat.",
    state: "completed",
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-repair", {
    text: "I'm Can. How can you help me?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-repair", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        const context = tenantContextFromInstructions(body.instructions);
        assert.equal(context.chat.chatName, "orkestr.example.test");
        assert.equal(context.chat.surface, "WhatsApp chat");
        assert.match(body.instructions, /Never answer a normal chat question/i);
        assert.match(body.instructions, /Use the recent message history for conversational identity/i);
        return response({
          id: "resp_api_agent_repair_1",
          model: "gpt-5-mini",
          output_text: "Done.",
          output: [],
          usage: { input_tokens: 250, output_tokens: 2 },
        });
      }
      assert.equal(body.tools.some((tool) => tool.name === "orkestr_list_skills"), true);
      assert.match(body.instructions, /Response repair/i);
      assert.match(body.instructions, /call the tool before finalizing/i);
      assert.match(body.input.at(-1).content, /I'm Can\. How can you help me\?/);
      return response({
        id: "resp_api_agent_repair_2",
        model: "gpt-5-mini",
        output_text: "Got it, Can. I can help you here on WhatsApp with questions, planning, drafting, and any tenant features that are connected for this chat.",
        output: [],
        usage: { input_tokens: 310, output_tokens: 37 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-repair", env);
  const current = messages.find((message) => message.id === input.id);
  const assistant = messages.find((message) => message.parentMessageId === input.id);
  const usage = await creditUsageSummary({ tenantId: "otcan" }, env);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(current.state, "completed");
  assert.equal(assistant.text.trim(), "Got it, Can. I can help you here on WhatsApp with questions, planning, drafting, and any tenant features that are connected for this chat.");
  assert.notEqual(assistant.text.trim(), "Done.");
  assert.equal(usage.count, 2);
  assert.equal(usage.recent.some((record) => record.callKind === "assistant_repair"), true);
});

test("tenant api-agent repairs empty tool-result answers for identity and capability turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-empty-tool-repair-"));
  const env = await allowSanitizerEnv(home);
  await createThread({
    id: "otcantest-empty-tool-repair",
    ownerUserId: "otcan",
    name: "otcantest",
    bindingName: "orkestr.example.test",
    runtimeKind: "api-agent",
    executorId: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", displayName: "orkestr.example.test", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-empty-tool-repair", {
    text: "I'm Can. How can you help me?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-empty-tool-repair", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return response({
          id: "resp_api_agent_empty_tool_repair_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_list_skills",
            call_id: "call_list_skills",
            arguments: "{}",
          }],
          usage: { input_tokens: 330, output_tokens: 20 },
        });
      }
      if (calls.length === 2) {
        assert.equal(body.input.some((item) => item.type === "function_call_output"), true);
        return response({
          id: "resp_api_agent_empty_tool_repair_2",
          model: "gpt-5-mini",
          output_text: "",
          output: [],
          usage: { input_tokens: 520, output_tokens: 2 },
        });
      }
      assert.equal(body.tools, undefined);
      assert.match(body.instructions, /Response repair/i);
      assert.match(body.input.at(-1).content, /I'm Can\. How can you help me\?/);
      return response({
        id: "resp_api_agent_empty_tool_repair_3",
        model: "gpt-5-mini",
        output_text: "Got it, Can. I can help you here on WhatsApp with questions, planning, drafting, and connected tenant features.",
        output: [],
        usage: { input_tokens: 610, output_tokens: 33 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-empty-tool-repair", env);
  const current = messages.find((message) => message.id === input.id);
  const assistant = messages.find((message) => message.parentMessageId === input.id);
  const usage = await creditUsageSummary({ tenantId: "otcan" }, env);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(current.state, "completed");
  assert.match(assistant.text, /Got it, Can/i);
  assert.notEqual(assistant.text.trim(), "Done.");
  assert.equal(usage.recent.some((record) => record.callKind === "assistant_repair"), true);
});

test("tenant api-agent retries stale running messages after a restart", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-stale-running-"));
  const env = await allowSanitizerEnv(home, { ORKESTR_API_AGENT_STALE_RUNNING_MS: "1000" });
  await createThread({
    id: "otcantest-stale",
    ownerUserId: "otcan",
    name: "otcantest-stale",
    runtimeKind: "api-agent",
    executorId: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await appendThreadMessage("otcantest-stale", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
    text: "What is done?",
    state: "running",
    deliveryState: "api_agent_running",
    observedVia: "api_agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, env);
  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-stale", env, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return response({
        id: "resp_api_agent_stale",
        model: "gpt-5-mini",
        output_text: "The previous turn was interrupted before I could answer.",
        output: [],
      });
    },
  });
  const messages = await listThreadMessages("otcantest-stale", env);
  const current = messages.find((message) => message.id === input.id);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(current.state, "completed");
  assert.equal(current.deliveryState, "delivered");
  assert.equal(current.observedVia, "api_agent_response");
  assert.equal(current.staleDeliveryState, "api_agent_running");
  assert.equal(current.staleObservedVia, "api_agent");
  assert.equal(assistant.parentMessageId, input.id);
  assert.equal(assistant.text, "The previous turn was interrupted before I could answer.");
});

test("tenant api-agent sanitizer receives scoped WhatsApp capability for api-agent input", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-sanitizer-caps-"));
  const script = path.join(home, "capability-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input);",
      "  const caps = payload.resource?.capabilities || {};",
      "  const ok = payload.action !== 'api-agent.input' || (caps.whatsapp === true && caps.scopedConnectors?.whatsapp === true && caps.linkedin === false);",
      "  console.log(JSON.stringify({ allow: ok, reason: ok ? 'capability-ok' : 'missing-api-agent-capabilities', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ORKESTR_HOME: home,
    OPENAI_API_KEY: "sk-test",
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
  await createThread({
    id: "otcan-caps",
    ownerUserId: "otcan",
    name: "otcan-caps",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-caps", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcan-caps", {
    text: "What's the WhatsApp number that you control?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-caps",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  let called = false;
  const result = await processApiAgentThreadInput("otcan-caps", env, {
    fetchImpl: async () => {
      called = true;
      return response({
        id: "resp_api_agent_caps",
        model: "gpt-5-mini",
        output_text: "I'm connected to this WhatsApp chat through Orkestr. Exact backend account details are admin-only.",
        output: [],
        usage: { input_tokens: 100, output_tokens: 16 },
      });
    },
  });
  const messages = await listThreadMessages("otcan-caps", env);

  assert.equal(result.ok, true);
  assert.equal(called, true);
  assert.equal(messages.find((message) => message.role === "user").state, "completed");
});

test("tenant api-agent explains connector-identity sanitizer denials instead of generic failure", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-sanitizer-denial-"));
  const script = path.join(home, "deny-api-agent-identity.mjs");
  await fs.writeFile(
    script,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input);",
      "  const deny = payload.action === 'api-agent.input';",
      "  console.log(JSON.stringify({ allow: !deny, reason: deny ? 'asks to expose WhatsApp connector identity without explicit capability' : 'allowed', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ORKESTR_HOME: home,
    OPENAI_API_KEY: "sk-test",
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
  await createThread({
    id: "otcan-denial",
    ownerUserId: "otcan",
    name: "otcan-denial",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-denial", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcan-denial", {
    text: "What's the WhatsApp number that you control?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-denial",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const result = await processApiAgentThreadInput("otcan-denial", env, {
    fetchImpl: async () => {
      throw new Error("openai should not be called when sanitizer blocks");
    },
  });
  const messages = await listThreadMessages("otcan-denial", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, false);
  assert.match(assistant.text, /I can use this WhatsApp chat/i);
  assert.match(assistant.text, /can't expose backend WhatsApp account or connector identity/i);
});

test("tenant api-agent reports sanitizer outages as temporary resend errors", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-sanitizer-outage-"));
  const script = path.join(home, "unavailable-api-agent-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input);",
      "  if (payload.action === 'api-agent.input') {",
      "    console.log(JSON.stringify({ allow: false, unavailable: true, reason: 'llm_sanitizer_http_500', model: 'test-llm' }));",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ allow: true, reason: 'allowed', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ORKESTR_HOME: home,
    OPENAI_API_KEY: "sk-test",
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
  await createThread({
    id: "otcan-sanitizer-outage",
    ownerUserId: "otcan",
    name: "otcan-sanitizer-outage",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-outage", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcan-sanitizer-outage", {
    text: "I'm Can. How can you help me?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-outage",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const result = await processApiAgentThreadInput("otcan-sanitizer-outage", env, {
    fetchImpl: async () => {
      throw new Error("openai should not be called when sanitizer is unavailable");
    },
  });
  const messages = await listThreadMessages("otcan-sanitizer-outage", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, false);
  assert.match(assistant.text, /sanitizer service was temporarily unavailable/i);
  assert.match(assistant.text, /Please resend the message/i);
  assert.doesNotMatch(assistant.text, /ask an admin|check the sanitizer setup/i);
});

test("tenant api-agent explains missing Gmail capability without a generic safety refusal", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-denial-"));
  const script = path.join(home, "deny-api-agent-gmail.mjs");
  await fs.writeFile(
    script,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input);",
      "  const deny = payload.action === 'api-agent.input';",
      "  console.log(JSON.stringify({ allow: !deny, reason: deny ? 'gmail capability missing' : 'allowed', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ORKESTR_HOME: home,
    OPENAI_API_KEY: "sk-test",
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
  await createThread({
    id: "otcantest-gmail-denial",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-denial", {
    text: "Can you check my gmail?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const result = await processApiAgentThreadInput("otcantest-gmail-denial", env, {
    fetchImpl: async () => {
      throw new Error("openai should not be called when sanitizer blocks");
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-denial", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, false);
  assert.match(assistant.text, /Gmail is not connected or enabled for this chat yet/i);
  assert.match(assistant.text, /Ask me to connect Gmail/i);
  assert.doesNotMatch(assistant.text, /Orkestr UI|Orkestr admin|Orkestr administrator/i);
  assert.doesNotMatch(assistant.text, /safely handle|private connector|account identity/i);
});

test("tenant api-agent creates a persisted Gmail notification rule from chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-notification-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
    ORKESTR_GMAIL_NOTIFICATION_MIN_INTERVAL_MS: "300000",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const paths = userDataPaths("otcan", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({
    accessToken: "user-gmail-notification-access",
    refreshToken: "user-gmail-notification-refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }), "utf8");
  await createThread({
    id: "otcantest-gmail-notification",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-notification", {
    text: "Can you setup a push notification on every Gmail message received - send me the mail subject here?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const openAiCalls = [];
  const result = await processApiAgentThreadInput("otcantest-gmail-notification", env, {
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      openAiCalls.push(body);
      if (openAiCalls.length === 1) {
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_list_actions"), true);
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_run_action"), true);
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_create_gmail_notification"), false);
        assert.match(body.instructions, /Do not ask for yes\/no confirmation/i);
        assert.match(body.instructions, /orkestr_run_action/i);
        return response({
          id: "resp_gmail_notification_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_run_action",
            call_id: "call_create_gmail_notification",
            arguments: JSON.stringify({
              actionKey: "gmail.watch.notification",
              provider: "",
              verb: "",
              object: "",
              idempotencyKey: "gmail-subject-notifications",
              parameters: {
                label: "Gmail subject notifications",
                query: "",
                interval: "1m",
                targetType: "thread",
                target: "",
                maxItemsPerRun: 1,
                enabled: true,
                allowBroadQuery: false,
              },
            }),
          }],
          usage: { input_tokens: 300, output_tokens: 20 },
        });
      }
      const toolOutput = JSON.parse(body.input.at(-1).output);
      assert.equal(toolOutput.ok, true);
      assert.equal(toolOutput.notification.query, "is:unread newer_than:1d");
      assert.equal(toolOutput.notification.intervalMs, 300000);
      return response({
        id: "resp_gmail_notification_2",
        model: "gpt-5-mini",
        output_text: "Gmail notification created. I will send subject/from/snippet previews here when new matching Gmail arrives.",
        output: [],
        usage: { input_tokens: 360, output_tokens: 18 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-notification", env);
  const user = messages.find((message) => message.role === "user");
  const assistant = messages.find((message) => message.role === "assistant");
  const notifications = await listGmailNotificationsForPrincipal(userPrincipal({ id: "otcan", role: "user" }), env);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 2);
  assert.equal(user.state, "completed");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].target, "otcantest-gmail-notification");
  assert.equal(notifications[0].query, "is:unread newer_than:1d");
  assert.equal(notifications[0].intervalMs, 300000);
  assert.match(assistant.text, /Gmail notification created/i);
  assert.doesNotMatch(assistant.text, /not wired|did not create|Gmail is not connected|Ask me to connect Gmail/i);
});

test("tenant api-agent reports disabled Gmail notifications from tool results", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-notification-disabled-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_GMAIL_NOTIFICATION_MIN_INTERVAL_MS: "300000",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const paths = userDataPaths("otcan", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({
    accessToken: "user-gmail-notification-disabled-access",
    refreshToken: "user-gmail-notification-disabled-refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }), "utf8");
  await createThread({
    id: "otcantest-gmail-notification-disabled",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-notification-disabled", {
    text: "Can you send me a message here whenever I receive a Gmail mail?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const openAiCalls = [];
  const result = await processApiAgentThreadInput("otcantest-gmail-notification-disabled", env, {
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      openAiCalls.push(body);
      if (openAiCalls.length === 1) {
        return response({
          id: "resp_gmail_notification_disabled_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_create_gmail_notification",
            call_id: "call_create_gmail_notification_disabled",
            arguments: JSON.stringify({
              label: "Gmail notifications",
              query: "",
              interval: "1m",
              targetType: "thread",
              target: "",
              maxItemsPerRun: 1,
              enabled: true,
              allowBroadQuery: false,
            }),
          }],
          usage: { input_tokens: 300, output_tokens: 20 },
        });
      }
      const toolOutput = JSON.parse(body.input.at(-1).output);
      assert.equal(toolOutput.ok, false);
      assert.equal(toolOutput.error, "gmail_notifications_disabled");
      return response({
        id: "resp_gmail_notification_disabled_2",
        model: "gpt-5-mini",
        output_text: "I couldn't manage Gmail notifications for this chat right now. Please try again in a moment.",
        output: [],
        usage: { input_tokens: 360, output_tokens: 18 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-notification-disabled", env);
  const assistant = messages.find((message) => message.role === "assistant");
  const notifications = await listGmailNotificationsForPrincipal(userPrincipal({ id: "otcan", role: "user" }), env);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 2);
  assert.deepEqual(notifications, []);
  assert.match(assistant.text, /Gmail background notifications are not enabled/i);
  assert.doesNotMatch(assistant.text, /try again in a moment/i);
});

test("tenant api-agent repair retry can call Gmail notification tools", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-notification-repair-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
    ORKESTR_GMAIL_NOTIFICATION_MIN_INTERVAL_MS: "300000",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const paths = userDataPaths("otcan", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({
    accessToken: "user-gmail-notification-repair-access",
    refreshToken: "user-gmail-notification-repair-refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }), "utf8");
  await createThread({
    id: "otcantest-gmail-notification-repair",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-notification-repair", {
    text: "Can you send me a message here whenever I receive a Gmail mail?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const openAiCalls = [];
  const result = await processApiAgentThreadInput("otcantest-gmail-notification-repair", env, {
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      openAiCalls.push(body);
      if (openAiCalls.length === 1) {
        return response({
          id: "resp_gmail_notification_repair_1",
          model: "gpt-5-mini",
          output_text: "I'll send you a message here whenever new Gmail arrives.",
          output: [],
          usage: { input_tokens: 300, output_tokens: 12 },
        });
      }
      if (openAiCalls.length === 2) {
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_run_action"), true);
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_create_gmail_notification"), false);
        assert.match(body.instructions, /call the tool before finalizing/i);
        return response({
          id: "resp_gmail_notification_repair_2",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_run_action",
            call_id: "call_create_gmail_notification_repair",
            arguments: JSON.stringify({
              actionKey: "gmail.watch.notification",
              provider: "",
              verb: "",
              object: "",
              idempotencyKey: "gmail-notification-repair",
              parameters: {
                label: "Gmail notifications",
                query: "",
                interval: "1m",
                targetType: "thread",
                target: "",
                maxItemsPerRun: 1,
                enabled: true,
                allowBroadQuery: false,
              },
            }),
          }],
          usage: { input_tokens: 380, output_tokens: 20 },
        });
      }
      const toolOutput = JSON.parse(body.input.at(-1).output);
      assert.equal(toolOutput.ok, true);
      assert.equal(toolOutput.notification.query, "is:unread newer_than:1d");
      assert.equal(toolOutput.notification.intervalMs, 300000);
      return response({
        id: "resp_gmail_notification_repair_3",
        model: "gpt-5-mini",
        output_text: "Gmail notification created. I will message you here when new unread Gmail arrives.",
        output: [],
        usage: { input_tokens: 430, output_tokens: 18 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-notification-repair", env);
  const assistant = messages.find((message) => message.role === "assistant");
  const notifications = await listGmailNotificationsForPrincipal(userPrincipal({ id: "otcan", role: "user" }), env);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 3);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].target, "otcantest-gmail-notification-repair");
  assert.match(assistant.text, /Gmail notification created/i);
  assert.doesNotMatch(assistant.text, /Tell me what you want|workspace execution|\/codex/i);
});

test("tenant api-agent Gmail notification tools list and delete scoped rules", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-notification-tools-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
    ORKESTR_GMAIL_NOTIFICATION_MIN_INTERVAL_MS: "300000",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const paths = userDataPaths("otcan", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({
    accessToken: "user-gmail-notification-tool-access",
    refreshToken: "user-gmail-notification-tool-refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }), "utf8");
  await createThread({
    id: "otcantest-gmail-notification-tools",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });
  const thread = await getThread("otcantest-gmail-notification-tools", env);

  const created = await runTenantApiAgentTool("orkestr_create_gmail_notification", {
    label: "Unread Gmail",
    query: "is:unread newer_than:1d",
    interval: "1m",
    targetType: "thread",
    target: "",
    maxItemsPerRun: 1,
    enabled: "true",
    allowBroadQuery: "",
  }, { principal, thread }, env);
  const updated = await runTenantApiAgentTool("orkestr_update_gmail_notification", {
    notificationId: "",
    query: "from:alerts@example.com newer_than:1d",
    interval: "15m",
    noReply: true,
  }, { principal, thread }, env);
  const listed = await runTenantApiAgentTool("orkestr_list_gmail_notifications", {}, { principal, thread }, env);
  const deleted = await runTenantApiAgentTool("orkestr_delete_gmail_notification", {
    notificationId: created.notification.id,
  }, { principal, thread }, env);
  const after = await runTenantApiAgentTool("orkestr_list_gmail_notifications", {}, { principal, thread }, env);

  assert.equal(created.ok, true);
  assert.equal(created.notification.intervalMs, 300000);
  assert.equal(created.notification.target, "otcantest-gmail-notification-tools");
  assert.equal(updated.ok, true);
  assert.equal(updated.notification.query, "from:alerts@example.com newer_than:1d");
  assert.equal(updated.notification.intervalMs, 900000);
  assert.equal(listed.notifications.length, 1);
  assert.equal(deleted.ok, true);
  assert.deepEqual(after.notifications, []);
});

test("tenant api-agent prompt treats connector setup as user-owned", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-setup-prompt-"));
  const env = await allowSanitizerEnv(home);
  await createThread({
    id: "otcantest-setup-prompt",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);

  const thread = await getThread("otcantest-setup-prompt", env);
  const instructions = await buildTenantApiAgentInstructions(thread, [], env);

  assert.match(instructions, /Connector setup is user-owned by default/i);
  assert.match(instructions, /you can help set it up here/i);
  assert.match(instructions, /do not offer an admin note/i);
  assert.doesNotMatch(instructions, /unless host-level app credentials are missing/i);
});

test("tenant api-agent prompt hides codex escalation when host codex is disabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-codex-disabled-prompt-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_CODEX_BIN: "__orkestr_codex_disabled_public_instance__",
  });
  await createThread({
    id: "otcantest-codex-disabled-prompt",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);

  const thread = await getThread("otcantest-codex-disabled-prompt", env);
  const instructions = await buildTenantApiAgentInstructions(thread, [], env);
  const context = tenantContextFromInstructions(instructions);

  assert.equal(context.capabilities.workspace.executionAvailable, false);
  assert.equal(context.capabilities.workspace.connected, false);
  assert.equal(context.capabilities.workspace.connectionAvailable, false);
  assert.equal(context.capabilities.workspace.actionTool, "");
  assert.equal(Object.hasOwn(context.capabilities, "codexEscalation"), false);
  assert.equal(context.capabilities.webFetch, true);
  assert.match(instructions, /cannot start a workspace worker right now/i);
  assert.doesNotMatch(instructions, /\/codex/i);
  assert.doesNotMatch(instructions, /Codex/);
});

test("tenant api-agent rejects explicit codex escalation when host codex is disabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-codex-disabled-input-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_CODEX_BIN: "__orkestr_codex_disabled_public_instance__",
  });
  await createThread({
    id: "otcantest-codex-disabled-input",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-codex-disabled-input", {
    text: "/codex fetch the top trending topics",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const result = await processApiAgentThreadInput("otcantest-codex-disabled-input", env, {
    fetchImpl: async () => {
      throw new Error("openai_should_not_be_called");
    },
  });
  const messages = await listThreadMessages("otcantest-codex-disabled-input", env);
  const current = messages.find((message) => message.id === input.id);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(result.codexUnavailable, true);
  assert.equal(current.state, "completed");
  assert.equal(current.deliveryState, "api_agent_completed");
  assert.match(assistant.text, /cannot start a workspace worker/i);
  assert.doesNotMatch(assistant.text, /\/codex/i);
  assert.doesNotMatch(assistant.text, /Codex/i);
});

test("tenant api-agent routes missing Gmail status through OpenAI with user-owned setup guidance", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-status-"));
  const env = await allowSanitizerEnv(home);
  await writeConnectorConfig("gmail", {
    clientId: "gmail-client",
    clientSecret: "gmail-secret",
    redirectUri: "http://localhost/oauth/gmail/callback",
  }, env);
  await createThread({
    id: "otcantest-gmail-missing",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-missing", {
    text: "Do you have access to my Gmail?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-gmail-missing", env, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      if (calls.length === 1) {
        return response({
          id: "resp_api_agent_gmail_status_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_connector_status",
            call_id: "call_gmail_status",
            arguments: JSON.stringify({ provider: "gmail" }),
          }],
          usage: { input_tokens: 180, output_tokens: 10 },
        });
      }
      const toolOutput = JSON.parse(calls[1].body.input.at(-1).output);
      assert.equal(toolOutput.provider, "gmail");
      assert.equal(toolOutput.state, "not_connected");
      assert.equal(toolOutput.parentConnector.parentAppConfigured, true);
      return response({
        id: "resp_api_agent_gmail_status_2",
        model: "gpt-5-mini",
        output_text: "Not yet. Gmail is not connected for this chat. I can help you set it up here if you ask me to connect Gmail.",
        output: [],
        usage: { input_tokens: 220, output_tokens: 18 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-missing", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.tools.some((tool) => tool.name === "orkestr_connector_status"), true);
  assert.match(calls[0].body.instructions, /Connector setup is user-owned by default/i);
  assert.match(assistant.text, /not connected for this chat/i);
  assert.match(assistant.text, /set it up here/i);
  assert.doesNotMatch(assistant.text, /Orkestr UI|Orkestr admin|Orkestr administrator|admin note|send your admin/i);
});

test("tenant api-agent formats Gmail status tool output when model falls back generically", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-status-fallback-"));
  const env = await allowSanitizerEnv(home);
  await writeConnectorConfig("gmail", {
    clientId: "gmail-client",
    clientSecret: "gmail-secret",
    redirectUri: "http://localhost/oauth/gmail/callback",
  }, env);
  await createThread({
    id: "otcantest-gmail-status-fallback",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-status-fallback", {
    text: "Is Gmail connected for this chat?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-gmail-status-fallback", env, {
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return response({
          id: "resp_gmail_status_fallback_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_connector_status",
            call_id: "call_gmail_status_fallback",
            arguments: JSON.stringify({ provider: "gmail" }),
          }],
          usage: { input_tokens: 180, output_tokens: 10 },
        });
      }
      const toolOutput = JSON.parse(calls[1].input.at(-1).output);
      assert.equal(toolOutput.provider, "gmail");
      assert.equal(toolOutput.state, "not_connected");
      return response({
        id: "resp_gmail_status_fallback_2",
        model: "gpt-5-mini",
        output_text: GENERIC_TOOL_FALLBACK_TEXT,
        output: [],
        usage: { input_tokens: 220, output_tokens: 18 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-status-fallback", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(assistant.text, /Gmail is not connected for this chat/i);
  assert.match(assistant.text, /start the Gmail sign-in flow|set it up/i);
  assert.doesNotMatch(assistant.text, /without a tool result|Workspace and live browser/i);
});

test("tenant api-agent lets OpenAI start Gmail auth from a connector follow-up", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-followup-auth-"));
  const env = await allowSanitizerEnv(home, {
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-gmail-followup-auth",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await appendThreadMessage("otcantest-gmail-followup-auth", {
    role: "user",
    text: "Do you have access to my Gmail?",
    state: "completed",
  }, env);
  await appendThreadMessage("otcantest-gmail-followup-auth", {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text: "Gmail is not connected or enabled for this chat yet. I can send a sign-in link if you want to connect it.",
    state: "completed",
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-followup-auth", {
    text: "Can you connect to it?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const result = await processApiAgentThreadInput("otcantest-gmail-followup-auth", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.input.some((item) => item.type === "function_call_output")) {
        const toolOutput = JSON.parse(body.input.at(-1).output);
        return response({
          id: "resp_gmail_followup_auth_2",
          model: "gpt-5-mini",
          output_text: `Open this Gmail sign-in link: ${toolOutput.authorizeUrl}`,
          output: [],
          usage: { input_tokens: 220, output_tokens: 8 },
        });
      }
      return response({
        id: "resp_gmail_followup_auth_1",
        model: "gpt-5-mini",
        output_text: "",
        output: [{
          type: "function_call",
          name: "orkestr_start_connector_auth",
          call_id: "call_gmail_followup_auth",
          arguments: JSON.stringify({ provider: "gmail", account: "", shop: "" }),
        }],
        usage: { input_tokens: 180, output_tokens: 12 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-followup-auth", env);
  const assistant = messages.filter((message) => message.role === "assistant").at(-1);
  const savedState = JSON.parse(await fs.readFile(path.join(userDataPaths("otcan", env).oauth, "gmail-state.json"), "utf8"));

  assert.equal(result.ok, true);
  assert.equal(result.processedCount, 1);
  assert.equal(assistant.source, "api-agent");
  assert.match(assistant.text, /Open this Gmail sign-in link: https:\/\/accounts\.google\.com/i);
  assert.doesNotMatch(assistant.text, /platform level|Ask me to connect Gmail|not right now/i);
  assert.equal(savedState.userId, "otcan");
});

test("tenant api-agent asks for Gmail address when testing allowlist requires it", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-allowlist-account-"));
  const env = await allowSanitizerEnv(home, {
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
    GMAIL_OAUTH_APPROVED_TESTERS: "approved@example.com",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-gmail-allowlist-account",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-allowlist-account", {
    text: "Connect Gmail",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  let modelCalls = 0;
  const result = await processApiAgentThreadInput("otcantest-gmail-allowlist-account", env, {
    fetchImpl: async (_url, options = {}) => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return response({
          id: "resp_gmail_allowlist_account_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_start_connector_auth",
            call_id: "call_gmail_allowlist_account",
            arguments: JSON.stringify({ provider: "gmail", account: "", shop: "" }),
          }],
          usage: { input_tokens: 180, output_tokens: 14 },
        });
      }
      const body = JSON.parse(options.body);
      const toolOutput = JSON.parse(body.input.find((item) => item.type === "function_call_output")?.output || "{}");
      assert.equal(toolOutput.error, "gmail_account_required_for_tester_check");
      return response({
        id: "resp_gmail_allowlist_account_2",
        model: "gpt-5-mini",
        output_text: GENERIC_TOOL_FALLBACK_TEXT,
        output: [],
        usage: { input_tokens: 260, output_tokens: 22 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-allowlist-account", env);
  const assistant = messages.filter((message) => message.role === "assistant").at(-1);

  assert.equal(result.ok, true);
  assert.equal(modelCalls, 2);
  assert.match(assistant.text, /Which Gmail address do you want to connect/i);
  assert.doesNotMatch(assistant.text, /accounts\.google\.com|Done\./i);
});

test("tenant api-agent explains Google tester approval failures instead of saying Done", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-access-denied-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-gmail-access-denied",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-access-denied", {
    text: [
      "Access blocked: example-app.example.test has not completed the Google verification process",
      "tester@example.test",
      "The app is currently being tested, and can only be accessed by developer-approved testers.",
      "Error 403: access_denied",
    ].join("\n"),
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  let modelCalls = 0;
  const result = await processApiAgentThreadInput("otcantest-gmail-access-denied", env, {
    fetchImpl: async () => {
      modelCalls += 1;
      return response({
        id: "resp_gmail_access_denied",
        model: "gpt-5-mini",
        output_text: "Gmail sign-in did not complete for tester@example.test. This Google OAuth app is still in testing mode, so that address must be added to the approved Google test-user list before sign-in can work.",
        output: [],
        usage: { input_tokens: 180, output_tokens: 34 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-access-denied", env);
  const assistant = messages.filter((message) => message.role === "assistant").at(-1);

  assert.equal(result.ok, true);
  assert.equal(modelCalls, 1);
  assert.notEqual(assistant.text.trim(), "Done.");
  assert.match(assistant.text, /Gmail sign-in did not complete for tester@example\.test/i);
  assert.match(assistant.text, /approved Google test-user list|Google OAuth test user/i);
  assert.doesNotMatch(assistant.text, /Ask me to connect Gmail|You can connect Gmail/i);
});

test("tenant api-agent lets OpenAI explain missing Gmail app config without admin-note language", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-followup-config-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-gmail-followup-config",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await appendThreadMessage("otcantest-gmail-followup-config", {
    role: "user",
    text: "Do you have access to my Gmail?",
    state: "completed",
  }, env);
  await appendThreadMessage("otcantest-gmail-followup-config", {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text: "Gmail is not connected or enabled for this chat yet. I can send a sign-in link if you want to connect it.",
    state: "completed",
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-followup-config", {
    text: "Can you connect to it?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const result = await processApiAgentThreadInput("otcantest-gmail-followup-config", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.input.some((item) => item.type === "function_call_output")) {
        const toolOutput = JSON.parse(body.input.at(-1).output);
        assert.equal(toolOutput.ok, false);
        assert.equal(toolOutput.error, "gmail_oauth_config_required");
        return response({
          id: "resp_gmail_followup_config_2",
          model: "gpt-5-mini",
          output_text: "Gmail setup is not available on this Orkestr installation yet.",
          output: [],
          usage: { input_tokens: 220, output_tokens: 8 },
        });
      }
      return response({
        id: "resp_gmail_followup_config_1",
        model: "gpt-5-mini",
        output_text: "",
        output: [{
          type: "function_call",
          name: "orkestr_start_connector_auth",
          call_id: "call_gmail_followup_config",
          arguments: JSON.stringify({ provider: "gmail", account: "", shop: "" }),
        }],
        usage: { input_tokens: 180, output_tokens: 12 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-followup-config", env);
  const assistant = messages.filter((message) => message.role === "assistant").at(-1);

  assert.equal(result.ok, true);
  assert.equal(assistant.text, "Gmail setup is not available on this Orkestr installation yet.");
  assert.doesNotMatch(assistant.text, /Ask me to connect Gmail|platform level|not right now|admin note|send your admin/i);
});

test("tenant api-agent formats Gmail auth tool output when model falls back generically", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-auth-fallback-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-gmail-auth-fallback",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-gmail-auth-fallback", {
    text: "Connect Gmail for me.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-gmail-auth-fallback", env, {
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return response({
          id: "resp_gmail_auth_fallback_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_start_connector_auth",
            call_id: "call_gmail_auth_fallback",
            arguments: JSON.stringify({ provider: "gmail", account: "", shop: "" }),
          }],
          usage: { input_tokens: 180, output_tokens: 12 },
        });
      }
      const toolOutput = JSON.parse(calls[1].input.at(-1).output);
      assert.equal(toolOutput.ok, false);
      assert.equal(toolOutput.error, "gmail_oauth_config_required");
      return response({
        id: "resp_gmail_auth_fallback_2",
        model: "gpt-5-mini",
        output_text: GENERIC_TOOL_FALLBACK_TEXT,
        output: [],
        usage: { input_tokens: 220, output_tokens: 8 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-auth-fallback", env);
  const assistant = messages.filter((message) => message.role === "assistant").at(-1);

  assert.equal(result.ok, true);
  assert.match(assistant.text, /Gmail sign-in is not available yet/i);
  assert.match(assistant.text, /parent app configuration is missing/i);
  assert.doesNotMatch(assistant.text, /without a tool result|Workspace and live browser/i);
});

test("tenant api-agent exposes provider verb object action registry", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-action-registry-"));
  const env = await allowSanitizerEnv(home);
  const principal = userPrincipal({ id: "otcan", role: "user" });

  const gmail = await runTenantApiAgentTool("orkestr_list_actions", {
    provider: "gmail",
    verb: "",
    object: "",
  }, { principal }, env);
  const timers = await runTenantApiAgentTool("orkestr_list_actions", {
    provider: "timer",
    verb: "create",
    object: "timer",
  }, { principal }, env);

  assert.equal(gmail.ok, true);
  assert.equal(gmail.actions.some((action) => action.provider === "gmail" && action.verb === "read" && action.object === "message"), true);
  assert.equal(gmail.actions.some((action) => action.provider === "calendar"), false);
  assert.equal(timers.actions.length, 1);
  assert.equal(timers.actions[0].actionKey, "timer.create.timer");
  assert.equal(timers.actions[0].handler, undefined);
});

test("tenant api-agent action router creates timer prompts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-run-action-timer-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const thread = await createThread({
    id: "otcan-run-action-timer",
    ownerUserId: "otcan",
    name: "otcan-run-action-timer",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
  }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });

  const created = await runTenantApiAgentTool("orkestr_run_action", {
    actionKey: "timer.create.timer",
    provider: "",
    verb: "",
    object: "",
    idempotencyKey: "timer-action-test",
    parameters: {
      label: "Action routed reminder",
      targetType: "thread",
      target: "",
      cadence: "once",
      delay: "5m",
      runAt: "",
      time: "",
      timezone: "",
      every: "",
      prompt: "Remind me through the action router.",
      enabled: true,
    },
  }, { principal, thread }, env);

  assert.equal(created.ok, true);
  assert.equal(created.action.actionKey, "timer.create.timer");
  assert.equal(created.handler, "orkestr_create_automation");
  assert.equal(created.timer.target, "otcan-run-action-timer");
  assert.equal(created.timer.prompt, "Remind me through the action router.");
  assert.equal((await listTimers(env)).some((timer) => timer.id === created.timer.id), true);
  await runTenantApiAgentTool("orkestr_run_action", {
    actionKey: "timer.delete.timer",
    provider: "",
    verb: "",
    object: "",
    idempotencyKey: "timer-action-test-delete",
    parameters: { automationId: `timer:${created.timer.id}` },
  }, { principal, thread }, env);
});

test("tenant api-agent action router accepts JSON string parameters from model tools", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-run-action-json-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const thread = await createThread({
    id: "otcan-run-action-json",
    ownerUserId: "otcan",
    name: "otcan-run-action-json",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
  }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });

  const created = await runTenantApiAgentTool("orkestr_run_action", {
    actionKey: "timer.create.timer",
    provider: "",
    verb: "",
    object: "",
    idempotencyKey: "timer-action-json-test",
    parameters: JSON.stringify({
      label: "JSON action routed reminder",
      targetType: "thread",
      target: "",
      cadence: "once",
      delay: "5m",
      prompt: "Remind me through JSON action parameters.",
      enabled: true,
    }),
  }, { principal, thread }, env);

  assert.equal(created.ok, true);
  assert.equal(created.timer.target, "otcan-run-action-json");
  assert.equal(created.timer.prompt, "Remind me through JSON action parameters.");
  await runTenantApiAgentTool("orkestr_run_action", {
    actionKey: "timer.delete.timer",
    provider: "",
    verb: "",
    object: "",
    idempotencyKey: "timer-action-json-test-delete",
    parameters: JSON.stringify({ automationId: `timer:${created.timer.id}` }),
  }, { principal, thread }, env);
});

test("tenant api-agent generic automation tools manage timer prompts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-automation-timer-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcan-automation-timer",
    ownerUserId: "otcan",
    name: "otcan-automation-timer",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-automation-timer", outboundAccountId: "wa-1" },
  }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });
  const thread = await getThread("otcan-automation-timer", env);

  const created = await runTenantApiAgentTool("orkestr_create_automation", {
    type: "timer",
    provider: "timer",
    label: "Daily Gmail check",
    targetType: "thread",
    target: "",
    cadence: "interval",
    delay: "",
    runAt: "",
    time: "",
    timezone: "Europe/Istanbul",
    every: "1h",
    prompt: "Check Gmail and summarize new important mail.",
    promptTemplate: "",
    query: "",
    maxItemsPerRun: 0,
    enabled: true,
    allowBroadQuery: false,
  }, { principal, thread }, env);
  const automationId = created.automation.automationId;
  const listed = await runTenantApiAgentTool("orkestr_list_automations", {}, { principal, thread }, env);
  const paused = await runTenantApiAgentTool("orkestr_pause_automation", {
    automationId,
    type: "",
  }, { principal, thread }, env);
  const resumed = await runTenantApiAgentTool("orkestr_resume_automation", {
    automationId,
    type: "",
  }, { principal, thread }, env);
  const updated = await runTenantApiAgentTool("orkestr_update_automation", {
    automationId,
    type: "",
    label: "Hourly Gmail check",
    targetType: "",
    target: "",
    cadence: "",
    delay: "",
    runAt: "",
    time: "",
    timezone: "",
    every: "2h",
    prompt: "",
    promptTemplate: "",
    query: "",
    maxItemsPerRun: 0,
    enabled: "true",
    allowBroadQuery: "",
    noReplyBehavior: "",
  }, { principal, thread }, env);
  const run = await runTenantApiAgentTool("orkestr_run_automation", {
    automationId,
    type: "",
    force: false,
    sourceItemsJson: "[]",
  }, { principal, thread }, env);
  const actionPaused = await runTenantApiAgentTool("orkestr_run_action", {
    actionKey: "timer.pause.timer",
    provider: "",
    verb: "",
    object: "",
    idempotencyKey: "timer-action-pause",
    parameters: { automationId },
  }, { principal, thread }, env);
  const actionResumed = await runTenantApiAgentTool("orkestr_run_action", {
    actionKey: "timer.resume.timer",
    provider: "",
    verb: "",
    object: "",
    idempotencyKey: "timer-action-resume",
    parameters: { automationId },
  }, { principal, thread }, env);
  const doctor = await runTenantApiAgentTool("orkestr_run_action", {
    actionKey: "automation.doctor.automation",
    provider: "",
    verb: "",
    object: "",
    idempotencyKey: "timer-action-doctor",
    parameters: {},
  }, { principal, thread }, env);
  const deleted = await runTenantApiAgentTool("orkestr_delete_automation", {
    automationId,
    type: "",
  }, { principal, thread }, env);

  assert.equal(created.ok, true);
  assert.match(automationId, /^timer:/);
  assert.equal(created.automation.target, "otcan-automation-timer");
  assert.equal(listed.automations.some((automation) => automation.automationId === automationId), true);
  assert.equal(paused.automation.enabled, false);
  assert.equal(resumed.automation.enabled, true);
  assert.equal(updated.automation.label, "Hourly Gmail check");
  assert.equal(updated.automation.schedule.every, "2h");
  assert.equal(updated.automation.prompt, "Check Gmail and summarize new important mail.");
  assert.equal(run.ok, true);
  assert.equal(run.event.target, "otcan-automation-timer");
  assert.equal(actionPaused.handler, "orkestr_pause_automation");
  assert.equal(actionPaused.automation.enabled, false);
  assert.equal(actionResumed.handler, "orkestr_resume_automation");
  assert.equal(actionResumed.automation.enabled, true);
  assert.equal(doctor.handler, "orkestr_doctor_automations");
  assert.equal(doctor.counts.total, 1);
  assert.equal(deleted.ok, true);
  assert.equal((await listTimers(env)).length, 0);
});

test("tenant api-agent pauses a Gmail watch through the generic action router", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-pause-gmail-watch-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const paths = userDataPaths("otcan", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({
    accessToken: "pause-gmail-watch-access",
    refreshToken: "pause-gmail-watch-refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }), "utf8");
  await createThread({
    id: "otcan-pause-gmail-watch",
    ownerUserId: "otcan",
    name: "otcan-pause-gmail-watch",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-pause-gmail-watch", outboundAccountId: "wa-1" },
  }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });
  const thread = await getThread("otcan-pause-gmail-watch", env);
  const created = await runTenantApiAgentTool("orkestr_run_action", {
    actionKey: "gmail.watch.notification",
    provider: "",
    verb: "",
    object: "",
    idempotencyKey: "create-pause-watch",
    parameters: {
      label: "Pause test Gmail watch",
      query: "is:unread newer_than:1d",
      interval: "5m",
      targetType: "thread",
      target: "",
      maxItemsPerRun: 1,
      enabled: true,
      allowBroadQuery: false,
    },
  }, { principal, thread }, env);
  await enqueueThreadInputForPrincipal("otcan-pause-gmail-watch", {
    text: "Pause my Gmail watch for now.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-pause-gmail-watch",
    accountId: "wa-1",
  }, principal, env);

  const openAiCalls = [];
  const result = await processApiAgentThreadInput("otcan-pause-gmail-watch", env, {
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      openAiCalls.push(body);
      if (openAiCalls.length === 1) {
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_list_actions"), true);
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_run_action"), true);
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_update_gmail_notification"), false);
        return response({
          id: "resp_pause_gmail_watch_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_run_action",
            call_id: "call_pause_gmail_watch",
            arguments: JSON.stringify({
              actionKey: "gmail.pause.notification",
              provider: "",
              verb: "",
              object: "",
              idempotencyKey: "pause-gmail-watch",
              parameters: {
                automationId: created.automation.automationId,
              },
            }),
          }],
          usage: { input_tokens: 320, output_tokens: 14 },
        });
      }
      const toolOutput = JSON.parse(body.input.at(-1).output);
      assert.equal(toolOutput.handler, "orkestr_pause_automation");
      assert.equal(toolOutput.result.automation.enabled, false);
      return response({
        id: "resp_pause_gmail_watch_2",
        model: "gpt-5-mini",
        output_text: "Paused the Gmail watch.",
        output: [],
        usage: { input_tokens: 360, output_tokens: 8 },
      });
    },
  });
  const listed = await runTenantApiAgentTool("orkestr_list_automations", {}, { principal, thread }, env);
  const paused = listed.automations.find((automation) => automation.automationId === created.automation.automationId);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 2);
  assert.equal(paused.enabled, false);
});

test("tenant api-agent drains queued tenant messages while it owns the lock", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-drain-"));
  const env = await allowSanitizerEnv(home);
  await createThread({
    id: "otcan-drain",
    ownerUserId: "otcan",
    name: "otcan-drain",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-drain", outboundAccountId: "wa-1" },
  }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await enqueueThreadInputForPrincipal("otcan-drain", {
    text: "first",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-drain",
  }, principal, env);
  await enqueueThreadInputForPrincipal("otcan-drain", {
    text: "second",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-drain",
  }, principal, env);

  let call = 0;
  const result = await processApiAgentThreadInput("otcan-drain", env, {
    fetchImpl: async () => response({
      id: `resp_api_agent_drain_${++call}`,
      model: "gpt-5-mini",
      output_text: call === 1 ? "First answer" : "Second answer",
      output: [],
      usage: { input_tokens: 80, output_tokens: 8 },
    }),
  });
  const messages = await listThreadMessages("otcan-drain", env);

  assert.equal(result.processedCount, 2);
  assert.equal(call, 2);
  assert.deepEqual(messages.filter((message) => message.role === "user").map((message) => message.state), ["completed", "completed"]);
  assert.deepEqual(messages.filter((message) => message.role === "assistant").map((message) => message.text), ["First answer", "Second answer"]);
});

test("due timers drain through api-agent threads and retain WhatsApp binding", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-timer-drain-"));
  const env = await allowSanitizerEnv(home);
  await createThread({
    id: "otcan-timer",
    ownerUserId: "otcan",
    name: "otcan-timer",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-timer", outboundAccountId: "wa-1" },
  }, env);
  await createTimer({
    ownerUserId: "otcan",
    label: "Timer drain",
    targetType: "thread",
    target: "otcan-timer",
    prompt: "reply exactly timer fired",
    cadence: "interval",
    every: "1m",
  }, env);
  const timers = await listTimers(env);
  timers[0].nextRunAt = "2020-01-01T00:00:00.000Z";
  await fs.writeFile(path.join(home, "timers.json"), `${JSON.stringify(timers, null, 2)}\n`);

  const due = await markDueTimers(env, new Date("2026-05-15T10:00:00.000Z"));
  let messages = await listThreadMessages("otcan-timer", env);
  const timerInput = messages.find((message) => message.source === "timer_due");
  assert.equal(due.length, 1);
  assert.equal(timerInput?.connector, "whatsapp");
  assert.equal(timerInput?.chatId, "chat-timer");
  assert.equal(timerInput?.accountId, "wa-1");
  assert.equal(timerInput?.state, "queued");

  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => response({
    id: "resp_api_agent_timer_drain",
    model: "gpt-5-mini",
    output_text: "timer fired",
    output: [],
    usage: { input_tokens: 80, output_tokens: 5 },
  });
  try {
    const drained = await drainAllPendingThreadInputs(env);
    messages = await listThreadMessages("otcan-timer", env);
    const completedInput = messages.find((message) => message.id === timerInput.id);
    const assistant = messages.find((message) => message.role === "assistant" && message.parentMessageId === timerInput.id);

    assert.deepEqual(drained, [{ threadId: "otcan-timer", delivered: [timerInput.id] }]);
    assert.equal(completedInput?.state, "completed");
    assert.equal(assistant?.text, "timer fired");
    assert.equal(assistant?.connector, "whatsapp");
    assert.equal(assistant?.chatId, "chat-timer");
    assert.equal(assistant?.accountId, "wa-1");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("WhatsApp auto-provisioned tenant threads default to api-agent runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-auto-"));
  const env = await allowSanitizerEnv(home, { ORKESTR_WHATSAPP_AUTO_PROVISION_USERS: "1" });
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    autoProvisionUsers: true,
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "auto-api-agent-1",
    chatId: "chat-auto-api",
    accountId: "main",
    from: "wa-contact-sample@c.us",
    chatName: "otcantest",
    text: "hello",
  }, env);
  const thread = await getThread(routed.threadId, env);

  assert.equal(routed.autoProvisioned, true);
  assert.equal(thread.runtimeKind, "api-agent");
  assert.equal(thread.executor.type, "api-agent");
  assert.equal(threadUsesApiAgent(thread, env), true);
});

test("WhatsApp routing cleans mixed tenant Codex runtime state before enqueueing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-mixed-"));
  const env = await allowSanitizerEnv(home, { ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0" });
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
  }, env);
  await createThread({
    id: "otcantest",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "codex-app-server",
    codexThreadId: "codex-thread-stale",
    codexSessionId: "codex-session-stale",
    codexTokenUsage: { total: { totalTokens: 1000 } },
    runtime: {
      runtimeKind: "codex-app-server",
      state: "ready",
      codexThreadId: "codex-thread-stale",
      codexSessionId: "codex-session-stale",
    },
    executorId: "api-agent",
    executor: {
      id: "codex",
      type: "codex",
      transport: "app-server",
      codexThreadId: "codex-thread-stale",
      codexSessionId: "codex-session-stale",
      metadata: {
        runtimeKind: "api-agent",
        transport: "app-server",
        codexModel: "gpt-5.5",
        codexModelProvider: "openai",
        codexApprovalPolicy: "never",
        codexThreadId: "codex-thread-stale",
        codexSessionId: "codex-session-stale",
      },
    },
    binding: {
      connector: "whatsapp",
      chatId: "chat-mixed",
      displayName: "otcantest",
      generated: true,
      mirrorToWhatsApp: true,
    },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "mixed-api-agent-1",
    chatId: "chat-mixed",
    accountId: "wa-1",
    from: "wa-contact-sample@c.us",
    text: "hello",
  }, env);
  const thread = await getThread("otcantest", env);
  const messages = await listThreadMessages("otcantest", env);

  assert.equal(routed.threadId, "otcantest");
  assert.equal(thread.runtimeKind, "api-agent");
  assert.equal(thread.runtime, null);
  assert.equal(thread.codexThreadId, null);
  assert.equal(thread.codexSessionId, null);
  assert.equal(thread.codexTokenUsage, null);
  assert.equal(thread.executorId, "api-agent");
  assert.equal(thread.executor.id, "api-agent");
  assert.equal(thread.executor.type, "api-agent");
  assert.equal(thread.executor.transport, "api-agent");
  assert.equal(thread.executor.codexThreadId, null);
  assert.equal(thread.executor.codexSessionId, null);
  assert.equal(thread.executor.metadata.runtimeKind, "api-agent");
  assert.equal(thread.executor.metadata.transport, "api-agent");
  assert.equal(thread.executor.metadata.codexModel, undefined);
  assert.equal(thread.executor.metadata.codexModelProvider, undefined);
  assert.equal(thread.executor.metadata.codexApprovalPolicy, "on-request");
  assert.equal(thread.executor.metadata.codexThreadId, null);
  assert.equal(threadUsesApiAgent(thread, env), true);
  assert.equal(messages[0].state, "queued");
  assert.equal(messages[0].deliveryState || "", "waiting_runtime_ready");
  assert.equal(initialQueueDeliveryState({ runtimeKind: "api-agent", state: "queued" }, messages[0]), "waiting_runtime_ready");
});

test("WhatsApp routing cleans stale api-agent tmux runtime metadata before enqueueing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-stale-runtime-"));
  const env = await allowSanitizerEnv(home, { ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0" });
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
  }, env);
  await createThread({
    id: "otcantest",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    runtime: {
      runtimeKind: "codex-tmux",
      sessionName: "orkestr-otcantest",
      paneId: "%1030",
      state: "ready",
    },
    codexThreadId: "stale-codex-thread",
    codexSessionId: "stale-codex-session",
    codexTokenUsage: { total: { totalTokens: 1000 } },
    executorId: "api-agent",
    executor: {
      id: "api-agent",
      type: "api-agent",
      transport: "api-agent",
      codexThreadId: "stale-codex-thread",
      codexSessionId: "stale-codex-session",
      sessionName: "orkestr-otcantest",
      tmuxTarget: "%1030",
      metadata: {
        runtimeKind: "api-agent",
        transport: "api-agent",
        codexThreadId: "stale-codex-thread",
        codexSessionId: "stale-codex-session",
        codexTokenUsage: { total: { totalTokens: 1000 } },
      },
    },
    binding: {
      connector: "whatsapp",
      chatId: "chat-stale-api-agent",
      displayName: "otcantest",
      generated: true,
      mirrorToWhatsApp: true,
    },
  }, env);
  await fs.writeFile(path.join(home, "runtime-leases.json"), JSON.stringify([
    {
      id: "stale-runtime-lease",
      threadId: "otcantest",
      sessionName: "orkestr-otcantest",
      paneId: "%1030",
      reason: "whatsapp_inbound",
    },
  ], null, 2) + "\n", "utf8");

  const routed = await routeWhatsAppInbound({
    eventId: "stale-api-agent-1",
    chatId: "chat-stale-api-agent",
    accountId: "wa-1",
    from: "wa-contact-sample@c.us",
    text: "hello",
  }, env);
  const thread = await getThread("otcantest", env);
  const leases = JSON.parse(await fs.readFile(path.join(home, "runtime-leases.json"), "utf8"));

  assert.equal(routed.threadId, "otcantest");
  assert.equal(thread.runtimeKind, "api-agent");
  assert.equal(thread.runtime, null);
  assert.equal(thread.codexThreadId, null);
  assert.equal(thread.codexSessionId, null);
  assert.equal(thread.codexTokenUsage, null);
  assert.equal(thread.executor.codexThreadId, null);
  assert.equal(thread.executor.codexSessionId, null);
  assert.equal(thread.executor.sessionName, null);
  assert.equal(thread.executor.tmuxTarget, null);
  assert.equal(thread.executor.metadata.codexThreadId, null);
  assert.equal(thread.executor.metadata.codexSessionId, null);
  assert.equal(thread.executor.metadata.codexTokenUsage, null);
  assert.equal(leases[0].endedAt && typeof leases[0].endedAt === "string", true);
  assert.equal(leases[0].endReason, "api_agent_thread_normalized");
  assert.equal(threadUsesApiAgent(thread, env), true);
});

test("tenant api-agent fails closed when credit budget is exhausted", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-budget-"));
  const env = await allowSanitizerEnv(home, { ORKESTR_API_AGENT_DAILY_BUDGET_USD: "0" });
  await createThread({
    id: "budget-chat",
    ownerUserId: "otcan",
    name: "budget-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-budget" },
  }, env);
  await enqueueThreadInputForPrincipal("budget-chat", {
    text: "hi",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-budget",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const result = await processApiAgentThreadInput("budget-chat", env, {
    fetchImpl: async () => {
      throw new Error("openai should not be called");
    },
  });
  const messages = await listThreadMessages("budget-chat", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, false);
  assert.match(assistant.text, /usage budget/i);
  assert.equal(messages.find((message) => message.role === "user").state, "failed");
});

test("tenant api-agent creates user skills through sanitized chat tools", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-skill-tools-"));
  const sanitizerLog = path.join(home, "sanitizer-actions.jsonl");
  const script = path.join(home, "skill-tool-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "import fs from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input);",
      `  fs.appendFileSync(${JSON.stringify(sanitizerLog)}, JSON.stringify({ action: payload.action, input: payload.input }) + '\\n');`,
      "  console.log(JSON.stringify({ allow: true, reason: 'skill-tool-ok', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ORKESTR_HOME: home,
    OPENAI_API_KEY: "sk-test",
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "skill-chat",
    ownerUserId: "otcan",
    name: "skill-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-skill" },
  }, env);
  await enqueueThreadInputForPrincipal("skill-chat", {
    text: "Add a CRM helper skill for my own HubSpot process.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-skill",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("skill-chat", env, {
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return response({
          id: "resp_skill_tool_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_create_skill",
            call_id: "call_skill_create",
            arguments: JSON.stringify({
              name: "CRM helper",
              description: "Help this user with their own CRM workflow.",
              instructions: "Use only CRM accounts connected by this user.",
              enabled: true,
            }),
          }],
          usage: { input_tokens: 180, output_tokens: 12 },
        });
      }
      return response({
        id: "resp_skill_tool_2",
        model: "gpt-5-mini",
        output_text: "CRM helper is enabled for this chat.",
        output: [],
        usage: { input_tokens: 220, output_tokens: 8 },
      });
    },
  });
  const messages = await listThreadMessages("skill-chat", env);
  const listed = await runTenantApiAgentTool("orkestr_list_skills", {}, { principal: userPrincipal({ id: "otcan", role: "user" }) }, env);
  const sanitizerActions = (await fs.readFile(sanitizerLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).action);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(messages.find((message) => message.role === "assistant").text, "CRM helper is enabled for this chat.");
  assert.equal(listed.skills.some((skill) => skill.id === "crm-helper" && skill.createdBy === "chat"), true);
  assert.equal(sanitizerActions.includes("thread.input"), true);
  assert.equal(sanitizerActions.includes("api-agent.input"), true);
  assert.equal(sanitizerActions.includes("api-agent.tool.orkestr_create_skill"), true);
});

test("tenant api-agent lets OpenAI initiate explicit Gmail sign-in with connector auth tool", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-auth-flow-"));
  const sanitizerLog = path.join(home, "auth-tool-sanitizer.jsonl");
  const script = path.join(home, "auth-tool-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "import fs from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input);",
      `  fs.appendFileSync(${JSON.stringify(sanitizerLog)}, JSON.stringify({ action: payload.action, input: payload.input }) + '\\n');`,
      "  console.log(JSON.stringify({ allow: true, reason: 'auth-tool-ok', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ORKESTR_HOME: home,
    OPENAI_API_KEY: "sk-test",
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "gmail-auth-chat",
    ownerUserId: "otcan",
    name: "gmail-auth-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-gmail-auth" },
  }, env);
  await enqueueThreadInputForPrincipal("gmail-auth-chat", {
    text: "Connect my Gmail account person@example.com",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-gmail-auth",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("gmail-auth-chat", env, {
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return response({
          id: "resp_gmail_auth_tool_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_start_connector_auth",
            call_id: "call_gmail_auth",
            arguments: JSON.stringify({
              provider: "gmail",
              account: "person@example.com",
              shop: "",
            }),
          }],
          usage: { input_tokens: 180, output_tokens: 12 },
        });
      }
      const toolOutput = JSON.parse(calls[1].input.at(-1).output);
      return response({
        id: "resp_gmail_auth_tool_2",
        model: "gpt-5-mini",
        output_text: `Open this Gmail sign-in link: ${toolOutput.authorizeUrl}`,
        output: [],
        usage: { input_tokens: 220, output_tokens: 8 },
      });
    },
  });
  const messages = await listThreadMessages("gmail-auth-chat", env);
  const assistant = messages.find((message) => message.role === "assistant");
  const savedState = JSON.parse(await fs.readFile(path.join(userDataPaths("otcan", env).oauth, "gmail-state.json"), "utf8"));
  const identities = await readUserPrivateIdentities("otcan", env);
  const sanitizerActions = (await fs.readFile(sanitizerLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).action);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tools.some((tool) => tool.name === "orkestr_start_connector_auth"), true);
  assert.match(calls[0].instructions, /Connector setup is user-owned by default/i);
  assert.match(assistant.text, /accounts\.google\.com/i);
  assert.doesNotMatch(assistant.text, /admin note|send your admin/i);
  assert.equal(savedState.userId, "otcan");
  assert.equal(savedState.account, "person@example.com");
  assert.equal(identities.some((identity) => identity.provider === "gmail" && identity.externalId === "person@example.com"), true);
  assert.equal(sanitizerActions.includes("api-agent.tool.orkestr_start_connector_auth"), true);
});

test("tenant api-agent reads scoped Gmail directly without repeated confirmation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-read-"));
  const sanitizerLog = path.join(home, "gmail-read-sanitizer.jsonl");
  const script = path.join(home, "gmail-read-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "import fs from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input);",
      `  fs.appendFileSync(${JSON.stringify(sanitizerLog)}, JSON.stringify({ action: payload.action, principal: payload.principal, capabilities: payload.resource?.capabilities }) + '\\n');`,
      "  console.log(JSON.stringify({ allow: true, reason: 'gmail-read-ok', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "otcan",
    OPENAI_API_KEY: "sk-test",
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const paths = userDataPaths("otcan", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({
    accessToken: "user-scoped-access-token",
    refreshToken: "user-scoped-refresh-token",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }), "utf8");
  await createThread({
    id: "gmail-read-chat",
    ownerUserId: "otcan",
    name: "gmail-read-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-gmail-read" },
  }, env);
  await enqueueThreadInputForPrincipal("gmail-read-chat", {
    text: "Summarize my latest Gmail message",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-gmail-read",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const openAiCalls = [];
  const gmailCalls = [];
  const result = await processApiAgentThreadInput("gmail-read-chat", env, {
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === "api.openai.com") {
        openAiCalls.push(JSON.parse(options.body));
        if (openAiCalls.length === 1) {
          return response({
            id: "resp_gmail_read_1",
            model: "gpt-5-mini",
            output_text: "",
            output: [{
              type: "function_call",
              name: "orkestr_run_action",
              call_id: "call_gmail_read_latest",
              arguments: JSON.stringify({
                actionKey: "gmail.read.latest_message",
                provider: "",
                verb: "",
                object: "",
                idempotencyKey: "gmail-read-latest",
                parameters: { query: "" },
              }),
            }],
            usage: { input_tokens: 220, output_tokens: 16 },
          });
        }
        const toolOutput = JSON.parse(openAiCalls[1].input.at(-1).output);
        assert.equal(toolOutput.message.subject, "Project update");
        assert.match(toolOutput.message.text, /The project is ready for review/);
        return response({
          id: "resp_gmail_read_2",
          model: "gpt-5-mini",
          output_text: "Latest Gmail: Project update from Alex. The project is ready for review.",
          output: [],
          usage: { input_tokens: 260, output_tokens: 15 },
        });
      }
      if (parsed.hostname === "gmail.googleapis.com") {
        gmailCalls.push({ url: parsed, authorization: options.headers?.authorization || "" });
        assert.equal(options.headers.authorization, "Bearer user-scoped-access-token");
        if (parsed.pathname.endsWith("/messages")) {
          return response({ messages: [{ id: "msg-1" }], resultSizeEstimate: 1 });
        }
        if (parsed.pathname.endsWith("/messages/msg-1")) {
          return response({
            id: "msg-1",
            threadId: "thread-1",
            labelIds: ["INBOX"],
            snippet: "The project is ready for review.",
            internalDate: "1780270000000",
            payload: {
              headers: [
                { name: "Subject", value: "Project update" },
                { name: "From", value: "Alex <alex@example.com>" },
                { name: "To", value: "Otcantest <otcantest@example.com>" },
                { name: "Date", value: "Mon, 1 Jun 2026 09:00:00 +0200" },
              ],
              mimeType: "text/plain",
              body: { data: Buffer.from("The project is ready for review.", "utf8").toString("base64url") },
            },
          });
        }
      }
      throw new Error(`unexpected_fetch_${url}`);
    },
  });
  const messages = await listThreadMessages("gmail-read-chat", env);
  const assistant = messages.find((message) => message.role === "assistant");
  const sanitizerEvents = (await fs.readFile(sanitizerLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 2);
  assert.equal(openAiCalls[0].tools.some((tool) => tool.name === "orkestr_run_action"), true);
  assert.equal(openAiCalls[0].tools.some((tool) => tool.name === "orkestr_read_latest_gmail_message"), false);
  assert.match(openAiCalls[0].instructions, /user's request is consent/i);
  assert.equal(gmailCalls.length, 2);
  assert.equal(sanitizerEvents.some((event) =>
    event.action === "api-agent.tool.orkestr_run_action" &&
    event.principal?.role === "user" &&
    event.capabilities?.gmail === true
  ), true);
  assert.match(assistant.text, /Project update/);
  assert.doesNotMatch(assistant.text, /confirm|proceed|permission/i);
});

test("tenant api-agent uses Gmail prompt-push message id for follow-up actions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-push-followup-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_ADMIN_USER_ID: "otcan",
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const paths = userDataPaths("otcan", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({
    accessToken: "user-push-followup-token",
    refreshToken: "user-push-followup-refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }), "utf8");
  await createThread({
    id: "gmail-push-followup-chat",
    ownerUserId: "otcan",
    name: "gmail-push-followup-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-gmail-push-followup" },
  }, env);
  await appendThreadMessage("gmail-push-followup-chat", {
    role: "user",
    source: "connector_prompt_push",
    connector: "gmail",
    originSurface: "gmail",
    externalId: "paypal-msg-1",
    chatId: "chat-gmail-push-followup",
    state: "completed",
    text: [
      "New Gmail message",
      "From: PayPal <service@paypal.de>",
      "Subject: Receipt for Your Payment to LimeBike Germany Gmb...",
      "Date: Thu, 04 Jun 2026 06:48:39 -0700",
      "Snippet: You paid 0.99 EUR to LimeBike Germany Gmb.",
    ].join("\n"),
  }, env);
  await enqueueThreadInputForPrincipal("gmail-push-followup-chat", {
    text: "Can I cancel this subscription? Can you help me about that?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-gmail-push-followup",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const openAiCalls = [];
  const gmailCalls = [];
  const gmailToolOutputs = [];
  const result = await processApiAgentThreadInput("gmail-push-followup-chat", env, {
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === "api.openai.com") {
        const body = JSON.parse(options.body);
        openAiCalls.push(body);
        if (openAiCalls.length === 1) {
          assert.match(body.instructions, /Recent Gmail notification context/i);
          assert.match(body.instructions, /paypal-msg-1/);
          assert.match(body.input.find((item) => item.content?.includes("Receipt for Your Payment"))?.content || "", /Private connector context/);
          assert.equal(body.input.some((item) => item.type === "function_call" && item.name === "orkestr_read_gmail_message"), false);
          return response({
            id: "resp_gmail_push_followup_1",
            model: "gpt-5-mini",
            output_text: "",
            output: [{
              type: "function_call",
              name: "orkestr_read_gmail_message",
              call_id: "call_gmail_push_followup_read",
              arguments: JSON.stringify({ messageId: "paypal-msg-1" }),
            }],
            usage: { input_tokens: 430, output_tokens: 18 },
          });
        }
        gmailToolOutputs.push(JSON.parse(body.input.find((item) => item.type === "function_call_output")?.output || "{}"));
        return response({
          id: "resp_gmail_push_followup_2",
          model: "gpt-5-mini",
          output_text: "I read the Gmail message. It looks like a single Lime ride receipt for 0.99 EUR, not a subscription: the message says it is a payment to LimeBike Germany Gmb and does not show a recurring billing agreement. I did not cancel, send, delete, archive, or modify anything.",
          output: [],
          usage: { input_tokens: 520, output_tokens: 54 },
        });
      }
      if (parsed.hostname === "gmail.googleapis.com") {
        gmailCalls.push(parsed.pathname);
        assert.equal(options.headers.authorization, "Bearer user-push-followup-token");
        if (parsed.pathname.endsWith("/messages/paypal-msg-1")) {
          return response({
            id: "paypal-msg-1",
            threadId: "paypal-thread-1",
            labelIds: ["INBOX"],
            snippet: "You paid 0.99 EUR to LimeBike Germany Gmb.",
            internalDate: "1780577319000",
            payload: {
              headers: [
                { name: "Subject", value: "Receipt for Your Payment to LimeBike Germany Gmb..." },
                { name: "From", value: "PayPal <service@paypal.de>" },
                { name: "To", value: "Otcan <otcan@example.com>" },
                { name: "Date", value: "Thu, 04 Jun 2026 06:48:39 -0700" },
              ],
              mimeType: "text/plain",
              body: { data: Buffer.from("This is a single Lime ride receipt. No recurring subscription or billing agreement link is shown.", "utf8").toString("base64url") },
            },
          });
        }
      }
      throw new Error(`unexpected_fetch_${url}`);
    },
  });
  const messages = await listThreadMessages("gmail-push-followup-chat", env);
  const assistant = messages.filter((message) => message.role === "assistant").at(-1);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 3);
  assert.deepEqual(gmailCalls, ["/gmail/v1/users/me/messages/paypal-msg-1"]);
  assert.equal(gmailToolOutputs[0].message.subject, "Receipt for Your Payment to LimeBike Germany Gmb...");
  assert.match(gmailToolOutputs[0].message.text, /single Lime ride receipt/i);
  assert.match(assistant.text, /I read the Gmail message/i);
  assert.match(assistant.text, /single Lime ride receipt/i);
  assert.match(assistant.text, /I did not cancel, send, delete, archive, or modify anything/i);
  assert.doesNotMatch(assistant.text, /next step is to read the full email/i);
  assert.doesNotMatch(assistant.text, /Tell me what you want|workspace execution|\/codex/i);
});

test("tenant api-agent does not let stale Gmail context override notification requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-context-notification-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_ADMIN_USER_ID: "otcan",
    ORKESTR_GMAIL_NOTIFICATIONS_ENABLED: "1",
    ORKESTR_GMAIL_NOTIFICATION_MIN_INTERVAL_MS: "300000",
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const paths = userDataPaths("otcan", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({
    accessToken: "user-context-notification-token",
    refreshToken: "user-context-notification-refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }), "utf8");
  await createThread({
    id: "gmail-context-notification-chat",
    ownerUserId: "otcan",
    name: "gmail-context-notification-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-gmail-context-notification" },
  }, env);
  await appendThreadMessage("gmail-context-notification-chat", {
    role: "user",
    source: "connector_prompt_push",
    connector: "gmail",
    originSurface: "gmail",
    externalId: "stale-gmail-msg-1",
    chatId: "chat-gmail-context-notification",
    state: "completed",
    text: [
      "New Gmail message",
      "From: Alerts <alerts@example.com>",
      "Subject: Previous alert",
      "Date: Thu, 04 Jun 2026 06:00:00 -0700",
      "Snippet: A previous Gmail alert.",
    ].join("\n"),
  }, env);
  await enqueueThreadInputForPrincipal("gmail-context-notification-chat", {
    text: "Can you send me a message here whenever I receive a Gmail mail?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-gmail-context-notification",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const openAiCalls = [];
  const result = await processApiAgentThreadInput("gmail-context-notification-chat", env, {
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.hostname, "api.openai.com");
      const body = JSON.parse(options.body);
      openAiCalls.push(body);
      if (openAiCalls.length === 1) {
        assert.match(body.instructions, /Recent Gmail notification context/i);
        assert.match(body.instructions, /stale-gmail-msg-1/);
        assert.match(body.instructions, /Do not let this stale Gmail context override/i);
        assert.equal(body.input.some((item) => item.type === "function_call" && item.name === "orkestr_read_gmail_message"), false);
        return response({
          id: "resp_gmail_context_notification_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_create_gmail_notification",
            call_id: "call_gmail_context_notification",
            arguments: JSON.stringify({
              label: "Gmail message notifications",
              query: "",
              interval: "1m",
              targetType: "thread",
              target: "",
              maxItemsPerRun: 1,
              enabled: true,
              allowBroadQuery: false,
            }),
          }],
          usage: { input_tokens: 360, output_tokens: 22 },
        });
      }
      const toolOutput = JSON.parse(body.input.find((item) => item.type === "function_call_output")?.output || "{}");
      assert.equal(toolOutput.ok, true);
      assert.equal(toolOutput.notification.target, "gmail-context-notification-chat");
      return response({
        id: "resp_gmail_context_notification_2",
        model: "gpt-5-mini",
        output_text: "Gmail notification created. I will message this chat when new matching Gmail arrives.",
        output: [],
        usage: { input_tokens: 420, output_tokens: 18 },
      });
    },
  });
  const messages = await listThreadMessages("gmail-context-notification-chat", env);
  const assistant = messages.filter((message) => message.role === "assistant").at(-1);
  const notifications = await listGmailNotificationsForPrincipal(userPrincipal({ id: "otcan", role: "user" }), env);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 2);
  assert.equal(notifications.length, 1);
  assert.match(assistant.text, /Gmail notification created/i);
  assert.doesNotMatch(assistant.text, /Previous alert|read the Gmail message|subscription/i);
});

test("tenant api-agent keeps Gmail prompt-push notification useful when model stays generic", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-push-fallback-"));
  const env = await allowSanitizerEnv(home);
  await createThread({
    id: "gmail-push-fallback-chat",
    ownerUserId: "otcan",
    name: "gmail-push-fallback-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-gmail-push-fallback" },
  }, env);
  await enqueueThreadInputForPrincipal("gmail-push-fallback-chat", {
    text: [
      "New Gmail message",
      "From: Alerts <alerts@example.com>",
      "Subject: Server receipt",
      "Date: Thu, 04 Jun 2026 14:00:00 +0000",
      "Snippet: Receipt preview only.",
    ].join("\n"),
    source: "connector_prompt_push",
    connector: "gmail",
    originSurface: "gmail",
    externalId: "gmail-msg-fallback-1",
    chatId: "chat-gmail-push-fallback",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  let modelCall = 0;
  const result = await processApiAgentThreadInput("gmail-push-fallback-chat", env, {
    fetchImpl: async (_url, options = {}) => {
      modelCall += 1;
      const body = JSON.parse(options.body);
      if (body.input.some((item) => item.content?.includes("Server receipt"))) {
        assert.match(body.instructions, /structured Gmail notification/i);
      }
      return response({
        id: `resp_gmail_push_fallback_${modelCall}`,
        model: "gpt-5-mini",
        output_text: body.instructions.includes("Response repair")
          ? "Done."
          : "I can help in this chat. Tell me what you want to do.",
        output: [],
        usage: { input_tokens: 300, output_tokens: 12 },
      });
    },
  });
  const messages = await listThreadMessages("gmail-push-fallback-chat", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, true);
  assert.match(assistant.text, /new Gmail message from Alerts <alerts@example\.com>/i);
  assert.match(assistant.text, /Subject: Server receipt/i);
  assert.match(assistant.text, /Receipt preview only/i);
  assert.doesNotMatch(assistant.text, /Tell me what you want|workspace execution|\/codex/i);
});

test("tenant api-agent keeps prior Gmail context for weak follow-up fallback", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-context-fallback-"));
  const env = await allowSanitizerEnv(home);
  await createThread({
    id: "gmail-context-fallback-chat",
    ownerUserId: "otcan",
    name: "gmail-context-fallback-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-gmail-context-fallback" },
  }, env);
  await appendThreadMessage("gmail-context-fallback-chat", {
    role: "user",
    source: "connector_prompt_push",
    connector: "gmail",
    originSurface: "gmail",
    externalId: "paypal-msg-fallback-1",
    chatId: "chat-gmail-context-fallback",
    state: "completed",
    text: [
      "New Gmail message",
      "From: PayPal <service@paypal.de>",
      "Subject: Receipt for Your Payment to LimeBike Germany Gmb...",
      "Date: Thu, 04 Jun 2026 06:48:39 -0700",
      "Snippet: You paid 0.99 EUR to LimeBike Germany Gmb.",
    ].join("\n"),
  }, env);
  await enqueueThreadInputForPrincipal("gmail-context-fallback-chat", {
    text: "Can I cancel this subscription? Can you help me about that?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-gmail-context-fallback",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  let modelCall = 0;
  const result = await processApiAgentThreadInput("gmail-context-fallback-chat", env, {
    fetchImpl: async (_url, options = {}) => {
      modelCall += 1;
      const body = JSON.parse(options.body);
      assert.match(body.instructions, /PayPal <service@paypal\.de> - Receipt for Your Payment/i);
      return response({
        id: `resp_gmail_context_fallback_${modelCall}`,
        model: "gpt-5-mini",
        output_text: body.instructions.includes("Response repair")
          ? "Done."
          : "I can help in this chat. Tell me what you want to do.",
        output: [],
        usage: { input_tokens: 300, output_tokens: 12 },
      });
    },
  });
  const messages = await listThreadMessages("gmail-context-fallback-chat", env);
  const assistant = messages.filter((message) => message.role === "assistant").at(-1);

  assert.equal(result.ok, true);
  assert.match(assistant.text, /latest relevant Gmail notification/i);
  assert.match(assistant.text, /PayPal <service@paypal\.de> - Receipt for Your Payment/i);
  assert.match(assistant.text, /read the full email/i);
  assert.doesNotMatch(assistant.text, /Tell me what you want|workspace execution|\/codex/i);
});

test("tenant api-agent does not let stale Gmail prompt-push context answer unrelated capability questions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-context-unrelated-"));
  const env = await allowSanitizerEnv(home);
  await createThread({
    id: "gmail-context-unrelated-chat",
    ownerUserId: "otcan",
    name: "gmail-context-unrelated-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-gmail-context-unrelated" },
  }, env);
  await appendThreadMessage("gmail-context-unrelated-chat", {
    role: "user",
    source: "connector_prompt_push",
    connector: "gmail",
    originSurface: "gmail",
    externalId: "gmail-msg-unrelated-1",
    chatId: "chat-gmail-context-unrelated",
    state: "completed",
    text: [
      "New Gmail message",
      "From: Alerts <alerts@example.com>",
      "Subject: Build the business skills AI can't replace",
      "Date: Mon, 08 Jun 2026 05:00:00 +0000",
      "Snippet: Stale notification content.",
    ].join("\n"),
  }, env);
  await appendThreadMessage("gmail-context-unrelated-chat", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-gmail-context-unrelated",
    state: "completed",
    text: "Are you connected to my Gmail?",
  }, env);
  await appendThreadMessage("gmail-context-unrelated-chat", {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    chatId: "chat-gmail-context-unrelated",
    state: "completed",
    text: "Gmail is connected for this chat.",
  }, env);
  const input = await enqueueThreadInputForPrincipal("gmail-context-unrelated-chat", {
    text: "Release smoke test: what can you do here? Reply in one short sentence.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-gmail-context-unrelated",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("gmail-context-unrelated-chat", env, {
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.doesNotMatch(body.instructions, /Build the business skills AI can't replace|Gmail notification summary/i);
      assert.doesNotMatch(JSON.stringify(body.input), /Build the business skills AI can't replace|Stale notification content/);
      if (calls.length === 1) {
        return response({
          id: "resp_gmail_context_unrelated_1",
          model: "gpt-5-mini",
          output_text: "I can open the browser, inspect workspace files, and gather page contents for you.",
          output: [],
          usage: { input_tokens: 300, output_tokens: 18 },
        });
      }
      return response({
        id: "resp_gmail_context_unrelated_2",
        model: "gpt-5-mini",
        output_text: "Done.",
        output: [],
        usage: { input_tokens: 360, output_tokens: 4 },
      });
    },
  });
  const messages = await listThreadMessages("gmail-context-unrelated-chat", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(assistant.text, /questions, planning, drafting/i);
  assert.doesNotMatch(assistant.text, /latest relevant Gmail notification|Build the business skills|read the full email|Codex|\/codex|workspace runtime|external account state/i);
});

test("tenant api-agent strips leaked internal thought from final chat text", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-thought-strip-"));
  const env = await allowSanitizerEnv(home);
  await createThread({
    id: "gmail-thought-strip-chat",
    ownerUserId: "otcan",
    name: "gmail-thought-strip-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-gmail-thought-strip" },
  }, env);
  await enqueueThreadInputForPrincipal("gmail-thought-strip-chat", {
    text: "Can you check my last 3 emails?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-gmail-thought-strip",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const result = await processApiAgentThreadInput("gmail-thought-strip-chat", env, {
    fetchImpl: async () => response({
      id: "resp_gmail_thought_strip_1",
      model: "gpt-5-mini",
      output_text: [
        "Here are your latest 3 messages:",
        "1) From: Newsletter Team -- Subject: Spring update -- Unread -- Promotions",
        "2) From: billing@example.com -- Subject: Invoice ready -- Unread -- Updates",
        "3) From: Alex Example -- Subject: OAuth client JSON -- Unread -- Sent -- Important",
        "",
        "User wants to check last 3 emails; we did. Now what? They might ask to read or summarize. We should wait.",
        "The developer instructions say use timers when appropriate. Tool orkestr_create_timer can create periodic checks.",
      ].join("\n"),
      output: [],
      usage: { input_tokens: 220, output_tokens: 70 },
    }),
  });
  const messages = await listThreadMessages("gmail-thought-strip-chat", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, true);
  assert.match(assistant.text, /Here are your latest 3 messages/);
  assert.match(assistant.text, /OAuth client JSON/);
  assert.doesNotMatch(assistant.text, /User wants|Now what|developer instructions|orkestr_create_timer|We should/i);
});

test("tenant api-agent exposes workspace runtime binding without internal capability fields", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-workspace-context-"));
  const env = await allowSanitizerEnv(home);
  const thread = await createThread({
    id: "workspace-context-chat",
    ownerUserId: "otcan",
    name: "workspace-context-chat",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-workspace-context" },
  });
  const instructions = await buildTenantApiAgentInstructions(thread, [], env);
  const context = tenantContextFromInstructions(instructions);

  assert.equal(Object.hasOwn(context.capabilities, "codexEscalation"), false);
  assert.deepEqual(context.capabilities.workspace, {
    executionAvailable: false,
    connected: false,
    connectionAvailable: true,
    actionTool: "orkestr_connect_workspace_runtime",
  });
});

test("tenant api-agent tool gateway stays inside scoped file roots", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-tools-"));
  const env = { ORKESTR_HOME: home };
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });
  const files = await listFilesForPrincipal("", principal, env);
  const target = path.join(files.roots[0].path, "notes.txt");

  await runTenantApiAgentTool("orkestr_write_file", { path: target, text: "tenant note" }, { principal }, env);
  const read = await runTenantApiAgentTool("orkestr_read_file", { path: target }, { principal }, env);
  const createdSkill = await runTenantApiAgentTool("orkestr_create_skill", {
    name: "CRM helper",
    description: "Help this user with their own CRM workflow.",
    instructions: "Only use accounts and records owned by this user.",
    enabled: true,
  }, { principal }, env);
  const searchedSkills = await runTenantApiAgentTool("orkestr_search_skills", { query: "crm" }, { principal }, env);
  const listedSkills = await runTenantApiAgentTool("orkestr_list_skills", {}, { principal }, env);
  const deletedSkill = await runTenantApiAgentTool("orkestr_delete_skill", { skillId: createdSkill.skill.id }, { principal }, env);

  await assert.rejects(
    () => runTenantApiAgentTool("orkestr_read_file", { path: path.join(home, "secrets", "token") }, { principal }, env),
    /file_path_forbidden/,
  );
  assert.equal(read.text, "tenant note");
  assert.equal(createdSkill.skill.id, "crm-helper");
  assert.equal(createdSkill.skill.createdBy, "chat");
  assert.equal(searchedSkills.skills.some((skill) => skill.id === "crm-helper"), true);
  assert.equal(listedSkills.skills.some((skill) => skill.id === "linkedin" && skill.label === "Managed Desktop"), true);
  assert.equal(deletedSkill.deleted, true);
});

test("tenant api-agent can manage timers from chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-timers-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const thread = await createThread({
    id: "otcantest-timers",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
  }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });

  const created = await runTenantApiAgentTool("orkestr_create_timer", {
    label: "Morning check-in",
    targetType: "thread",
    target: "",
    cadence: "daily",
    time: "08:30",
    every: "",
    prompt: "Ask me for my morning priorities.",
    enabled: true,
  }, { principal, thread }, env);
  const relative = await runTenantApiAgentTool("orkestr_create_timer", {
    label: "Say hi",
    targetType: "thread",
    target: "",
    cadence: "once",
    delay: "2m",
    runAt: "",
    time: "",
    every: "",
    prompt: "Tell me hi.",
    enabled: true,
  }, { principal, thread }, env);
  const listed = await runTenantApiAgentTool("orkestr_list_timers", {}, { principal, thread }, env);
  const run = await runTenantApiAgentTool("orkestr_run_timer", { timerId: created.timer.id }, { principal, thread }, env);
  const messages = await listThreadMessages(thread.id, env);
  const deleted = await runTenantApiAgentTool("orkestr_delete_timer", { timerId: created.timer.id }, { principal, thread }, env);
  const after = await runTenantApiAgentTool("orkestr_list_timers", {}, { principal, thread }, env);

  assert.equal(created.timer.ownerUserId, "otcan");
  assert.equal(created.timer.targetType, "thread");
  assert.equal(created.timer.target, thread.id);
  assert.equal(relative.timer.cadence, "once");
  assert.equal(relative.timer.target, thread.id);
  assert.ok(Date.parse(relative.timer.nextRunAt) > Date.now());
  assert.equal(listed.timers.some((timer) => timer.id === created.timer.id), true);
  assert.equal(listed.timers.some((timer) => timer.id === relative.timer.id), true);
  assert.equal(run.event.type, "timer_manual_run");
  assert.equal(messages.some((message) =>
    message.role === "user" &&
    message.source === "timer_manual_run" &&
    message.text === "Ask me for my morning priorities."
  ), true);
  assert.equal(deleted.ok, true);
  await runTenantApiAgentTool("orkestr_delete_timer", { timerId: relative.timer.id }, { principal, thread }, env);
  assert.equal(after.timers.some((timer) => timer.id === created.timer.id), false);
});

test("tenant api-agent stores onboarding profile details from chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-profile-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const thread = await createThread({
    id: "otcantest-profile",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
  }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });

  const updated = await runTenantApiAgentTool("orkestr_update_onboarding_profile", {
    displayName: "Can",
    timezone: "Europe/Berlin",
    locale: "tr-TR",
    preferences: "Use concise WhatsApp replies.",
    toolRequests: "Connect Gmail and open the managed desktop.",
    notes: "Interested in job application help.",
  }, { principal, thread }, env);
  const second = await runTenantApiAgentTool("orkestr_update_onboarding_profile", {
    displayName: "",
    timezone: "",
    locale: "",
    preferences: "Prefer morning check-ins.",
    toolRequests: "",
    notes: "",
  }, { principal, thread }, env);
  const fetched = await runTenantApiAgentTool("orkestr_get_onboarding_profile", {}, { principal, thread }, env);
  const timer = await runTenantApiAgentTool("orkestr_create_timer", {
    label: "Morning check-in",
    targetType: "thread",
    target: "",
    cadence: "daily",
    delay: "",
    runAt: "",
    time: "09:00",
    timezone: "",
    every: "",
    prompt: "Ask me for my morning priorities.",
    enabled: true,
  }, { principal, thread }, env);
  const instructions = await buildTenantApiAgentInstructions(thread, [], env);
  const context = tenantContextFromInstructions(instructions);

  assert.equal(updated.profile.displayName, "Can");
  assert.equal(updated.profile.toolRequests, "Connect Gmail and open the managed desktop.");
  assert.equal(second.profile.displayName, "Can");
  assert.equal(second.profile.preferences, "Prefer morning check-ins.");
  await assert.rejects(() => runTenantApiAgentTool("orkestr_update_onboarding_profile", {
    displayName: "",
    timezone: "Mars/Base",
    locale: "",
    preferences: "",
    toolRequests: "",
    notes: "",
  }, { principal, thread }, env), /invalid_timezone/);
  assert.equal(fetched.profile.timezone, "Europe/Berlin");
  assert.equal(timer.timer.timezone, "Europe/Berlin");
  assert.match(instructions, /IANA timezone/i);
  assert.match(instructions, /orkestr_update_onboarding_profile/i);
  assert.equal(context.onboardingProfile.displayName, "Can");
  assert.equal(context.onboardingProfile.preferences, "Prefer morning check-ins.");
});

test("tenant api-agent skill actions report when a required desktop is unavailable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-no-desktop-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "gmail",
  };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);

  const inventory = await runTenantApiAgentTool("orkestr_list_skill_actions", {
    skillId: "linkedin",
  }, { principal }, env);
  const linkedin = inventory.skills.find((skill) => skill.id === "linkedin");

  assert.equal(inventory.ok, true);
  assert.equal(linkedin.registryEnabled, true);
  assert.equal(linkedin.available, false);
  assert.equal(linkedin.setupState, "user_desktop_not_provisioned");
  assert.match(linkedin.message, /no desktop has been provisioned for this user/i);
  assert.deepEqual(linkedin.desktops, []);
  assert.deepEqual(linkedin.availableActions, ["status"]);
  assert.equal(inventory.desktopInventory.desktops.some((desktop) => desktop.slug === "linkedin"), false);
});

test("tenant api-agent does not advertise desktops when launch is disabled without a managed backend", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-public-no-desktop-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);

  const inventory = await runTenantApiAgentTool("orkestr_list_skill_actions", {
    skillId: "linkedin",
  }, { principal }, env);
  const linkedin = inventory.skills.find((skill) => skill.id === "linkedin");

  assert.equal(linkedin.registryEnabled, true);
  assert.equal(linkedin.enabled, false);
  assert.equal(linkedin.available, false);
  assert.equal(linkedin.setupState, "instance_desktops_not_provisioned");
  assert.match(linkedin.message, /not provisioned for this Orkestr instance/i);
  assert.deepEqual(linkedin.availableActions, ["status"]);
});

test("tenant api-agent reports disabled instance desktops distinctly", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-desktop-disabled-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "disabled",
  };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);

  const inventory = await runTenantApiAgentTool("orkestr_list_skill_actions", {
    skillId: "linkedin",
  }, { principal }, env);
  const linkedin = inventory.skills.find((skill) => skill.id === "linkedin");

  assert.equal(linkedin.available, false);
  assert.equal(linkedin.setupState, "instance_desktops_disabled");
  assert.match(linkedin.message, /disabled for this Orkestr instance/i);
});

test("tenant api-agent reports unhealthy desktop backend distinctly", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-desktop-unhealthy-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_DESKTOP_BACKEND_STATUS: "unhealthy",
  };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);

  const inventory = await runTenantApiAgentTool("orkestr_list_skill_actions", {
    skillId: "linkedin",
  }, { principal }, env);
  const linkedin = inventory.skills.find((skill) => skill.id === "linkedin");

  assert.equal(linkedin.available, false);
  assert.equal(linkedin.setupState, "desktop_backend_unhealthy");
  assert.match(linkedin.message, /desktop backend is currently unavailable/i);
});

test("tenant api-agent reports provisioned instance desktops as available", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-desktop-provisioned-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "desktop,linkedin",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createTenantVm({
    id: "otcan-tenant",
    ownerUserId: "otcan",
    status: "running",
    desktops: {
      enabled: true,
      provisioned: true,
      backend: "profiles",
      status: "ready",
      visibleSlugs: ["desktop", "linkedin"],
    },
  }, env);

  const inventory = await runTenantApiAgentTool("orkestr_list_skill_actions", {
    skillId: "linkedin",
  }, { principal }, env);
  const linkedin = inventory.skills.find((skill) => skill.id === "linkedin");

  assert.equal(linkedin.available, true);
  assert.equal(linkedin.setupState, "available");
  assert.equal(linkedin.availableActions.includes("open"), true);
});

test("tenant api-agent fallback summarizes skill actions without raw capability dumps", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-skill-summary-fallback-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
  });
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const secrets = path.join(userDataPaths("otcan", env).secrets);
  await fs.mkdir(secrets, { recursive: true });
  await fs.writeFile(path.join(secrets, "gmail-token.json"), JSON.stringify({ access_token: "fake", scope: "https://www.googleapis.com/auth/gmail.readonly" }), "utf8");
  await createThread({
    id: "otcantest-skill-summary-fallback",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-skill-summary-fallback", {
    text: "What can you do in this chat?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, principal, env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-skill-summary-fallback", env, {
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return response({
          id: "resp_skill_summary_fallback_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [
            {
              type: "function_call",
              name: "orkestr_list_skill_actions",
              call_id: "call_skill_summary_actions",
              arguments: JSON.stringify({ skillId: "" }),
            },
          ],
          usage: { input_tokens: 300, output_tokens: 20 },
        });
      }
      return response({
        id: "resp_skill_summary_fallback_2",
        model: "gpt-5-mini",
        output_text: GENERIC_TOOL_FALLBACK_TEXT,
        output: [],
        usage: { input_tokens: 400, output_tokens: 20 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-skill-summary-fallback", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(assistant.text, /This chat can use Files, Timers, WhatsApp, and Gmail\./);
  assert.match(assistant.text, /Managed Desktop is not available because it is not provisioned for this Orkestr instance yet\./);
  assert.match(assistant.text, /Not connected yet: Outlook\./);
  assert.doesNotMatch(assistant.text, /Runtime Context is available/);
  assert.doesNotMatch(assistant.text, /Available actions:/);
  assert.doesNotMatch(assistant.text, /capability_not_available/);
});

test("tenant api-agent can run a generic desktop skill action", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-desktop-action-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "linkedin",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);

  const inventory = await runTenantApiAgentTool("orkestr_list_skill_actions", {
    skillId: "linkedin",
  }, { principal }, env);
  const linkedin = inventory.skills.find((skill) => skill.id === "linkedin");
  const opened = await runTenantApiAgentTool("orkestr_run_skill_action", {
    skillId: "linkedin",
    action: "open",
    target: "",
    url: "",
  }, { principal }, env);

  assert.equal(linkedin.available, true);
  assert.equal(linkedin.availableActions.includes("open"), true);
  assert.equal(opened.ok, true);
  assert.equal(opened.action, "open");
  assert.equal(opened.skill.id, "linkedin");
  assert.equal(opened.desktop.slug, "linkedin");
  assert.equal(opened.desktop.url, "https://www.linkedin.com/");
  assert.equal(opened.desktop.availableActions.includes("open"), true);
});

test("tenant api-agent can use configured generic desktop for the managed desktop skill", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-generic-desktop-action-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "desktop",
    ORKESTR_DEFAULT_DESKTOP_SLUG: "desktop",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);

  const inventory = await runTenantApiAgentTool("orkestr_list_skill_actions", {
    skillId: "linkedin",
  }, { principal }, env);
  const linkedin = inventory.skills.find((skill) => skill.id === "linkedin");
  const opened = await runTenantApiAgentTool("orkestr_run_skill_action", {
    skillId: "linkedin",
    action: "open",
    target: "",
    url: "",
  }, { principal }, env);

  assert.equal(linkedin.available, true);
  assert.equal(linkedin.resolvedDesktop, "desktop");
  assert.equal(linkedin.availableActions.includes("open"), true);
  assert.deepEqual(linkedin.desktops.map((desktop) => desktop.slug), ["desktop"]);
  assert.equal(opened.ok, true);
  assert.equal(opened.desktop.slug, "desktop");
});

test("tenant api-agent answers desktop action requests from skill action tool results", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-linkedin-action-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_API_AGENT_DIRECT_DESKTOP_ENABLED: "0",
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "linkedin",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-linkedin-action",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-linkedin-action", {
    text: "open linkedin. Am I logged in?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-linkedin-action", env, {
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return response({
          id: "resp_linkedin_action_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [
            {
              type: "function_call",
              name: "orkestr_list_skill_actions",
              call_id: "call_skill_actions",
              arguments: JSON.stringify({ skillId: "linkedin" }),
            },
            {
              type: "function_call",
              name: "orkestr_run_skill_action",
              call_id: "call_skill_open",
              arguments: JSON.stringify({ skillId: "linkedin", action: "open", target: "", url: "" }),
            },
          ],
          usage: { input_tokens: 300, output_tokens: 30 },
        });
      }
      const toolOutputs = calls[1].input
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(item.output));
      assert.equal(toolOutputs[0].skills[0].id, "linkedin");
      assert.equal(toolOutputs[1].ok, true);
      assert.equal(toolOutputs[1].desktop.slug, "linkedin");
      return response({
        id: "resp_linkedin_action_2",
        model: "gpt-5-mini",
        output_text: "I opened the LinkedIn managed desktop. I cannot verify whether you are logged in from this chat yet, because the enabled skill action only confirms the desktop action.",
        output: [],
        usage: { input_tokens: 450, output_tokens: 32 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-linkedin-action", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tools.some((tool) => tool.name === "orkestr_list_skill_actions"), true);
  assert.equal(calls[0].tools.some((tool) => tool.name === "orkestr_run_skill_action"), true);
  assert.match(calls[0].instructions, /reason from skills first/i);
  assert.match(assistant.text, /opened the LinkedIn managed desktop/i);
  assert.match(assistant.text, /cannot verify whether you are logged in/i);
  assert.notEqual(assistant.text.trim(), "Done.");
});

test("tenant api-agent formats LinkedIn desktop tool output when model falls back generically", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-linkedin-action-fallback-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_API_AGENT_DIRECT_DESKTOP_ENABLED: "0",
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "linkedin",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-linkedin-action-fallback",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("otcantest-linkedin-action-fallback", {
    text: "Open LinkedIn. Am I logged in?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-linkedin-action-fallback", env, {
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return response({
          id: "resp_linkedin_action_fallback_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [
            {
              type: "function_call",
              name: "orkestr_list_skill_actions",
              call_id: "call_skill_actions_fallback",
              arguments: JSON.stringify({ skillId: "linkedin" }),
            },
            {
              type: "function_call",
              name: "orkestr_run_skill_action",
              call_id: "call_skill_open_fallback",
              arguments: JSON.stringify({ skillId: "linkedin", action: "open", target: "", url: "" }),
            },
          ],
          usage: { input_tokens: 300, output_tokens: 30 },
        });
      }
      const toolOutputs = calls[1].input
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(item.output));
      assert.equal(toolOutputs[0].skills[0].id, "linkedin");
      assert.equal(toolOutputs[1].ok, true);
      assert.equal(toolOutputs[1].desktop.slug, "linkedin");
      return response({
        id: "resp_linkedin_action_fallback_2",
        model: "gpt-5-mini",
        output_text: GENERIC_TOOL_FALLBACK_TEXT,
        output: [],
        usage: { input_tokens: 450, output_tokens: 32 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-linkedin-action-fallback", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(assistant.text, /LinkedIn/i);
  assert.match(assistant.text, /is open/i);
  assert.match(assistant.text, /does not report login state/i);
  assert.doesNotMatch(assistant.text, /without a tool result|Workspace and live browser/i);
  assert.notEqual(assistant.text.trim(), "Done.");
});

test("tenant api-agent routes managed desktop requests through skill tools", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-direct-desktop-open-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "desktop,linkedin",
    ORKESTR_DEFAULT_DESKTOP_SLUG: "desktop",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
    ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-direct-desktop-open",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-direct-desktop-open", {
    text: "Open LinkedIn. Am I logged in?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-direct-desktop-open", env, {
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_list_skill_actions"), true);
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_run_skill_action"), true);
        return response({
          id: "resp_direct_desktop_open_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [
            {
              type: "function_call",
              name: "orkestr_list_skill_actions",
              call_id: "call_direct_desktop_actions",
              arguments: JSON.stringify({ skillId: "linkedin" }),
            },
            {
              type: "function_call",
              name: "orkestr_run_skill_action",
              call_id: "call_direct_desktop_open",
              arguments: JSON.stringify({ skillId: "linkedin", action: "open", target: "", url: "" }),
            },
          ],
          usage: { input_tokens: 300, output_tokens: 30 },
        });
      }
      const toolOutputs = body.input
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(item.output));
      assert.equal(toolOutputs[0].skills[0].id, "linkedin");
      assert.equal(toolOutputs[1].ok, true);
      assert.equal(toolOutputs[1].desktop.slug, "linkedin");
      return response({
        id: "resp_direct_desktop_open_2",
        model: "gpt-5-mini",
        output_text: GENERIC_TOOL_FALLBACK_TEXT,
        output: [],
        usage: { input_tokens: 450, output_tokens: 32 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-direct-desktop-open", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(assistant.text, /LinkedIn is open/i);
  assert.match(assistant.text, /does not report login state/i);
  assert.doesNotMatch(assistant.text, /\/codex/i);
  assert.notEqual(assistant.text.trim(), "Done.");
});

test("tenant api-agent repairs generic help replies to concrete desktop requests with tools", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-generic-desktop-repair-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "desktop,linkedin",
    ORKESTR_DEFAULT_DESKTOP_SLUG: "desktop",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
    ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-generic-desktop-repair",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await appendThreadMessage("otcantest-generic-desktop-repair", {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text: "Yes - your LinkedIn managed desktop is running and available. Current state: running. Actions you can take: open, prepare, start, stop, or restart. I can't confirm whether a LinkedIn account is already logged in without opening the desktop. Would you like me to open it now or restart it?",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-generic-desktop-repair", {
    text: "Open the desk now, and check if it's logged in",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-generic-desktop-repair", env, {
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return response({
          id: "resp_generic_desktop_repair_1",
          model: "gpt-5-mini",
          output_text: "I can help in this chat. Tell me what you want to do.",
          output: [],
          usage: { input_tokens: 300, output_tokens: 12 },
        });
      }
      if (calls.length === 2) {
        assert.match(body.instructions, /Response repair/i);
        assert.equal(body.tool_choice, "required");
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_list_skill_actions"), true);
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_run_skill_action"), true);
        return response({
          id: "resp_generic_desktop_repair_2",
          model: "gpt-5-mini",
          output_text: "",
          output: [
            {
              type: "function_call",
              name: "orkestr_list_skill_actions",
              call_id: "call_generic_desktop_actions",
              arguments: JSON.stringify({ skillId: "linkedin" }),
            },
            {
              type: "function_call",
              name: "orkestr_run_skill_action",
              call_id: "call_generic_desktop_open",
              arguments: JSON.stringify({ skillId: "linkedin", action: "open", target: "", url: "" }),
            },
          ],
          usage: { input_tokens: 400, output_tokens: 34 },
        });
      }
      const toolOutputs = body.input
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(item.output));
      assert.equal(toolOutputs[0].skills[0].id, "linkedin");
      assert.equal(toolOutputs[1].ok, true);
      assert.equal(toolOutputs[1].desktop.slug, "linkedin");
      assert.match(toolOutputs[1].shareUrl, /https:\/\/app\.example\.test\/desktop-share\//);
      return response({
        id: "resp_generic_desktop_repair_3",
        model: "gpt-5-mini",
        output_text: GENERIC_TOOL_FALLBACK_TEXT,
        output: [],
        usage: { input_tokens: 500, output_tokens: 32 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-generic-desktop-repair", env);
  const current = messages.find((message) => message.id === input.id);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(current.state, "completed");
  assert.match(assistant.text, /LinkedIn is open/i);
  assert.match(assistant.text, /does not report login state/i);
  assert.match(assistant.text, /Open this one-time desktop link: https:\/\/app\.example\.test\/desktop-share\//i);
  assert.doesNotMatch(assistant.text, /I can help in this chat/);
  assert.doesNotMatch(assistant.text, /\/desktop\/linkedin\/vnc\.html/);
});

test("tenant api-agent repairs generic help replies to concrete timer requests with tools", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-generic-timer-repair-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-generic-timer-repair",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-generic-timer-repair", {
    text: "Remind me in 2 minutes to check the release status.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-generic-timer-repair", env, {
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return response({
          id: "resp_generic_timer_repair_1",
          model: "gpt-5-mini",
          output_text: "I can help in this chat. Tell me what you want to do.",
          output: [],
          usage: { input_tokens: 260, output_tokens: 12 },
        });
      }
      if (calls.length === 2) {
        assert.match(body.instructions, /Response repair/i);
        assert.equal(body.tool_choice, "required");
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_create_automation"), true);
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_create_timer"), false);
        return response({
          id: "resp_generic_timer_repair_2",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_create_automation",
            call_id: "call_generic_timer_create",
            arguments: JSON.stringify({
              type: "timer",
              provider: "timer",
              label: "Check release status",
              targetType: "thread",
              target: "",
              cadence: "once",
              delay: "2m",
              runAt: "",
              time: "",
              timezone: "",
              every: "",
              prompt: "Check the release status.",
              promptTemplate: "",
              query: "",
              maxItemsPerRun: 0,
              enabled: true,
              allowBroadQuery: false,
            }),
          }],
          usage: { input_tokens: 390, output_tokens: 34 },
        });
      }
      const toolOutput = JSON.parse(body.input.find((item) => item.type === "function_call_output")?.output || "{}");
      assert.equal(toolOutput.ok, true);
      assert.equal(toolOutput.automation.label, "Check release status");
      return response({
        id: "resp_generic_timer_repair_3",
        model: "gpt-5-mini",
        output_text: GENERIC_TOOL_FALLBACK_TEXT,
        output: [],
        usage: { input_tokens: 440, output_tokens: 28 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-generic-timer-repair", env);
  const current = messages.find((message) => message.id === input.id);
  const assistant = messages.find((message) => message.parentMessageId === input.id);
  const timers = await listTimers(env);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(current.state, "completed");
  assert.equal(timers.some((timer) => timer.label === "Check release status"), true);
  assert.match(assistant.text, /Automation saved: Check release status/i);
  assert.doesNotMatch(assistant.text, /I can help in this chat/);
});

test("tenant api-agent confirmation of offered browser action cannot finalize as Done", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-browser-confirmation-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "linkedin",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-browser-confirmation",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await appendThreadMessage("otcantest-browser-confirmation", {
    role: "user",
    source: "whatsapp_inbound",
    text: "Great. Can you check Ekşisözlük and tell me the trending topics today?",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, env);
  await appendThreadMessage("otcantest-browser-confirmation", {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text: "Sure — I can do that. I can open your managed browser desk (LinkedIn Browser Desk) to visit eksisozluk.com and gather today's trending topics and top entries.\n\nShall I open the desktop and fetch the trends now? It'll take ~30-60 seconds. Also tell me if you want translations into English.",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-browser-confirmation", {
    text: "Yes. And yes.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-browser-confirmation", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        assert.match(body.instructions, /Pending action confirmation/i);
        return response({
          id: "resp_browser_confirmation_1",
          model: "gpt-5-mini",
          output_text: "Done.",
          output: [],
          usage: { input_tokens: 420, output_tokens: 2 },
        });
      }
      if (calls.length === 2) {
        assert.match(body.instructions, /Action confirmation retry/i);
        assert.equal(body.tool_choice, "required");
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_list_skill_actions"), true);
        assert.equal(body.tools.some((tool) => tool.name === "orkestr_run_skill_action"), true);
        return response({
          id: "resp_browser_confirmation_retry",
          model: "gpt-5-mini",
          output_text: "",
          output: [
            {
              type: "function_call",
              name: "orkestr_list_skill_actions",
              call_id: "call_browser_actions",
              arguments: JSON.stringify({ skillId: "linkedin" }),
            },
            {
              type: "function_call",
              name: "orkestr_run_skill_action",
              call_id: "call_browser_open_url",
              arguments: JSON.stringify({ skillId: "linkedin", action: "open_url", target: "", url: "https://eksisozluk.com/" }),
            },
          ],
          usage: { input_tokens: 520, output_tokens: 42 },
        });
      }
      const toolOutputs = body.input
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(item.output));
      assert.equal(toolOutputs[0].skills[0].availableActions.includes("open_url"), true);
      assert.equal(toolOutputs[1].ok, true);
      assert.equal(toolOutputs[1].openedUrl, "https://eksisozluk.com/");
      return response({
        id: "resp_browser_confirmation_2",
        model: "gpt-5-mini",
        output_text: "I opened the managed desktop to https://eksisozluk.com/. I can’t truthfully say I gathered today’s trending topics or translations from this chat, because the available desktop action only confirms that the URL was opened. Do you want me to connect Codex to this chat for deeper browser/content work?",
        output: [],
        usage: { input_tokens: 620, output_tokens: 48 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-browser-confirmation", env);
  const current = messages.find((message) => message.id === input.id);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(current.state, "completed");
  assert.match(assistant.text, /opened the managed desktop/i);
  assert.match(assistant.text, /eksisozluk\.com/i);
  assert.match(assistant.text, /connect Codex/i);
  assert.doesNotMatch(assistant.text, /\/codex/i);
  assert.doesNotMatch(assistant.text, /^Done\.?$/i);
});

test("tenant api-agent repairs bare confirmation replies when no action is pending", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-bare-confirmation-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-bare-confirmation",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await appendThreadMessage("otcantest-bare-confirmation", {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text: "I can help in this chat. Tell me what you want to do.",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-bare-confirmation", {
    text: "Yes. And yes.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-bare-confirmation", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return response({
          id: "resp_bare_confirmation_1",
          model: "gpt-5-mini",
          output_text: "Done.",
          output: [],
          usage: { input_tokens: 180, output_tokens: 2 },
        });
      }
      assert.equal(body.tools.some((tool) => tool.name === "orkestr_list_skills"), true);
      assert.match(body.instructions, /Response repair/i);
      assert.match(body.instructions, /call the tool before finalizing/i);
      assert.match(body.instructions, /only a confirmation/i);
      return response({
        id: "resp_bare_confirmation_2",
        model: "gpt-5-mini",
        output_text: "I don’t have a concrete action to complete from that confirmation alone. Tell me the specific task you want.",
        output: [],
        usage: { input_tokens: 260, output_tokens: 34 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-bare-confirmation", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(assistant.text, /specific task/i);
  assert.doesNotMatch(assistant.text, /\/codex/i);
  assert.doesNotMatch(assistant.text, /^Done\.?$/i);
});

test("tenant api-agent repairs unconfirmed action promises for bare confirmations", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-bare-confirmation-promise-"));
  const env = await allowSanitizerEnv(home);
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-bare-confirmation-promise",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  await appendThreadMessage("otcantest-bare-confirmation-promise", {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    text: "I can help in this chat. Tell me what you want to do.",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-bare-confirmation-promise", {
    text: "Yes. And yes.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-bare-confirmation-promise", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return response({
          id: "resp_bare_confirmation_promise_1",
          model: "gpt-5-mini",
          output_text: "Great — I’ll open the managed browser, visit eksisozluk.com, collect today’s trending topics and top entries, and translate them into English. Which output do you want? Reply A, B, or C.",
          output: [],
          usage: { input_tokens: 220, output_tokens: 44 },
        });
      }
      assert.equal(body.tools.some((tool) => tool.name === "orkestr_list_skills"), true);
      assert.match(body.instructions, /do not promise future browser or workspace work/i);
      assert.match(body.instructions, /call the tool before finalizing/i);
      return response({
        id: "resp_bare_confirmation_promise_2",
        model: "gpt-5-mini",
        output_text: "I do not have a confirmed action to complete from that message alone. Tell me the specific task you want.",
        output: [],
        usage: { input_tokens: 300, output_tokens: 35 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-bare-confirmation-promise", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(assistant.text, /specific task/i);
  assert.doesNotMatch(assistant.text, /\/codex/i);
  assert.doesNotMatch(assistant.text, /collect today/i);
  assert.doesNotMatch(assistant.text, /Reply A, B, or C/i);
});

test("tenant api-agent repairs browser research promises without tool evidence", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-browser-promise-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_API_AGENT_WEB_FETCH_ENABLED: "0",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-browser-promise",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-browser-promise", {
    text: "Great. Can you check Ekşisözlük and tell me the trending topics today?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-browser-promise", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return response({
          id: "resp_browser_promise_1",
          model: "gpt-5-mini",
          output_text: "I can open the managed browser, collect today’s trending topics, and translate them to English.",
          output: [],
          usage: { input_tokens: 260, output_tokens: 43 },
        });
      }
      assert.equal(body.tools.some((tool) => tool.name === "orkestr_list_skills"), true);
      assert.match(body.instructions, /no tool result confirms completed work/i);
      assert.match(body.instructions, /call the tool before finalizing/i);
      return response({
        id: "resp_browser_promise_2",
        model: "gpt-5-mini",
        output_text: "I can’t gather live page contents from the current tools. Do you want me to connect Codex to this chat for deeper browser/content work?",
        output: [],
        usage: { input_tokens: 330, output_tokens: 34 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-browser-promise", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(assistant.text, /connect Codex/i);
  assert.doesNotMatch(assistant.text, /\/codex/i);
  assert.match(assistant.text, /live page contents|browser\/content/i);
  assert.doesNotMatch(assistant.text, /collect today/i);
  assert.doesNotMatch(assistant.text, /Managed LinkedIn Browser Desk/i);
});

test("tenant api-agent does not suggest codex when browser execution is disabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-browser-promise-codex-disabled-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_CODEX_BIN: "__orkestr_codex_disabled_public_instance__",
    ORKESTR_API_AGENT_WEB_FETCH_ENABLED: "0",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-browser-promise-codex-disabled",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-browser-promise-codex-disabled", {
    text: "Can you check Ekşisözlük and tell me the trending topics today?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-browser-promise-codex-disabled", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.doesNotMatch(body.instructions, /\/codex/i);
      if (calls.length === 1) {
        return response({
          id: "resp_browser_promise_codex_disabled_1",
          model: "gpt-5-mini",
          output_text: "I can open the browser and collect today’s trending topics.",
          output: [],
          usage: { input_tokens: 260, output_tokens: 28 },
        });
      }
      return response({
        id: "resp_browser_promise_codex_disabled_2",
        model: "gpt-5-mini",
        output_text: "I cannot run a browser worker from this chat right now.",
        output: [],
        usage: { input_tokens: 330, output_tokens: 16 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-browser-promise-codex-disabled", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(assistant.text, /from this chat right now/i);
  assert.doesNotMatch(assistant.text, /\/codex/i);
  assert.doesNotMatch(assistant.text, /collect today/i);
});

test("tenant api-agent formats workspace runtime connection tool failures without legacy command language", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-workspace-connect-disabled-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_CODEX_BIN: "__orkestr_codex_disabled_public_instance__",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-workspace-connect-disabled",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-workspace-connect-disabled", {
    text: "Yes, connect Codex to this chat.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-workspace-connect-disabled", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return response({
          id: "resp_workspace_connect_disabled_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_connect_workspace_runtime",
            call_id: "call_workspace_connect",
            arguments: JSON.stringify({ reason: "user accepted workspace runtime connection" }),
          }],
          usage: { input_tokens: 320, output_tokens: 24 },
        });
      }
      return response({
        id: "resp_workspace_connect_disabled_2",
        model: "gpt-5-mini",
        output_text: GENERIC_TOOL_FALLBACK_TEXT,
        output: [],
        usage: { input_tokens: 420, output_tokens: 20 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-workspace-connect-disabled", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);
  const thread = await getThread("otcantest-workspace-connect-disabled", env);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(thread.runtimeKind, "api-agent");
  assert.match(assistant.text, /cannot be connected/i);
  assert.doesNotMatch(assistant.text, /\/codex/i);
  assert.doesNotMatch(assistant.text, /send the task|resend/i);
});

test("tenant api-agent web fetch tool extracts public page links safely", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-web-fetch-tool-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_API_AGENT_WEB_FETCH_SKIP_DNS_CHECK: "1",
  };
  const html = [
    "<!doctype html>",
    "<html>",
    "<head><title>gundem - eksi sozluk</title></head>",
    "<body>",
    "<a href=\"/robert-lewandowski--123\"><span>robert lewandowski</span><small>190</small></a>",
    "<a href=\"/yalnizligin-en-cok-koydugu-an--456\">yalnizligin en cok koydugu an <small>87</small></a>",
    "<a href=\"javascript:void(0)\">skip me</a>",
    "</body>",
    "</html>",
  ].join("");
  const principal = userPrincipal({ id: "otcan", role: "user" });
  const seen = [];

  const result = await runTenantApiAgentTool("orkestr_fetch_web_page", {
    url: "https://eksisozluk.com/basliklar/gundem",
    maxLinks: 10,
    maxChars: 2000,
  }, {
    principal,
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  }, env);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://eksisozluk.com/basliklar/gundem");
  assert.equal(seen[0].options.redirect, "manual");
  assert.equal(result.ok, true);
  assert.equal(result.title, "gundem - eksi sozluk");
  assert.equal(result.links.length, 2);
  assert.equal(result.links[0].text, "robert lewandowski");
  assert.equal(result.links[0].count, 190);
  assert.equal(result.links[1].count, 87);
  assert.match(result.links[0].url, /^https:\/\/eksisozluk\.com\/robert-lewandowski--123$/);
  assert.match(result.text, /robert lewandowski/);
});

test("tenant api-agent web fetch tool rejects private hosts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-web-fetch-private-"));
  const env = { ORKESTR_HOME: home };
  const principal = userPrincipal({ id: "otcan", role: "user" });

  await assert.rejects(
    () => runTenantApiAgentTool("orkestr_fetch_web_page", {
      url: "http://127.0.0.1:18912/api/threads",
      maxLinks: 10,
      maxChars: 2000,
    }, { principal }, env),
    /url_host_forbidden/,
  );
});

test("tenant api-agent answers public web topic requests from web fetch tool output", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-web-fetch-answer-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_CODEX_BIN: "__orkestr_codex_disabled_public_instance__",
    ORKESTR_API_AGENT_WEB_FETCH_SKIP_DNS_CHECK: "1",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-web-fetch-answer",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-web-fetch-answer", {
    text: "Can you check Eksi Sozluk and tell me the top 3 gundem topics today?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const html = [
    "<!doctype html>",
    "<html><head><title>gundem - eksi sozluk</title></head><body>",
    "<a href=\"/robert-lewandowski--123\">robert lewandowski <small>190</small></a>",
    "<a href=\"/yalnizligin-en-cok-koydugu-an--456\">yalnizligin en cok koydugu an <small>87</small></a>",
    "<a href=\"/minyon-kadin-agresifligi--789\">minyon kadin agresifligi <small>97</small></a>",
    "</body></html>",
  ].join("");
  const openAiCalls = [];
  const webFetchCalls = [];

  const result = await processApiAgentThreadInput("otcantest-web-fetch-answer", env, {
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("/responses")) {
        const body = JSON.parse(options.body);
        openAiCalls.push(body);
        if (openAiCalls.length === 1) {
          assert.equal(body.tools.some((tool) => tool.name === "orkestr_fetch_web_page"), true);
          return response({
            id: "resp_web_fetch_answer_1",
            model: "gpt-5-mini",
            output_text: "",
            output: [{
              type: "function_call",
              name: "orkestr_fetch_web_page",
              call_id: "call_web_fetch_answer",
              arguments: JSON.stringify({ url: "https://eksisozluk.com/basliklar/gundem", maxLinks: 10, maxChars: 2000 }),
            }],
            usage: { input_tokens: 260, output_tokens: 18 },
          });
        }
        const toolOutput = JSON.parse(body.input.find((item) => item.type === "function_call_output")?.output || "{}");
        assert.equal(toolOutput.title, "gundem - eksi sozluk");
        assert.equal(toolOutput.links.length, 3);
        return response({
          id: "resp_web_fetch_answer_2",
          model: "gpt-5-mini",
          output_text: "Top counted items I found: robert lewandowski (190), yalnizligin en cok koydugu an (87), and minyon kadin agresifligi (97).",
          output: [],
          usage: { input_tokens: 380, output_tokens: 32 },
        });
      }
      webFetchCalls.push(String(url));
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-web-fetch-answer", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 2);
  assert.deepEqual(webFetchCalls, ["https://eksisozluk.com/basliklar/gundem"]);
  assert.equal(assistant.source, "api-agent");
  assert.match(assistant.text, /Top counted items I found/i);
  assert.match(assistant.text, /robert lewandowski \(190\)/i);
  assert.match(assistant.text, /yalnizligin en cok koydugu an \(87\)/i);
  assert.match(assistant.text, /minyon kadin agresifligi \(97\)/i);
  assert.doesNotMatch(assistant.text, /\/codex/i);
  assert.doesNotMatch(assistant.text, /Codex/i);
});

test("tenant api-agent answers explicit public URL fetches without falling back to Done", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-explicit-web-fetch-answer-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_CODEX_BIN: "__orkestr_codex_disabled_public_instance__",
    ORKESTR_API_AGENT_WEB_FETCH_SKIP_DNS_CHECK: "1",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-explicit-web-fetch-answer",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-explicit-web-fetch-answer", {
    text: "Fetch https://orkestr.example.test/ and summarize what is on the page.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);
  const html = [
    "<!doctype html>",
    "<html><head><title>Orkestr public alpha</title></head><body>",
    "<main>Orkestr lets users talk to contained agents from chat. The public alpha focuses on WhatsApp, Gmail setup, managed desktops, and safe tenant boundaries.</main>",
    "</body></html>",
  ].join("");
  const openAiCalls = [];
  const webFetchCalls = [];

  const result = await processApiAgentThreadInput("otcantest-explicit-web-fetch-answer", env, {
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("/responses")) {
        const body = JSON.parse(options.body);
        openAiCalls.push(body);
        if (openAiCalls.length === 1) {
          assert.equal(body.tools.some((tool) => tool.name === "orkestr_fetch_web_page"), true);
          return response({
            id: "resp_explicit_web_fetch_answer_1",
            model: "gpt-5-mini",
            output_text: "",
            output: [{
              type: "function_call",
              name: "orkestr_fetch_web_page",
              call_id: "call_explicit_web_fetch_answer",
              arguments: JSON.stringify({ url: "https://orkestr.example.test/", maxLinks: 10, maxChars: 2000 }),
            }],
            usage: { input_tokens: 260, output_tokens: 18 },
          });
        }
        const toolOutput = JSON.parse(body.input.find((item) => item.type === "function_call_output")?.output || "{}");
        assert.equal(toolOutput.title, "Orkestr public alpha");
        assert.match(toolOutput.text, /contained agents/);
        return response({
          id: "resp_explicit_web_fetch_answer_2",
          model: "gpt-5-mini",
          output_text: "Fetched Orkestr public alpha. The page says Orkestr lets users talk to contained agents from chat and focuses on WhatsApp, Gmail setup, managed desktops, and safe tenant boundaries.",
          output: [],
          usage: { input_tokens: 360, output_tokens: 30 },
        });
      }
      webFetchCalls.push(String(url));
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-explicit-web-fetch-answer", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 2);
  assert.deepEqual(webFetchCalls, ["https://orkestr.example.test/"]);
  assert.match(assistant.text, /Fetched Orkestr public alpha/i);
  assert.match(assistant.text, /contained agents/i);
  assert.notEqual(assistant.text.trim(), "Done.");
  assert.doesNotMatch(assistant.text, /\/codex/i);
});

test("tenant api-agent does not treat exact replies containing domains as web fetches", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-exact-domain-no-fetch-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_API_AGENT_WEB_FETCH_SKIP_DNS_CHECK: "1",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-exact-domain-no-fetch",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-exact-domain-no-fetch", {
    text: "orkestr.example.test e2e 123: reply exactly \"orkestr.example.test e2e OK 123\"",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);
  const openAiCalls = [];

  const result = await processApiAgentThreadInput("otcantest-exact-domain-no-fetch", env, {
    fetchImpl: async (url, options = {}) => {
      assert.equal(String(url).includes("/responses"), true);
      openAiCalls.push(JSON.parse(options.body));
      return response({
        id: "resp_exact_domain_no_fetch",
        model: "gpt-5-mini",
        output_text: "orkestr.example.test e2e OK 123",
        output: [],
        usage: { input_tokens: 140, output_tokens: 8 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-exact-domain-no-fetch", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 1);
  assert.equal(assistant.text, "orkestr.example.test e2e OK 123");
});

test("tenant api-agent does not treat incidental domain labels as web fetch targets", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-domain-label-no-fetch-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_API_AGENT_DIRECT_DESKTOP_ENABLED: "0",
    ORKESTR_API_AGENT_WEB_FETCH_SKIP_DNS_CHECK: "1",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-domain-label-no-fetch",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-domain-label-no-fetch", {
    text: "orkestr.example.test e2e 123: Open LinkedIn. Am I logged in?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);
  const openAiCalls = [];

  const result = await processApiAgentThreadInput("otcantest-domain-label-no-fetch", env, {
    fetchImpl: async (url, options = {}) => {
      assert.equal(String(url).includes("/responses"), true);
      openAiCalls.push(JSON.parse(options.body));
      return response({
        id: "resp_domain_label_no_fetch",
        model: "gpt-5-mini",
        output_text: "The managed desktop status does not report login state, so I cannot confirm whether you are logged in.",
        output: [],
        usage: { input_tokens: 140, output_tokens: 18 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-domain-label-no-fetch", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 1);
  assert.match(assistant.text, /managed desktop status/i);
});

test("tenant api-agent opens the generic desktop when public fetch hits a browser challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-web-fetch-desktop-fallback-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_CODEX_BIN: "__orkestr_codex_disabled_public_instance__",
    ORKESTR_API_AGENT_WEB_FETCH_SKIP_DNS_CHECK: "1",
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "desktop,linkedin",
    ORKESTR_DEFAULT_DESKTOP_SLUG: "desktop",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
    ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-web-fetch-desktop-fallback",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-web-fetch-desktop-fallback", {
    text: "Fetch https://example.com/protected and summarize it.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);
  const html = "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site. Cloudflare</body></html>";
  const openAiCalls = [];

  const result = await processApiAgentThreadInput("otcantest-web-fetch-desktop-fallback", env, {
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("/responses")) {
        const body = JSON.parse(options.body);
        openAiCalls.push(body);
        if (openAiCalls.length === 1) {
          assert.equal(body.tools.some((tool) => tool.name === "orkestr_fetch_web_page"), true);
          return response({
            id: "resp_web_fetch_desktop_fallback_1",
            model: "gpt-5-mini",
            output_text: "",
            output: [{
              type: "function_call",
              name: "orkestr_fetch_web_page",
              call_id: "call_web_fetch_desktop_fallback",
              arguments: JSON.stringify({ url: "https://example.com/protected", maxLinks: 10, maxChars: 2000 }),
            }],
            usage: { input_tokens: 280, output_tokens: 18 },
          });
        }
        if (openAiCalls.length === 2) {
          const toolOutput = JSON.parse(body.input.find((item) => item.type === "function_call_output")?.output || "{}");
          assert.equal(toolOutput.title, "Just a moment...");
          assert.match(toolOutput.text, /Checking your browser/i);
          return response({
            id: "resp_web_fetch_desktop_fallback_2",
            model: "gpt-5-mini",
            output_text: "",
            output: [
              {
                type: "function_call",
                name: "orkestr_list_skill_actions",
                call_id: "call_web_fetch_desktop_actions",
                arguments: JSON.stringify({ skillId: "linkedin" }),
              },
              {
                type: "function_call",
                name: "orkestr_run_skill_action",
                call_id: "call_web_fetch_desktop_open_url",
                arguments: JSON.stringify({ skillId: "linkedin", action: "open_url", target: "", url: "https://example.com/protected" }),
              },
            ],
            usage: { input_tokens: 420, output_tokens: 42 },
          });
        }
        const toolOutputs = body.input
          .filter((item) => item.type === "function_call_output")
          .map((item) => JSON.parse(item.output));
        assert.equal(toolOutputs.at(-1).ok, true);
        assert.equal(toolOutputs.at(-1).openedUrl, "https://example.com/protected");
        return response({
          id: "resp_web_fetch_desktop_fallback_3",
          model: "gpt-5-mini",
          output_text: GENERIC_TOOL_FALLBACK_TEXT,
          output: [],
          usage: { input_tokens: 560, output_tokens: 32 },
        });
      }
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-web-fetch-desktop-fallback", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 3);
  assert.match(assistant.text, /opened https:\/\/example\.com\/protected in LinkedIn/i);
  assert.match(assistant.text, /Open this one-time desktop link: https:\/\/app\.example\.test\/desktop-share\//i);
  assert.match(assistant.text, /Paste that challenge back here/i);
  assert.match(assistant.text, /does not return page contents/i);
  assert.doesNotMatch(assistant.text, /\/desktop\/linkedin\/vnc\.html/i);
  assert.doesNotMatch(assistant.text, /Fetched Just a moment/i);
  assert.doesNotMatch(assistant.text, /\/codex/i);
});

test("tenant api-agent does not desktop-fallback private web fetch targets", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-private-web-fetch-no-desktop-"));
  const env = await allowSanitizerEnv(home, {
    ORKESTR_CODEX_BIN: "__orkestr_codex_disabled_public_instance__",
    ORKESTR_BROWSER_DESKTOP_MODE: "profiles",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "desktop",
    ORKESTR_DEFAULT_DESKTOP_SLUG: "desktop",
    ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  await createThread({
    id: "otcantest-private-web-fetch-no-desktop",
    ownerUserId: "otcan",
    name: "otcantest",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-otcan", outboundAccountId: "wa-1" },
  }, env);
  const input = await enqueueThreadInputForPrincipal("otcantest-private-web-fetch-no-desktop", {
    text: "Fetch http://127.0.0.1:19812/api/health and summarize it.",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const openAiCalls = [];
  const result = await processApiAgentThreadInput("otcantest-private-web-fetch-no-desktop", env, {
    fetchImpl: async (url, options = {}) => {
      if (!String(url).includes("/responses")) throw new Error("private_fetch_should_be_rejected_before_network");
      const body = JSON.parse(options.body);
      openAiCalls.push(body);
      if (openAiCalls.length === 1) {
        return response({
          id: "resp_private_web_fetch_no_desktop_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [{
            type: "function_call",
            name: "orkestr_fetch_web_page",
            call_id: "call_private_web_fetch_no_desktop",
            arguments: JSON.stringify({ url: "http://127.0.0.1:19812/api/health", maxLinks: 10, maxChars: 2000 }),
          }],
          usage: { input_tokens: 240, output_tokens: 18 },
        });
      }
      const toolOutput = JSON.parse(body.input.find((item) => item.type === "function_call_output")?.output || "{}");
      assert.equal(toolOutput.error, "url_host_forbidden");
      return response({
        id: "resp_private_web_fetch_no_desktop_2",
        model: "gpt-5-mini",
        output_text: "I cannot fetch that URL from this chat because private/local hosts are blocked (url_host_forbidden).",
        output: [],
        usage: { input_tokens: 320, output_tokens: 18 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-private-web-fetch-no-desktop", env);
  const assistant = messages.find((message) => message.parentMessageId === input.id);

  assert.equal(result.ok, true);
  assert.equal(openAiCalls.length, 2);
  assert.match(assistant.text, /url_host_forbidden/i);
  assert.doesNotMatch(assistant.text, /opened/i);
});

test("tenant api-agent records manual usage summaries", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-usage-"));
  const env = { ORKESTR_HOME: home };
  await recordCreditUsage({
    tenantId: "otcan",
    threadId: "thread-1",
    messageId: "message-1",
    responseId: "resp-1",
    model: "gpt-5-nano",
    usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 200 } },
  }, env);
  const summary = await creditUsageSummary({ tenantId: "otcan" }, env);

  assert.equal(summary.count, 1);
  assert.equal(summary.byModel["gpt-5-nano"] > 0, true);
  assert.equal(summary.recent[0].responseId, "resp-1");
});

test("tenant connector auth tool starts Gmail OAuth from parent app config", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-auth-tool-"));
  const env = await allowSanitizerEnv(home, {
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });

  const result = await runTenantApiAgentTool("orkestr_start_connector_auth", {
    provider: "gmail",
    account: "person@example.com",
  }, { principal, thread: { id: "otcan" } }, env);
  const authorizeUrl = new URL(result.authorizeUrl);
  const savedState = JSON.parse(await fs.readFile(path.join(userDataPaths("otcan", env).oauth, "gmail-state.json"), "utf8"));
  const identities = await readUserPrivateIdentities("otcan", env);

  assert.equal(result.ok, true);
  assert.equal(result.provider, "gmail");
  assert.equal(authorizeUrl.searchParams.get("client_id"), "gmail-client-env");
  assert.equal(authorizeUrl.searchParams.get("login_hint"), "person@example.com");
  assert.equal(savedState.userId, "otcan");
  assert.equal(savedState.account, "person@example.com");
  assert.equal(identities.some((identity) => identity.provider === "gmail" && identity.externalId === "person@example.com"), true);
});

test("tenant connector auth tool starts Outlook device auth from parent app config", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-outlook-auth-tool-"));
  const env = await allowSanitizerEnv(home, {
    MICROSOFT_OAUTH_CLIENT_ID: "microsoft-client-env",
    MICROSOFT_OAUTH_TENANT_ID: "organizations",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });

  const result = await runTenantApiAgentTool("orkestr_start_connector_auth", {
    provider: "outlook",
    account: "person@example.com",
  }, {
    principal,
    thread: { id: "otcan" },
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(String(url));
      const body = new URLSearchParams(options.body);
      assert.equal(requestUrl.pathname, "/organizations/oauth2/v2.0/devicecode");
      assert.equal(body.get("client_id"), "microsoft-client-env");
      return response({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://microsoft.com/devicelogin",
        verification_uri_complete: "https://microsoft.com/devicelogin?code=ABCD-EFGH",
        interval: 5,
        expires_in: 900,
      });
    },
  }, env);
  const pending = JSON.parse(await fs.readFile(path.join(userDataPaths("otcan", env).secrets, "outlook-device-pending.json"), "utf8"));
  const identities = await readUserPrivateIdentities("otcan", env);

  assert.equal(result.ok, true);
  assert.equal(result.provider, "outlook");
  assert.equal(result.userCode, "ABCD-EFGH");
  assert.equal(pending.userId, "otcan");
  assert.equal(pending.account, "person@example.com");
  assert.equal(identities.some((identity) => identity.provider === "outlook" && identity.externalId === "person@example.com"), true);
});

test("tenant connector auth tools start Jira and Shopify authorization from parent app config", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-generic-oauth-tool-"));
  const env = await allowSanitizerEnv(home, {
    JIRA_OAUTH_CLIENT_ID: "jira-client-env",
    JIRA_OAUTH_CLIENT_SECRET: "jira-secret-env",
    JIRA_OAUTH_REDIRECT_URI: "https://example.test/oauth/jira/callback",
    SHOPIFY_OAUTH_CLIENT_ID: "shopify-client-env",
    SHOPIFY_OAUTH_CLIENT_SECRET: "shopify-secret-env",
    SHOPIFY_OAUTH_REDIRECT_URI: "https://example.test/oauth/shopify/callback",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });

  const jira = await runTenantApiAgentTool("orkestr_start_connector_auth", {
    provider: "jira",
    account: "person@example.com",
    shop: "",
  }, { principal, thread: { id: "otcan" } }, env);
  const shopify = await runTenantApiAgentTool("orkestr_start_connector_auth", {
    provider: "shopify",
    account: "",
    shop: "demo-store",
  }, { principal, thread: { id: "otcan" } }, env);
  const jiraUrl = new URL(jira.authorizeUrl);
  const shopifyUrl = new URL(shopify.authorizeUrl);
  const jiraState = JSON.parse(await fs.readFile(path.join(userDataPaths("otcan", env).oauth, "jira-state.json"), "utf8"));
  const shopifyState = JSON.parse(await fs.readFile(path.join(userDataPaths("otcan", env).oauth, "shopify-state.json"), "utf8"));
  const identities = await readUserPrivateIdentities("otcan", env);

  assert.equal(jira.ok, true);
  assert.equal(jira.provider, "jira");
  assert.equal(jiraUrl.origin, "https://auth.atlassian.com");
  assert.equal(jiraUrl.searchParams.get("client_id"), "jira-client-env");
  assert.equal(jiraUrl.searchParams.get("redirect_uri"), "https://example.test/oauth/jira/callback");
  assert.equal(jiraState.userId, "otcan");
  assert.equal(jiraState.account, "person@example.com");
  assert.equal(identities.some((identity) => identity.provider === "jira" && identity.externalId === "person@example.com"), true);

  assert.equal(shopify.ok, true);
  assert.equal(shopify.provider, "shopify");
  assert.equal(shopify.shop, "demo-store.myshopify.com");
  assert.equal(shopifyUrl.origin, "https://demo-store.myshopify.com");
  assert.equal(shopifyUrl.searchParams.get("client_id"), "shopify-client-env");
  assert.equal(shopifyState.userId, "otcan");
  assert.equal(shopifyState.shop, "demo-store.myshopify.com");
});

test("tenant connector status and disconnect tools are user-scoped", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-connector-status-"));
  const env = await allowSanitizerEnv(home, {
    GMAIL_OAUTH_CLIENT_ID: "gmail-client-env",
    GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret-env",
    GMAIL_OAUTH_REDIRECT_URI: "https://example.test/oauth/gmail/callback",
  });
  await upsertUser({ id: "otcan", role: "user", displayName: "Otcan" }, env);
  const principal = userPrincipal({ id: "otcan", role: "user" });
  const paths = userDataPaths("otcan", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({ accessToken: "user-token" }), "utf8");

  const connected = await runTenantApiAgentTool("orkestr_connector_status", {
    provider: "gmail",
  }, { principal }, env);
  const disconnected = await runTenantApiAgentTool("orkestr_disconnect_connector", {
    provider: "gmail",
    account: "",
  }, { principal }, env);
  const after = await runTenantApiAgentTool("orkestr_connector_status", {
    provider: "gmail",
  }, { principal }, env);

  assert.equal(connected.connected, true);
  assert.equal(connected.state, "connected");
  assert.equal(JSON.stringify(connected).includes("user-token"), false);
  assert.equal(disconnected.ok, true);
  assert.equal(disconnected.status.connected, false);
  assert.equal(after.connected, false);
  assert.equal(after.state, "not_connected");
});
