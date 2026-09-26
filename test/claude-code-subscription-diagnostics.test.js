import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claudeCodeAccountDiagnostics,
  publicClaudeSubscriptionDiagnostics,
  resetClaudeCodeDiagnosticsForTest,
} from "../packages/core/src/claude-code-subscription-diagnostics.js";
import {
  createLlmAccountProfile,
  listLlmAccountProfiles,
  resolveLlmAccountProfile,
  revokeLlmAccountProfile,
  updateLlmAccountProfileState,
} from "../packages/core/src/llm-account-profiles.js";

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-diag-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeCliFixture(t, output) {
  const dir = await tmpDir(t);
  const command = path.join(dir, "fake-claude.mjs");
  await fs.writeFile(command, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0]==="auth"&&args[1]==="status") { process.stdout.write(${JSON.stringify(output)}); process.exit(0); }\nprocess.exit(1);\n`, { mode: 0o700 });
  t.after(() => resetClaudeCodeDiagnosticsForTest());
  return { dir, env: { ORKESTR_HOME: dir, ORKESTR_CLAUDE_CODE_BIN: command } };
}

// --- publicClaudeSubscriptionDiagnostics pure-function tests ---

test("publicClaudeSubscriptionDiagnostics reports authenticated from probe result", () => {
  const diag = publicClaudeSubscriptionDiagnostics(
    { id: "llm_x", state: "ready", authMode: "subscription", lastVerifiedAt: "2026-01-01T00:00:00.000Z" },
    { authenticated: true, available: true, subscriptionType: "pro", authMethod: "claude.ai", apiProvider: "firstParty" },
  );
  assert.equal(diag.authenticated, true);
  assert.equal(diag.available, true);
  assert.equal(diag.providerReportedSubscription?.tier, "pro");
  assert.equal(diag.authMethod, "claude.ai");
  assert.equal(diag.apiProvider, "firstParty");
  assert.equal(diag.lastVerifiedAt, "2026-01-01T00:00:00.000Z");
});

test("publicClaudeSubscriptionDiagnostics reports authenticated false when probe says false", () => {
  const diag = publicClaudeSubscriptionDiagnostics(
    { id: "llm_x", state: "login_required" },
    { authenticated: false, available: true },
  );
  assert.equal(diag.authenticated, false);
  assert.equal(diag.profileState, "login_required");
});

test("publicClaudeSubscriptionDiagnostics multiplierReported is always null", () => {
  for (const tier of ["pro", "max", "team", "enterprise", "free", "max_20x"]) {
    const diag = publicClaudeSubscriptionDiagnostics(
      { id: "llm_x", state: "ready", label: `Claude ${tier}` },
      { authenticated: true, available: true, subscriptionType: tier },
    );
    assert.strictEqual(diag.multiplierReported, null, `multiplierReported must be null for tier: ${tier}`);
  }
});

test("publicClaudeSubscriptionDiagnostics observedQuota is always null (auth status does not report quota)", () => {
  const diag = publicClaudeSubscriptionDiagnostics({ id: "llm_x", state: "ready" }, { authenticated: true, available: true });
  assert.strictEqual(diag.observedQuota, null);
});

test("publicClaudeSubscriptionDiagnostics does not include credential root, token, email, or session ID", () => {
  const profile = {
    id: "llm_x", state: "ready", authMode: "subscription",
    credentialRoot: "/home/user/.orkestr/secrets/llm/llm_x",
    ownerUserId: "owner@example.com",
    sessionId: "sess_abc123",
    token: "sk-ant-abc123",
  };
  const diag = publicClaudeSubscriptionDiagnostics(profile, { authenticated: true, available: true });
  const serialized = JSON.stringify(diag);
  assert.equal(serialized.includes("credentialRoot"), false);
  assert.equal(serialized.includes("owner@example.com"), false);
  assert.equal(serialized.includes("sess_abc123"), false);
  assert.equal(serialized.includes("sk-ant-abc123"), false);
  assert.equal(serialized.includes("/home/user"), false);
});

test("publicClaudeSubscriptionDiagnostics null probe yields unauthenticated with nulls", () => {
  const diag = publicClaudeSubscriptionDiagnostics({ id: "llm_x", state: "ready" }, null);
  assert.equal(diag.authenticated, false);
  assert.strictEqual(diag.providerReportedSubscription, null);
  assert.strictEqual(diag.observedQuota, null);
  assert.strictEqual(diag.multiplierReported, null);
});

test("publicClaudeSubscriptionDiagnostics generatedAt is a valid ISO timestamp", () => {
  const diag = publicClaudeSubscriptionDiagnostics({ id: "llm_x", state: "ready" }, null);
  assert.ok(Number.isFinite(Date.parse(diag.generatedAt)));
});

test("publicClaudeSubscriptionDiagnostics does not modify a frozen input profile", () => {
  const profile = Object.freeze({ id: "llm_x", state: "ready", authMode: "subscription" });
  assert.doesNotThrow(() => publicClaudeSubscriptionDiagnostics(profile, null));
});

test("subscriptionType with unsafe characters is rejected by allowlist", () => {
  const diag = publicClaudeSubscriptionDiagnostics(
    { id: "llm_x", state: "ready" },
    { authenticated: true, available: true, subscriptionType: "pro; rm -rf /" },
  );
  assert.strictEqual(diag.providerReportedSubscription, null);
});

test("subscriptionType with email-like value is rejected", () => {
  const diag = publicClaudeSubscriptionDiagnostics(
    { id: "llm_x", state: "ready" },
    { authenticated: true, available: true, subscriptionType: "user@example.com" },
  );
  assert.strictEqual(diag.providerReportedSubscription, null);
});

test("authMethod and apiProvider with unsafe characters are rejected", () => {
  const diag = publicClaudeSubscriptionDiagnostics(
    { id: "llm_x", state: "ready" },
    { authenticated: true, available: true, authMethod: "../../etc/passwd", apiProvider: "DROP TABLE users" },
  );
  assert.strictEqual(diag.authMethod, null);
  assert.strictEqual(diag.apiProvider, null);
});

// --- claudeCodeAccountDiagnostics integration tests with fake CLI ---

test("claudeCodeAccountDiagnostics returns authenticated from positive CLI output", async (t) => {
  const { dir, env } = await fakeCliFixture(t, JSON.stringify({ authenticated: true, status: "logged_in", subscriptionType: "pro", authMethod: "claude.ai", apiProvider: "firstParty" }));
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Diag test" }, env);
  const resolved = await resolveLlmAccountProfile({ ownerUserId: "owner", profileId: profile.id, provider: "claude-code", requireReady: false }, env);
  const diag = await claudeCodeAccountDiagnostics(resolved, env);
  assert.equal(diag.authenticated, true);
  assert.equal(diag.available, true);
  assert.equal(diag.providerReportedSubscription?.tier, "pro");
  assert.equal(diag.authMethod, "claude.ai");
  assert.equal(diag.apiProvider, "firstParty");
  assert.strictEqual(diag.multiplierReported, null);
  assert.strictEqual(diag.observedQuota, null);
  assert.equal(JSON.stringify(diag).includes(dir), false, "response must not contain credential root path");
});

test("claudeCodeAccountDiagnostics returns unauthenticated from negative CLI output", async (t) => {
  const { dir, env } = await fakeCliFixture(t, JSON.stringify({ authenticated: false }));
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Diag unauth test" }, env);
  const resolved = await resolveLlmAccountProfile({ ownerUserId: "owner", profileId: profile.id, provider: "claude-code", requireReady: false }, env);
  const diag = await claudeCodeAccountDiagnostics(resolved, env);
  assert.equal(diag.authenticated, false);
  assert.equal(diag.available, true);
  assert.equal(JSON.stringify(diag).includes(dir), false);
});

test("claudeCodeAccountDiagnostics does not update profile state or append events", async (t) => {
  const { env } = await fakeCliFixture(t, JSON.stringify({ authenticated: true, status: "logged_in" }));
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "No-mutation test" }, env);
  const stateBefore = profile.state;
  const resolved = await resolveLlmAccountProfile({ ownerUserId: "owner", profileId: profile.id, provider: "claude-code", requireReady: false }, env);
  await claudeCodeAccountDiagnostics(resolved, env);
  // Profile state must not have changed
  const [current] = await listLlmAccountProfiles("owner", {}, env);
  assert.equal(current.state, stateBefore, "diagnostics must not mutate profile state");
  assert.equal(current.lastVerifiedAt, profile.lastVerifiedAt, "diagnostics must not update lastVerifiedAt");
});

test("claudeCodeAccountDiagnostics coalesces concurrent requests for same profile", async (t) => {
  const dir = await tmpDir(t);
  const command = path.join(dir, "fake-claude-coalesce");
  await fs.writeFile(command, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0]==="auth"&&args[1]==="status") { process.stdout.write(JSON.stringify({ authenticated: true })); process.exit(0); }\nprocess.exit(1);\n`, { mode: 0o700 });
  const env = { ORKESTR_HOME: dir, ORKESTR_CLAUDE_CODE_BIN: command };
  t.after(() => resetClaudeCodeDiagnosticsForTest());
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Coalesce test" }, env);
  const resolved = await resolveLlmAccountProfile({ ownerUserId: "owner", profileId: profile.id, provider: "claude-code", requireReady: false }, env);
  // Fire two concurrent diagnostics calls — should coalesce to one CLI probe
  const [r1, r2] = await Promise.all([
    claudeCodeAccountDiagnostics(resolved, env),
    claudeCodeAccountDiagnostics(resolved, env),
  ]);
  assert.equal(r1.profileId, r2.profileId);
  assert.equal(r1.generatedAt, r2.generatedAt, "coalesced calls must return the same result object");
});

test("claudeCodeAccountDiagnostics 5-second cache prevents duplicate CLI probes", async (t) => {
  const { env } = await fakeCliFixture(t, JSON.stringify({ authenticated: true }));
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Cache test" }, env);
  const resolved = await resolveLlmAccountProfile({ ownerUserId: "owner", profileId: profile.id, provider: "claude-code", requireReady: false }, env);
  const first = await claudeCodeAccountDiagnostics(resolved, env);
  const second = await claudeCodeAccountDiagnostics(resolved, env);
  // Same result within cooldown window
  assert.equal(first.generatedAt, second.generatedAt, "within cooldown, result must be cached");
});

// --- Ownership and revocation guard tests ---

test("revoked profile is rejected by resolveLlmAccountProfile before diagnostics can run", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Revoke diag test" }, env);
  await revokeLlmAccountProfile("owner", profile.id, env);
  await assert.rejects(
    resolveLlmAccountProfile({ ownerUserId: "owner", profileId: profile.id, provider: "claude-code", requireReady: false }, env),
    { code: "llm_account_profile_revoked" },
  );
});

test("profile from a different owner is rejected before diagnostics can run", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const alice = await createLlmAccountProfile("alice", { provider: "claude-code", label: "Alice diag" }, env);
  await assert.rejects(
    resolveLlmAccountProfile({ ownerUserId: "bob", profileId: alice.id, provider: "claude-code", requireReady: false }, env),
    { code: "llm_account_profile_not_found" },
  );
});

// --- API/UI source assertions ---

test("llm-accounts component references diagnostics API, does not contain credential paths or session IDs", async () => {
  const source = await fs.readFile(
    new URL("../apps/web/src/app/llm-accounts.component.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /llmAccountDiagnostics/);
  assert.match(source, /toggleDiagnostics/);
  assert.match(source, /multiplierReported|multiplier/i);
  assert.doesNotMatch(source, /credentialRoot|CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY/);
  assert.doesNotMatch(source, /sessionId|claudeSessionId/);
});

test("api.service.ts has GET diagnostics method and LlmAccountDiagnostics interface", async () => {
  const source = await fs.readFile(
    new URL("../apps/web/src/app/api.service.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /LlmAccountDiagnostics/);
  assert.match(source, /llmAccountDiagnostics/);
  assert.match(source, /\/diagnostics/);
  // Scope the GET/POST check to the llmAccountDiagnostics method body only.
  // A file-wide /http\.post.*diagnostics/s would cross-match startGmailOAuth's
  // correct POST call against the word "diagnostics" later in the file (false negative).
  const diagMethodLines = source.split("\n").slice(
    source.split("\n").findIndex((l) => l.includes("llmAccountDiagnostics(")),
    source.split("\n").findIndex((l) => l.includes("llmAccountDiagnostics(")) + 4,
  ).join("\n");
  assert.ok(diagMethodLines.length > 0, "llmAccountDiagnostics method must be present");
  assert.match(diagMethodLines, /http\.get/);
  assert.doesNotMatch(diagMethodLines, /http\.post/);
});

test("diagnostics controller endpoint is GET not POST and has no appendEvent call", async () => {
  const source = await fs.readFile(
    new URL("../apps/server/src/modules/llm-accounts/llm-accounts.controller.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /Get.*profileId.*diagnostics|diagnostics.*Get/s);
  assert.match(source, /claudeCodeAccountDiagnostics/);
  // The diagnostics method body must not contain appendEvent or updateLlmAccountProfileState
  const diagMethod = source.match(/@Get\(".*?\/diagnostics"\)[\s\S]*?(?=\n\s+@)/)?.[0] || "";
  assert.ok(diagMethod.length > 0, "diagnostics method found");
  assert.equal(diagMethod.includes("appendEvent"), false, "diagnostics must not call appendEvent");
  assert.equal(diagMethod.includes("updateLlmAccountProfileState"), false, "diagnostics must not update profile state");
});
