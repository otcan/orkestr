import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const files = {
  accounts: new URL("../apps/web/src/app/llm-accounts.component.ts", import.meta.url),
  api: new URL("../apps/web/src/app/api.service.ts", import.meta.url),
  wizard: new URL("../apps/web/src/app/first-thread-wizard.component.ts", import.meta.url),
  wizardTemplate: new URL("../apps/web/src/app/first-thread-wizard.component.html", import.meta.url),
  controller: new URL("../apps/server/src/modules/threads/threads.controller.ts", import.meta.url),
  summary: new URL("../apps/server/src/thread-summary.ts", import.meta.url),
};

test("Claude account UI uses opaque profiles and attended login APIs", async () => {
  const [accounts, api] = await Promise.all([fs.readFile(files.accounts, "utf8"), fs.readFile(files.api, "utf8")]);
  assert.match(accounts, /Add Claude subscription/);
  assert.match(accounts, /window\.open\("about:blank", "_blank"\)/);
  assert.match(accounts, /authWindow\.opener = null/);
  assert.match(accounts, /authWindow\.location\.href = login\.authUrl/);
  assert.match(accounts, /One-time authorization code/);
  assert.match(accounts, /submitLlmAccountLoginCode\(account\.id, code\)/);
  assert.match(accounts, /this\.authorizationCode = ""/);
  assert.match(api, /\/login\/code/);
  assert.match(api, /\/llm-accounts/);
  assert.doesNotMatch(accounts, /credentialRoot|CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY/);
});

test("new-thread UI binds Claude to a selected server account profile", async () => {
  const [wizard, template] = await Promise.all([
    fs.readFile(files.wizard, "utf8"),
    fs.readFile(files.wizardTemplate, "utf8"),
  ]);
  assert.match(template, /Claude Code/);
  assert.match(wizard, /executorId: this\.runtimeProvider/);
  assert.match(wizard, /type: "claude-code"/);
  assert.match(wizard, /accountProfileId: this\.claudeAccountProfileId/);
  assert.doesNotMatch(wizard, /credentialRoot|CLAUDE_CONFIG_DIR|claudeSessionId/);
});

test("server projections expose shared Claude controls without provider sessions", async () => {
  const [controller, summary] = await Promise.all([
    fs.readFile(files.controller, "utf8"),
    fs.readFile(files.summary, "utf8"),
  ]);
  assert.doesNotMatch(summary, /claudeSessionId/);
  assert.match(controller, /claude_code_approval_bridge_unavailable/);
  assert.match(controller, /readClaudeModelControls/);
  assert.match(controller, /changeClaudeModelControls/);
  assert.match(summary, /claudeRateLimits/);
  assert.match(controller, /claude_code_raw_terminal_attach_unsupported/);
});
