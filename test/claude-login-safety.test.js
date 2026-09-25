import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeCodeLoginStatus } from "../packages/core/src/claude-code-client.js";
import { createLlmAccountProfile, listLlmAccountProfiles, revokeLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import { resolveClaudeCodeRuntimeProfile } from "../packages/core/src/claude-code-rate-limit.js";

async function fixture(t, output, delayed = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-claude-login-safety-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = path.join(root, "fake-claude.mjs");
  const started = path.join(root, "started");
  const release = path.join(root, "release");
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(started)}, 'started');
${delayed ? `while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));` : ""}
process.stdout.write(${JSON.stringify(output)});
`, { mode: 0o700 });
  return { root, started, release, env: { ORKESTR_HOME: root, ORKESTR_CLAUDE_CODE_BIN: command } };
}

for (const output of [
  '{"authenticated":false}',
  '{"loggedIn":false,"message":"previously authenticated"}',
  '{"authenticated":false,"status":"authenticated"}',
  '{"status":"unknown","message":"authenticated"}',
  '{"authenticated":true,"status":"logged_out"}',
  '{"authenticated":true',
  'null',
  '[{"authenticated":true}]',
  'Not authenticated',
  'Previously authenticated',
]) {
  test(`Claude login verification rejects negative or unknown evidence: ${output}`, async (t) => {
    const { root, env } = await fixture(t, output);
    const status = await claudeCodeLoginStatus({ credentialRoot: root }, {}, env);
    assert.equal(status.authenticated, false);
    assert.equal(status.reason, "not_logged_in");
  });
}

for (const output of ['{"authenticated":true}', '{"loggedIn":true}', '{"status":"logged_in"}', 'Authenticated']) {
  test(`Claude login verification accepts explicit positive evidence: ${output}`, async (t) => {
    const { root, env } = await fixture(t, output);
    assert.equal((await claudeCodeLoginStatus({ credentialRoot: root }, {}, env)).authenticated, true);
  });
}

test("revocation is terminal across late verification and runtime failure writes", async (t) => {
  const { env } = await fixture(t, '{"authenticated":true}');
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Safety fixture" }, env);
  const revoked = await revokeLlmAccountProfile("owner", profile.id, env);
  assert.deepEqual(await revokeLlmAccountProfile("owner", profile.id, env), revoked);
  for (const state of ["ready", "rate_limited", "login_required", "error"]) {
    await assert.rejects(updateLlmAccountProfileState("owner", profile.id, state, { verified: true }, env), { code: "llm_account_profile_revoked" });
  }
  const [current] = await listLlmAccountProfiles("owner", { includeRevoked: true }, env);
  assert.deepEqual(current, revoked);
});

test("a delayed quota recovery cannot resurrect a concurrently revoked profile", async (t) => {
  const { started, release, env } = await fixture(t, '{"authenticated":true}', true);
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Recovery fixture" }, env);
  await updateLlmAccountProfileState("owner", profile.id, "rate_limited", {}, env);
  const thread = {
    id: "fixture-thread", ownerUserId: "owner", executor: { accountProfileId: profile.id },
    claudeRateLimits: { primary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) - 60 } },
  };
  const recovery = resolveClaudeCodeRuntimeProfile(thread, env).then(value => ({ value }), error => ({ error }));
  try {
    const deadline = Date.now() + 5000;
    while (!(await fs.stat(started).catch(() => null))) {
      assert.ok(Date.now() < deadline, "fake auth process started within bound");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await revokeLlmAccountProfile("owner", profile.id, env);
  } finally {
    await fs.writeFile(release, "release");
  }
  const result = await recovery;
  assert.equal(result.error?.code, "llm_account_profile_revoked");
  assert.equal((await listLlmAccountProfiles("owner", { includeRevoked: true }, env))[0].state, "revoked");
});

test("expired quota does not recover a profile with a negative login status", async (t) => {
  const { env } = await fixture(t, '{"authenticated":false}');
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Negative recovery fixture" }, env);
  await updateLlmAccountProfileState("owner", profile.id, "rate_limited", {}, env);
  const thread = {
    id: "fixture-thread", ownerUserId: "owner", executor: { accountProfileId: profile.id },
    claudeRateLimits: { primary: { used_percent: 100, resets_at: Math.floor(Date.now() / 1000) - 60 } },
  };
  await assert.rejects(resolveClaudeCodeRuntimeProfile(thread, env), { code: "claude_code_rate_limited" });
  assert.equal((await listLlmAccountProfiles("owner", {}, env))[0].state, "rate_limited");
});
