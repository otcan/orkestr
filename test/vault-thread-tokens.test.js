import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread } from "../packages/core/src/threads.js";
import { agentThreadIdFromRequest } from "../packages/core/src/vault-access.js";
import { agentListItems, agentReadSecret } from "../packages/core/src/vault-agent.js";
import { createVaultItem, setVaultGrants } from "../packages/core/src/vault-service.js";
import { issueVaultThreadToken, revokeVaultThreadTokens, threadIdForVaultToken } from "../packages/core/src/vault-thread-tokens.js";
import { userPrincipal } from "../packages/core/src/principal.js";

// Synthetic users, threads and values only.

const PASSWORD = "synthetic-thread-token-password-7d2a";
let home;
let env;

test.before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-vault-thread-tokens-"));
  env = { ...process.env, ORKESTR_HOME: home };
  delete env.ORKESTR_VAULT_ALLOW_LEGACY_THREAD_ID;
  await createThread({ id: "alice-a", name: "Alice A", ownerUserId: "alice" }, env);
  await createThread({ id: "alice-b", name: "Alice B", ownerUserId: "alice" }, env);
});

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function req(token) {
  return { headers: token ? { "x-orkestr-thread-token": token } : {} };
}

test("agent thread comes from the token; a named thread id is not trusted", async () => {
  const tokenA = await issueVaultThreadToken({ threadId: "alice-a", attemptId: "turn-1" }, env);
  assert.match(tokenA, /^ovt_[A-Za-z0-9_-]{43}$/);
  assert.equal(await agentThreadIdFromRequest(req(tokenA), "", env), "alice-a");
  assert.equal(await agentThreadIdFromRequest(req(tokenA), "alice-a", env), "alice-a");
  await assert.rejects(agentThreadIdFromRequest(req(tokenA), "alice-b", env), { code: "vault_thread_token_mismatch", statusCode: 403 });
  await assert.rejects(agentThreadIdFromRequest(req(""), "alice-b", env), { code: "vault_thread_token_required", statusCode: 401 });
  await assert.rejects(agentThreadIdFromRequest(req("ovt_unknown"), "", env), { code: "vault_thread_token_invalid", statusCode: 401 });
  await assert.rejects(agentThreadIdFromRequest(req("not-a-token"), "", env), { code: "vault_thread_token_invalid" });

  const stored = await fs.readFile(path.join(home, "secrets", "vault-thread-tokens.json"), "utf8");
  assert.equal(stored.includes(tokenA), false, "only a hash is stored");
  assert.equal(stored.includes(tokenA.slice(4)), false);
});

test("thread A cannot use thread B's grants", async () => {
  const alice = { ...userPrincipal({ id: "alice" }), vaultOwner: true, authenticatedAt: new Date().toISOString() };
  const { item } = await createVaultItem(alice, { name: "B only", username: "b@example.com", password: PASSWORD }, env);
  await setVaultGrants(alice, item.id, ["alice-b"], env);
  const tokenA = await issueVaultThreadToken({ threadId: "alice-a" }, env);
  const tokenB = await issueVaultThreadToken({ threadId: "alice-b" }, env);
  const threadA = await agentThreadIdFromRequest(req(tokenA), "", env);
  assert.deepEqual((await agentListItems(threadA, env)).items, []);
  await assert.rejects(agentReadSecret(threadA, item.id, ["password"], env), { code: "vault_item_not_found" });
  await assert.rejects(agentThreadIdFromRequest(req(tokenA), "alice-b", env), { code: "vault_thread_token_mismatch" });
  const threadB = await agentThreadIdFromRequest(req(tokenB), "", env);
  assert.equal((await agentReadSecret(threadB, item.id, ["password"], env)).password, PASSWORD);
});

test("revoked and expired tokens fail", async () => {
  const first = await issueVaultThreadToken({ threadId: "alice-a", attemptId: "turn-x" }, env);
  const second = await issueVaultThreadToken({ threadId: "alice-a", attemptId: "turn-y" }, env);
  assert.equal(await revokeVaultThreadTokens({ threadId: "alice-a", attemptId: "turn-x" }, env), 1);
  assert.equal(await threadIdForVaultToken(first, env), "");
  assert.equal(await threadIdForVaultToken(second, env), "alice-a", "other turns keep their token");
  await revokeVaultThreadTokens({ threadId: "alice-a" }, env);
  assert.equal(await threadIdForVaultToken(second, env), "");

  const expiring = await issueVaultThreadToken({ threadId: "alice-a", ttlMs: 60_000 }, env);
  const file = path.join(home, "secrets", "vault-thread-tokens.json");
  const store = JSON.parse(await fs.readFile(file, "utf8"));
  for (const entry of store.tokens) entry.expiresAt = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(file, JSON.stringify(store));
  assert.equal(await threadIdForVaultToken(expiring, env), "");
  await assert.rejects(agentThreadIdFromRequest(req(expiring), "", env), { code: "vault_thread_token_invalid" });
});

test("legacy caller-named thread ids need the explicit rollout flag", async () => {
  const legacy = { ...env, ORKESTR_VAULT_ALLOW_LEGACY_THREAD_ID: "1" };
  assert.equal(await agentThreadIdFromRequest(req(""), "alice-b", legacy), "alice-b");
  const tokenA = await issueVaultThreadToken({ threadId: "alice-a" }, legacy);
  await assert.rejects(agentThreadIdFromRequest(req(tokenA), "alice-b", legacy), { code: "vault_thread_token_mismatch" });
});
