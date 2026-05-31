import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordCreditUsage, creditUsageSummary } from "../packages/core/src/credit-usage.js";
import { processApiAgentThreadInput, threadUsesApiAgent } from "../packages/core/src/tenant-api-agent.js";
import { runTenantApiAgentTool } from "../packages/core/src/tenant-api-agent-tools.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createThread, enqueueThreadInputForPrincipal, getThread, listThreadMessages } from "../packages/core/src/threads.js";
import { readUserPrivateIdentities, upsertUser } from "../packages/core/src/users.js";
import { listFilesForPrincipal } from "../packages/core/src/workspace-files.js";
import { initialQueueDeliveryState, routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { userDataPaths } from "../packages/storage/src/paths.js";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

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

test("tenant api-agent routes missing connector requests through OpenAI", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-gmail-missing-"));
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
    text: "Can you check my gmail?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-otcan",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("otcantest-gmail-missing", env, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return response({
        id: "resp_api_agent_gmail_missing",
        model: "gpt-5-mini",
        output_text: "Gmail is not connected or enabled for this chat yet. I can start Gmail sign-in if you want to connect it.",
        output: [],
        usage: { input_tokens: 140, output_tokens: 18 },
      });
    },
  });
  const messages = await listThreadMessages("otcantest-gmail-missing", env);
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.tools.some((tool) => tool.name === "orkestr_start_connector_auth"), true);
  assert.match(assistant.text, /Gmail is not connected or enabled for this chat yet/i);
  assert.match(assistant.text, /start Gmail sign-in/i);
  assert.doesNotMatch(assistant.text, /Orkestr UI|Orkestr admin|Orkestr administrator/i);
  assert.doesNotMatch(assistant.text, /checked/i);
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
    from: "491234567890@c.us",
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
    from: "491234567890@c.us",
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
  assert.equal(messages[0].deliveryState || "", "");
  assert.equal(initialQueueDeliveryState({ runtimeKind: "api-agent", state: "queued" }, messages[0]), "");
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
    from: "491234567890@c.us",
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

test("tenant api-agent lets OpenAI initiate Gmail sign-in with connector auth tool", async () => {
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
  assert.match(assistant.text, /accounts\.google\.com/i);
  assert.equal(savedState.userId, "otcan");
  assert.equal(savedState.account, "person@example.com");
  assert.equal(identities.some((identity) => identity.provider === "gmail" && identity.externalId === "person@example.com"), true);
  assert.equal(sanitizerActions.includes("api-agent.tool.orkestr_start_connector_auth"), true);
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
