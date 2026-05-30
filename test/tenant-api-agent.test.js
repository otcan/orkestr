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
import { listFilesForPrincipal } from "../packages/core/src/workspace-files.js";
import { routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
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
  assert.equal(current.state, "completed");
  assert.equal(current.deliveryState, "delivered");
  assert.equal(assistant.source, "api-agent");
  assert.equal(assistant.parentMessageId, input.id);
  assert.equal(assistant.text.includes("Codex"), false);
  assert.equal(usage.count, 1);
  assert.equal(usage.byModel["gpt-5-mini"] > 0, true);
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

test("tenant api-agent tool gateway stays inside scoped file roots", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-tools-"));
  const env = { ORKESTR_HOME: home };
  const principal = userPrincipal({ id: "otcan", role: "user" });
  const files = await listFilesForPrincipal("", principal, env);
  const target = path.join(files.roots[0].path, "notes.txt");

  await runTenantApiAgentTool("orkestr_write_file", { path: target, text: "tenant note" }, { principal }, env);
  const read = await runTenantApiAgentTool("orkestr_read_file", { path: target }, { principal }, env);

  await assert.rejects(
    () => runTenantApiAgentTool("orkestr_read_file", { path: path.join(home, "secrets", "token") }, { principal }, env),
    /file_path_forbidden/,
  );
  assert.equal(read.text, "tenant note");
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
