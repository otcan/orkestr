import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertSanitizedAction, sanitizeAction } from "../packages/core/src/llm-sanitizer.js";

async function sanitizerScript(home, body) {
  const script = path.join(home, "sanitizer.mjs");
  await fs.writeFile(script, body, "utf8");
  return [process.execPath, script];
}

function request() {
  return {
    action: "thread.input",
    principal: { role: "user", userId: "alice" },
    resource: { type: "thread", id: "thread-1", ownerUserId: "alice" },
    input: { text: "Check my inbox without crossing users." },
  };
}

test("LLM sanitizer payload declares LLM-only fail-closed policy", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-sanitizer-contract-"));
  const payloadLog = path.join(home, "payload.json");
  const command = await sanitizerScript(home, [
    "import fs from 'node:fs';",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    `  fs.writeFileSync(${JSON.stringify(payloadLog)}, input);`,
    "  console.log(JSON.stringify({ allow: true, reason: 'allowed', model: 'contract-test' }));",
    "});",
    "",
  ].join("\n"));

  const decision = await sanitizeAction(request(), {
    ORKESTR_HOME: home,
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify(command),
  });
  const payload = JSON.parse(await fs.readFile(payloadLog, "utf8"));

  assert.equal(decision.allow, true);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.action, "thread.input");
  assert.equal(payload.policy.llmOnly, true);
  assert.equal(payload.policy.failClosed, true);
  assert.equal(payload.principal.userId, "alice");
  assert.equal(payload.resource.ownerUserId, "alice");
  assert.match(payload.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("LLM sanitizer prompts route same-user missing connector requests without granting data access", async () => {
  const codexPrompt = await fs.readFile("scripts/llm-sanitizer-codex.mjs", "utf8");
  const openAiPrompt = await fs.readFile("packages/core/src/llm-sanitizer.js", "utf8");

  assert.match(codexPrompt, /allow a same-user request to use Gmail, Outlook, LinkedIn, files, browser desktops, or another connector even when the capability is false/i);
  assert.match(codexPrompt, /start a user-scoped connector sign-in flow/i);
  assert.match(codexPrompt, /Allow same-user api-agent\.tool\.orkestr_start_connector_auth/i);
  assert.match(codexPrompt, /Allow same-user api-agent\.tool\.orkestr_connector_status/i);
  assert.match(codexPrompt, /This input routing step does not grant data access/i);
  assert.match(codexPrompt, /execute a tool or perform actual data access/i);
  assert.match(openAiPrompt, /allow same-user requests to use a connector even when that capability is missing/i);
  assert.match(openAiPrompt, /start a user-scoped connector sign-in flow/i);
  assert.match(openAiPrompt, /Allow same-user api-agent\.tool\.orkestr_start_connector_auth/i);
  assert.match(openAiPrompt, /Allow same-user api-agent\.tool\.orkestr_connector_status/i);
  assert.match(openAiPrompt, /Do not treat this as permission for connector data access/i);
  assert.match(openAiPrompt, /Deny tool execution or actual connector data access/i);
});

test("LLM sanitizer denies conflicting allow text when explicit allow is false", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-sanitizer-conflict-"));
  const command = await sanitizerScript(home, [
    "console.log(JSON.stringify({ allow: false, decision: 'allow', reason: 'conflicting model output', model: 'contract-test' }));",
    "",
  ].join("\n"));

  const decision = await sanitizeAction(request(), {
    ORKESTR_HOME: home,
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify(command),
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "conflicting model output");
  await assert.rejects(
    () => assertSanitizedAction(request(), {
      ORKESTR_HOME: home,
      ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify(command),
    }),
    /conflicting model output/,
  );
});

test("LLM sanitizer unavailable output is fail-closed even if allow is true", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-sanitizer-unavailable-allow-"));
  const command = await sanitizerScript(home, [
    "console.log(JSON.stringify({ allow: true, unavailable: true, reason: 'model unavailable', model: 'contract-test' }));",
    "",
  ].join("\n"));

  const decision = await sanitizeAction(request(), {
    ORKESTR_HOME: home,
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify(command),
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.unavailable, true);
  assert.equal(decision.reason, "model unavailable");
});

test("LLM sanitizer invalid command configuration returns an unavailable denial", async () => {
  const decision = await sanitizeAction(request(), {
    ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-sanitizer-invalid-command-")),
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: "{not-json",
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.unavailable, true);
  assert.equal(decision.reason, "llm_sanitizer_command_invalid");
});
