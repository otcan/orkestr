import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { listEvents } from "../packages/storage/src/store.js";
import {
  cancelClaudeCodeLogin,
  claudeCodeLoginSession,
  startClaudeCodeLogin,
  submitClaudeCodeLoginCode,
} from "../packages/core/src/claude-code-client.js";
import { getClaudeCodeSession } from "../packages/core/src/claude-code-sessions.js";
import {
  createLlmAccountProfile,
  listLlmAccountProfiles,
  resolveLlmAccountProfile,
  revokeLlmAccountProfile,
  updateLlmAccountProfileState,
} from "../packages/core/src/llm-account-profiles.js";
import {
  assertClaudeCodeHostOwner,
  claudeCodeThreadStatus,
  deliverClaudeCodePendingInputs,
  interruptClaudeCodeThread,
  resetClaudeCodeRuntimeForTest,
  sendClaudeCodeInput,
  startClaudeCodeThread,
} from "../packages/core/src/runtime-claude-code-adapter.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages } from "../packages/core/src/threads.js";

async function fixture(t, name = "runtime") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-claude-${name}-`));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const fake = path.join(home, "fake-claude.mjs");
  const calls = path.join(home, "calls.jsonl");
  const delayFile = path.join(home, "delay-ms");
  await fs.writeFile(delayFile, "0", "utf8");
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ authenticated: true, status: "logged_in" }) + "\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write("Open https://claude.com/cai/oauth/authorize?state=fixture to continue\\n");
  process.stdin.setEncoding("utf8");
  process.stdin.once("data", value => {
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ authCodeReceived: Boolean(String(value).trim()) }) + "\\n");
    setTimeout(() => process.exit(0), 50);
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  const resumeAt = args.indexOf("--resume");
  const resumed = resumeAt >= 0 ? args[resumeAt + 1] : "";
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
    args,
    configDir: process.env.CLAUDE_CONFIG_DIR || "",
    leakedApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    prompt: prompt.trim()
  }) + "\\n");
  if (prompt.includes("rate limit")) {
    process.stderr.write("429 usage limit reached\\n");
    process.exit(1);
  }
  const session = resumed || "claude_session_fixture";
  const finish = () => {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: "draft" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", session_id: session, result: "Reply: " + prompt.trim(), is_error: false }) + "\\n");
  };
  setTimeout(finish, Number(fs.readFileSync(${JSON.stringify(delayFile)}, "utf8") || 0));
});
`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_CLAUDE_CODE_ENABLED: "1",
    ORKESTR_CLAUDE_CODE_BIN: fake,
    ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe",
    ANTHROPIC_API_KEY: "must-not-reach-subscription-runtime",
  };
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true });
  });
  return { home, fake, calls, delayFile, env };
}

async function readyProfile(ownerUserId, label, env) {
  const created = await createLlmAccountProfile(ownerUserId, { provider: "claude-code", label, authMode: "subscription" }, env);
  await updateLlmAccountProfileState(ownerUserId, created.id, "ready", { verified: true }, env);
  return created;
}

async function claudeThread(ownerUserId, profileId, env, id = "claude-thread") {
  env.ORKESTR_ADMIN_USER_ID = ownerUserId;
  const thread = await createThread({
    id,
    name: `Claude fixture ${id}`,
    ownerUserId,
    executorId: "claude-code",
    runtimeKind: "claude-code",
    executor: { type: "claude-code", accountProfileId: profileId, metadata: { accountProfileId: profileId, runtimeKind: "claude-code" } },
  }, env);
  return (await startClaudeCodeThread(thread, env)).thread;
}

test("Claude host execution rejects missing, foreign and contained owners before process startup", async (t) => {
  const { env, calls } = await fixture(t, "isolation");
  for (const thread of [{}, { ownerUserId: "tenant" }, { ownerUserId: "admin", securityProfile: "external-user" }]) {
    assert.throws(() => assertClaudeCodeHostOwner(thread, env), /claude_code_admin_runtime_required/);
    await assert.rejects(startClaudeCodeThread(thread, env), /claude_code_admin_runtime_required/);
  }
  assert.doesNotThrow(() => assertClaudeCodeHostOwner({ ownerUserId: "admin" }, env));
  await assert.rejects(fs.access(calls), { code: "ENOENT" });
});

test("Claude account profiles are owner-scoped and public projections redact credential roots", async (t) => {
  const { home, env } = await fixture(t, "profiles");
  const alice = await readyProfile("alice", "Primary", env);
  await readyProfile("bob", "Primary", env);
  const listed = await listLlmAccountProfiles("alice", {}, env);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].state, "ready");
  assert.equal(JSON.stringify(listed).includes(home), false);
  assert.equal("credentialRoot" in listed[0], false);
  await assert.rejects(
    resolveLlmAccountProfile({ ownerUserId: "bob", profileId: alice.id, provider: "claude-code" }, env),
    /llm_account_profile_not_found/,
  );
  await assert.rejects(
    createLlmAccountProfile("alice", { provider: "claude-code", label: "primary" }, env),
    /llm_account_label_conflict/,
  );
  await Promise.all(["Two", "Three", "Four", "Five"].map((label) =>
    createLlmAccountProfile("alice", { provider: "claude-code", label }, env)
  ));
  assert.equal((await listLlmAccountProfiles("alice", {}, env)).length, 5);
});

test("Claude attended login returns only an allowlisted provider URL", async (t) => {
  const { home, env } = await fixture(t, "login");
  const created = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Login", authMode: "subscription" }, env);
  const profile = await resolveLlmAccountProfile({ ownerUserId: "owner", profileId: created.id, provider: "claude-code", requireReady: false }, env);
  const login = await startClaudeCodeLogin(profile, {}, env);
  assert.equal(login.state, "pending");
  assert.match(login.authUrl, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.equal(JSON.stringify(login).includes(home), false);
  assert.equal("output" in login, false);
  await new Promise((resolve) => setTimeout(resolve, 600));
});

test("Claude attended login consumes a one-time authorization code without persisting it", async (t) => {
  const { calls, env } = await fixture(t, "login-code");
  const created = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Login code", authMode: "subscription" }, env);
  const profile = await resolveLlmAccountProfile({ ownerUserId: "owner", profileId: created.id, provider: "claude-code", requireReady: false }, env);
  await startClaudeCodeLogin(profile, {}, env);
  await assert.rejects(submitClaudeCodeLoginCode(profile.id, "not-a-copy-back-code"), /claude_code_login_code_invalid/);
  const submitted = await submitClaudeCodeLoginCode(profile.id, "authorization-code#oauth-state");
  assert.equal(submitted.codeSubmitted, true);
  await assert.rejects(submitClaudeCodeLoginCode(profile.id, "another-code#same-state"), /claude_code_login_code_already_submitted/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const recorded = await fs.readFile(calls, "utf8");
  assert.match(recorded, /"authCodeReceived":true/);
  assert.doesNotMatch(recorded, /authorization-code|oauth-state/);
});

test("Claude attended login drives first-run subscription prompts through a PTY", async (t) => {
  const { home, env } = await fixture(t, "pty-login");
  const marker = path.join(home, "authenticated");
  const fakeClaude = path.join(home, "pty-claude.mjs");
  const fakeTty = path.join(home, "fake-tty.mjs");
  await fs.writeFile(fakeClaude, `#!/usr/bin/env node
import fs from "node:fs";
const authenticated = fs.existsSync(${JSON.stringify(marker)});
process.stdout.write(JSON.stringify({ authenticated, status: authenticated ? "logged_in" : "not_logged_in" }) + "\\n");
process.exit(authenticated ? 0 : 1);
`, { mode: 0o755 });
  await fs.writeFile(fakeTty, `#!/usr/bin/env node
import fs from "node:fs";
let stage = 0;
let authorizationCode = "";
process.stdout.write("Choose the text style that looks best with your terminal\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  for (const character of String(chunk)) {
    if (stage === 0 && (character === "\\r" || character === "\\n")) {
      stage = 1;
      process.stdout.write("Select login method\\n");
    } else if (stage === 1 && (character === "\\r" || character === "\\n")) {
      stage = 2;
      process.stdout.write("Opening browser to sign in\\n");
    } else if (stage === 2 && character.toLowerCase() === "c") {
      stage = 3;
      process.stdout.write("https://claude.com/cai/oauth/authorize?state=pty-fixture\\nPaste code here\\n");
    } else if (stage === 3 && (character === "\\r" || character === "\\n")) {
      if (authorizationCode.includes("#")) fs.writeFileSync(${JSON.stringify(marker)}, "ready", { mode: 0o600 });
      stage = 4;
    } else if (stage === 3) {
      authorizationCode += character;
    }
  }
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const ptyEnv = {
    ...env,
    ORKESTR_CLAUDE_CODE_BIN: fakeClaude,
    ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pty",
    ORKESTR_CLAUDE_CODE_TTY_BIN: fakeTty,
  };
  const created = await createLlmAccountProfile("owner", { provider: "claude-code", label: "PTY login", authMode: "subscription" }, ptyEnv);
  const profile = await resolveLlmAccountProfile({ ownerUserId: "owner", profileId: created.id, provider: "claude-code", requireReady: false }, ptyEnv);
  t.after(() => cancelClaudeCodeLogin(profile.id));

  let login = await startClaudeCodeLogin(profile, {}, ptyEnv);
  assert.equal(login.state, "pending");
  assert.match(login.authUrl, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  await submitClaudeCodeLoginCode(profile.id, "authorization-code#oauth-state");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    login = claudeCodeLoginSession(profile.id);
    if (login?.state === "completed") break;
  }
  assert.equal(login?.state, "completed");
  assert.equal(await fs.readFile(marker, "utf8"), "ready");
});

test("Claude runtime selects the exact profile, strips inherited API credentials, and resumes its session", async (t) => {
  const { home, calls, env } = await fixture(t, "resume");
  const primary = await readyProfile("owner", "Primary", env);
  await readyProfile("owner", "Secondary", env);
  let thread = await claudeThread("owner", primary.id, env);
  await enqueueThreadInput(thread.id, { text: "first request", source: "test" }, env);
  assert.equal((await deliverClaudeCodePendingInputs(thread, env)).length, 1);

  thread = await getThread(thread.id, env);
  assert.equal(await getClaudeCodeSession(thread, env), "claude_session_fixture");
  assert.equal(thread.claudeSessionId, undefined);
  const otherThread = await claudeThread("owner", primary.id, env, "claude-other-thread");
  assert.equal(await getClaudeCodeSession(otherThread, env), "");
  await enqueueThreadInput(thread.id, { text: "second request", source: "test" }, env);
  assert.equal((await deliverClaudeCodePendingInputs(thread, env)).length, 1);

  const recorded = (await fs.readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].leakedApiKey, false);
  assert.equal(recorded[0].configDir.includes(primary.id), true);
  assert.equal(recorded[0].configDir.includes(home), true);
  assert.deepEqual(recorded[1].args.slice(-2), ["--resume", "claude_session_fixture"]);
  const messages = await listThreadMessages(thread.id, env);
  assert.deepEqual(messages.filter((message) => message.role === "assistant").map((message) => message.text), ["Reply: first request", "Reply: second request"]);
  const events = await listEvents(env, 100);
  assert.equal(JSON.stringify(events).includes(recorded[0].configDir), false);
  assert.equal(JSON.stringify(events).includes("must-not-reach-subscription-runtime"), false);
});

test("Claude runtime enforces one active turn and interruption leaves no late assistant mutation", async (t) => {
  const { delayFile, env } = await fixture(t, "interrupt");
  await fs.writeFile(delayFile, "500", "utf8");
  const profile = await readyProfile("owner", "Interrupt", env);
  const thread = await claudeThread("owner", profile.id, env, "claude-interrupt");
  const first = await enqueueThreadInput(thread.id, { text: "long request", source: "test" }, env);
  const running = sendClaudeCodeInput(thread, first, env);
  const second = await enqueueThreadInput(thread.id, { text: "concurrent request", source: "test" }, env);
  await assert.rejects(sendClaudeCodeInput(thread, second, env), /claude_code_turn_active/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await interruptClaudeCodeThread(thread, env)).interrupted, true);
  const result = await running;
  assert.equal(result.interrupted, true);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const messages = await listThreadMessages(thread.id, env);
  assert.equal(messages.some((message) => message.role === "assistant"), false);
  assert.equal(messages.find((message) => message.id === first.id).observedVia, "claude_code_interrupted");
});

test("Claude failures are low-cardinality and profile revocation fences later turns", async (t) => {
  const { env } = await fixture(t, "failures");
  const profile = await readyProfile("owner", "Limited", env);
  let thread = await claudeThread("owner", profile.id, env, "claude-limited");
  const limited = await enqueueThreadInput(thread.id, { text: "trigger rate limit", source: "test" }, env);
  await assert.rejects(sendClaudeCodeInput(thread, limited, env), /claude_code_rate_limited/);
  assert.equal((await listLlmAccountProfiles("owner", {}, env))[0].state, "rate_limited");

  await updateLlmAccountProfileState("owner", profile.id, "ready", { verified: true }, env);
  await revokeLlmAccountProfile("owner", profile.id, env);
  thread = await getThread(thread.id, env);
  assert.equal((await claudeCodeThreadStatus(thread, env)).accountState, "revoked");
  const blocked = await enqueueThreadInput(thread.id, { text: "must not run", source: "test" }, env);
  await assert.rejects(sendClaudeCodeInput(thread, blocked, env), /llm_account_profile_revoked/);
});

test("Claude runtime kill switch fences existing ready threads", async (t) => {
  const { env } = await fixture(t, "disabled");
  const profile = await readyProfile("owner", "Disabled", env);
  const thread = await claudeThread("owner", profile.id, env, "claude-disabled");
  const message = await enqueueThreadInput(thread.id, { text: "must not run", source: "test" }, env);
  await assert.rejects(sendClaudeCodeInput(thread, message, { ...env, ORKESTR_CLAUDE_CODE_ENABLED: "0" }), /claude_code_disabled/);
});

test("Claude API creates a thread with only an opaque exact profile binding", async (t) => {
  const { fake, env } = await fixture(t, "api");
  const profile = await readyProfile("admin", "API profile", env);
  const prior = Object.fromEntries([
    "ORKESTR_CLAUDE_CODE_ENABLED",
    "ORKESTR_CLAUDE_CODE_BIN",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED",
    "ORKESTR_WHATSAPP_AUTOSTART",
    "WHATSAPP_LOCAL_AUTOSTART",
  ].map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ORKESTR_CLAUDE_CODE_ENABLED: "1",
    ORKESTR_CLAUDE_CODE_BIN: fake,
    ORKESTR_AUTH_REQUIRED: "0",
    ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED: "1",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    WHATSAPP_LOCAL_AUTOSTART: "0",
  });
  let server;
  try {
    server = await startServer({ port: 0, host: "127.0.0.1" });
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "claude-api-thread",
        name: "Claude API thread",
        executorId: "claude-code",
        executor: { type: "claude-code", accountProfileId: profile.id },
        wake: false,
      }),
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.thread.runtimeKind, "claude-code");
    assert.equal(payload.thread.executor.accountProfileId, profile.id);
    assert.equal(JSON.stringify(payload).includes("runtimes/claude-code"), false);
    assert.equal(JSON.stringify(payload).includes("claudeSessionId"), false);
    const accountsResponse = await fetch(`http://127.0.0.1:${port}/api/llm-accounts?provider=claude-code`);
    const accounts = await accountsResponse.json();
    assert.equal(accountsResponse.status, 200, JSON.stringify(accounts));
    assert.equal(accounts.enabled, true, JSON.stringify(accounts));
    assert.deepEqual(accounts.accounts.map((account) => account.id), [profile.id]);
    const foreignOwner = await fetch(`http://127.0.0.1:${port}/api/threads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Denied tenant Claude", ownerUserId: "tenant", executorId: "claude-code", executor: { type: "claude-code", accountProfileId: profile.id } }),
    });
    assert.equal(foreignOwner.status, 403);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
