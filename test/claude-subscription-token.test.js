import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLlmAccountProfile, resolveLlmAccountProfile, setClaudeSubscriptionToken, listLlmAccountProfiles,
  publicLlmAccountProfile, revokeLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import { claudeCodeExecutionEnv, claudeCodeRuntimeEnv, claudeCodeLoginStatus, startClaudeCodeLogin } from "../packages/core/src/claude-code-client.js";
import { verifyClaudeCodeInference } from "../packages/core/src/claude-code-verification.js";

const token = `sk-ant-oat01-${"x".repeat(40)}`;
async function fixture(t, result = { type: "result", subtype: "success", is_error: false, result: "OK" }, exitCode = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-subscription-token-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = path.join(root, "claude.mjs");
  await fs.writeFile(command, `#!/usr/bin/env node
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, ${JSON.stringify(token)});
if (args[0] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
assert.equal(args[args.indexOf('--tools') + 1], '');
assert.equal(args[args.indexOf('--setting-sources') + 1], '');
assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
assert.ok(args.includes('--strict-mcp-config'));
assert.ok(args.includes('--no-session-persistence'));
assert.ok(args.includes('--disable-slash-commands'));
assert.equal(args[args.indexOf('--settings') + 1], '{"disableAllHooks":true}');
assert.ok(!args.includes('--resume'));
assert.ok(!args.some(arg => arg.includes('sk-ant-')));
console.log(${JSON.stringify(JSON.stringify(result))});
process.exit(${exitCode});
`, { mode: 0o700 });
  const env = { ORKESTR_HOME: root, ORKESTR_CLAUDE_CODE_BIN: command, ANTHROPIC_API_KEY: "host-secret", CLAUDE_CODE_OAUTH_TOKEN: "host-token" };
  const account = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Worker fixture" }, env);
  const resolve = () => resolveLlmAccountProfile({ ownerUserId: "owner", profileId: account.id, provider: "claude-code", requireReady: false }, env);
  return { root, account, env, resolve };
}

test("long-lived token is profile-scoped, persistent, and absent from projections and inherited login env", async t => {
  const { account, env, resolve } = await fixture(t);
  const saved = await setClaudeSubscriptionToken("owner", account.id, token, env);
  assert.equal(saved.state, "login_required");
  assert.equal(saved.authenticationMethod, "subscription_token");
  assert.equal(saved.credentialRevision, 1);
  assert.equal(publicLlmAccountProfile(saved).authenticationMethod, "subscription_token");
  const profile = await resolve();
  assert.equal(profile.subscriptionToken, undefined);
  assert.equal(claudeCodeRuntimeEnv(profile, {}, env).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal((await claudeCodeExecutionEnv(profile, {}, env)).CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.ok(!JSON.stringify(await listLlmAccountProfiles("owner", {}, env)).includes(token));
  const other = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Other fixture" }, env);
  const otherProfile = await resolveLlmAccountProfile({ ownerUserId: "owner", profileId: other.id, provider: "claude-code", requireReady: false }, env);
  assert.equal((await claudeCodeExecutionEnv(otherProfile, {}, env)).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  await assert.rejects(setClaudeSubscriptionToken("other-owner", account.id, token, env), { code: "llm_account_profile_not_found" });
  await assert.rejects(startClaudeCodeLogin(profile, {}, env), { message: "claude_subscription_token_rotation_required" });
});

test("only a successful model request verifies a token; cached auth is insufficient", async t => {
  const { account, env, resolve } = await fixture(t, { type: "result", is_error: true, result: "401 invalid authentication credentials" }, 1);
  await setClaudeSubscriptionToken("owner", account.id, token, env);
  const profile = await resolve();
  assert.equal((await claudeCodeLoginStatus(profile, {}, env)).authenticated, true);
  const result = await verifyClaudeCodeInference(profile, env);
  assert.equal(result.authenticated, false);
  assert.equal(result.reason, "claude_code_auth_required");
  assert.ok(!JSON.stringify(result).includes(token));
});

test("model verification has tools/hooks/MCP disabled and removes its scratch directory", async t => {
  const { account, env, resolve } = await fixture(t);
  await setClaudeSubscriptionToken("owner", account.id, token, env);
  const profile = await resolve();
  const result = await verifyClaudeCodeInference(profile, env);
  assert.equal(result.authenticated, true);
  assert.equal(result.verificationKind, "model_request");
  assert.deepEqual(await fs.readdir(path.join(profile.credentialRoot, "tmp")), []);
});

for (const [result, reason] of [
  [{ authenticated: true }, "claude_code_verification_invalid_response"],
  [{ type: "result", subtype: "success", is_error: false, result: "not OK" }, "claude_code_verification_invalid_response"],
  [{ type: "result", is_error: true, result: "429 rate limit" }, "claude_code_rate_limited"],
]) {
  test(`verification rejects insufficient evidence: ${reason}`, async t => {
    const { account, env, resolve } = await fixture(t, result);
    await setClaudeSubscriptionToken("owner", account.id, token, env);
    const status = await verifyClaudeCodeInference(await resolve(), env);
    assert.equal(status.authenticated, false);
    assert.equal(status.reason, reason);
  });
}

test("rotation fences old verification and runtime failures; revocation is terminal", async t => {
  const { account, env, resolve } = await fixture(t);
  await setClaudeSubscriptionToken("owner", account.id, token, env);
  const old = await resolve();
  await setClaudeSubscriptionToken("owner", account.id, token, env);
  for (const state of ["ready", "login_required", "rate_limited"]) {
    await assert.rejects(updateLlmAccountProfileState("owner", account.id, state, { credentialRevision: old.credentialRevision }, env), { code: "llm_account_credentials_changed" });
  }
  await assert.rejects(claudeCodeExecutionEnv(old, {}, env), { code: "llm_account_credentials_changed" });
  const current = await resolve();
  await revokeLlmAccountProfile("owner", account.id, env);
  await assert.rejects(claudeCodeExecutionEnv(current, {}, env), { code: "llm_account_profile_revoked" });
  await assert.rejects(setClaudeSubscriptionToken("owner", account.id, token, env), { code: "llm_account_profile_revoked" });
});

test("reject API keys, invalid token input and arbitrary paths without echoing input", async t => {
  const { account, env } = await fixture(t);
  for (const value of ["sk-ant-api03-secret", "/tmp/token", "", token + "\nextra", {}, "sk-ant-oat01-" + "x".repeat(5000)]) {
    await assert.rejects(setClaudeSubscriptionToken("owner", account.id, value, env), { code: "claude_subscription_token_invalid" });
  }
});
