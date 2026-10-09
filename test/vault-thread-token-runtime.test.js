import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import { resetClaudeCodeRuntimeForTest, sendClaudeCodeInput, startClaudeCodeThread } from "../packages/core/src/runtime-claude-code-adapter.js";
import { createThread, enqueueThreadInput, listThreadMessages } from "../packages/core/src/threads.js";
import { threadIdForVaultToken } from "../packages/core/src/vault-thread-tokens.js";

// A fake Claude CLI records the injected vault thread token, then waits for
// the test to check it before finishing the turn. Synthetic values only.

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function treeIncludes(root, value) {
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    if (entry.name === "token.txt") continue;
    if (entry.isDirectory() ? await treeIncludes(full, value) : (await fs.readFile(full, "utf8").catch(() => "")).includes(value)) return true;
  }
  return false;
}

for (const detached of ["1", "0"]) {
  test(`claude turns get a thread-bound vault token revoked at turn end (detached=${detached})`, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-vault-token-runtime-"));
    t.after(async () => {
      resetClaudeCodeRuntimeForTest();
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    const tokenFile = path.join(home, "token.txt");
    const goFile = path.join(home, "go");
    const fake = path.join(home, "fake-claude.sh");
    await fs.writeFile(fake, `#!/bin/sh
case "$1" in auth) echo '{"authenticated":true,"status":"logged_in"}'; exit 0;; esac
read -r prompt
printf '%s' "$ORKESTR_VAULT_THREAD_TOKEN" > ${JSON.stringify(tokenFile)}
echo '{"type":"system","subtype":"init","session_id":"token-session"}'
while [ ! -f ${JSON.stringify(goFile)} ]; do sleep 0.05; done
printf '{"type":"result","session_id":"token-session","is_error":false,"result":"Reply: %s"}\\n' "$prompt"
`, { mode: 0o755 });
    const env = {
      ORKESTR_HOME: home,
      ORKESTR_ADMIN_USER_ID: "owner",
      ORKESTR_CLAUDE_CODE_ENABLED: "1",
      ORKESTR_CLAUDE_CODE_BIN: fake,
      ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe",
      ORKESTR_CLAUDE_DETACHED_TURNS: detached,
      ORKESTR_CLAUDE_DETACHED_POLL_MS: "10",
    };
    const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Token", authMode: "subscription" }, env);
    await updateLlmAccountProfileState("owner", profile.id, "ready", { verified: true }, env);
    const created = await createThread({
      id: `claude-token-${detached}`,
      name: "Claude token",
      ownerUserId: "owner",
      executorId: "claude-code",
      runtimeKind: "claude-code",
      executor: { type: "claude-code", accountProfileId: profile.id, metadata: { accountProfileId: profile.id, runtimeKind: "claude-code" } },
    }, env);
    const thread = (await startClaudeCodeThread(created, env)).thread;
    const input = await enqueueThreadInput(thread.id, { text: "hello", source: "test" }, env);
    const turn = sendClaudeCodeInput(thread, input, env);

    const token = await waitFor(async () => (await fs.readFile(tokenFile, "utf8").catch(() => "")).trim());
    assert.match(token, /^ovt_/);
    assert.equal(await threadIdForVaultToken(token, env), thread.id, "token is bound to this thread during the turn");
    await fs.writeFile(goFile, "");
    await turn;
    await waitFor(async () => (await listThreadMessages(thread.id, env)).some((message) => message.phase === "final_answer"));
    await waitFor(async () => (await threadIdForVaultToken(token, env)) === "");

    const messages = JSON.stringify(await listThreadMessages(thread.id, env));
    assert.equal(messages.includes(token), false, "no token in thread messages");
    assert.equal(await treeIncludes(home, token), false, "no token in events, logs, perf log or turn records");
  });
}
