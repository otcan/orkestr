import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processApiAgentThreadInput } from "../packages/core/src/tenant-api-agent.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createThread, enqueueThreadInputForPrincipal, listThreadMessages } from "../packages/core/src/threads.js";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("tenant api-agent strips non-persisted response items from tool continuations", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-agent-store-false-tool-"));
  const sanitizerLog = path.join(home, "sanitizer.jsonl");
  const script = path.join(home, "tool-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "import fs from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input);",
      `  fs.appendFileSync(${JSON.stringify(sanitizerLog)}, JSON.stringify({ action: payload.action }) + '\\n');`,
      "  const deny = payload.action === 'api-agent.tool.orkestr_connector_status';",
      "  console.log(JSON.stringify({ allow: !deny, reason: deny ? 'gmail capability is false and this is not an allowed auth-start tool' : 'allowed', model: 'test-llm' }));",
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
    id: "tool-continuation-thread",
    ownerUserId: "otcan",
    name: "tool-continuation-thread",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-tool-continuation", outboundAccountId: "wa-1" },
  }, env);
  await enqueueThreadInputForPrincipal("tool-continuation-thread", {
    text: "Do you have access to my Gmail?",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-tool-continuation",
    accountId: "wa-1",
  }, userPrincipal({ id: "otcan", role: "user" }), env);

  const calls = [];
  const result = await processApiAgentThreadInput("tool-continuation-thread", env, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return response({
          id: "resp_tool_continuation_1",
          model: "gpt-5-mini",
          output_text: "",
          output: [
            { type: "reasoning", id: "rs_non_persisted_1", summary: [] },
            {
              type: "function_call",
              id: "fc_non_persisted_1",
              name: "orkestr_connector_status",
              call_id: "call_connector_status",
              arguments: JSON.stringify({ provider: "gmail" }),
            },
          ],
          usage: { input_tokens: 180, output_tokens: 16 },
        });
      }
      assert.equal(body.input.some((item) => item.type === "reasoning" || String(item.id || "").startsWith("rs_")), false);
      const functionCall = body.input.find((item) => item.type === "function_call");
      assert.equal(functionCall?.id, undefined);
      assert.equal(functionCall?.call_id, "call_connector_status");
      const toolOutput = body.input.find((item) => item.type === "function_call_output");
      assert.match(JSON.parse(toolOutput.output).error, /gmail capability is false/i);
      return response({
        id: "resp_tool_continuation_2",
        model: "gpt-5-mini",
        output_text: "Gmail is not connected or enabled for this chat yet. Ask me to connect Gmail and I will send a Google sign-in link.",
        output: [],
        usage: { input_tokens: 220, output_tokens: 18 },
      });
    },
  });
  const messages = await listThreadMessages("tool-continuation-thread", env);
  const assistant = messages.find((message) => message.role === "assistant");
  const sanitizerActions = (await fs.readFile(sanitizerLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).action);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(assistant.text, /Gmail is not connected or enabled for this chat yet/i);
  assert.equal(sanitizerActions.includes("api-agent.tool.orkestr_connector_status"), true);
});
