import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import { agentThreadIdFromRequest } from "../packages/core/src/vault-access.js";
import { agentListItems, agentReadSecret } from "../packages/core/src/vault-agent.js";
import {
  bindCodexVaultTurnToken,
  codexVaultTokenFile,
  issueCodexVaultTurnToken,
  readCodexVaultTurnToken,
  revokeCodexVaultTurnToken,
} from "../packages/core/src/vault-codex-turn-tokens.js";
import { createVaultItem, setVaultGrants } from "../packages/core/src/vault-service.js";
import { threadIdForVaultToken } from "../packages/core/src/vault-thread-tokens.js";

// Synthetic users, threads, Codex ids and values only.

const PASSWORD = "synthetic-codex-token-password-41c9";
let home;
let env;

test.before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-vault-codex-tokens-"));
  env = { ...process.env, ORKESTR_HOME: home };
  delete env.ORKESTR_VAULT_ALLOW_LEGACY_THREAD_ID;
  await createThread({ id: "codex-a", name: "Codex A", ownerUserId: "alice" }, env);
  await createThread({ id: "codex-b", name: "Codex B", ownerUserId: "alice" }, env);
});

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function req(token) {
  return { headers: token ? { "x-orkestr-thread-token": token } : {} };
}

const codexEnv = (codexThreadId) => ({ CODEX_THREAD_ID: codexThreadId });

test("codex turn token files are private and resolve to their own thread only", async () => {
  const alice = { ...userPrincipal({ id: "alice" }), vaultOwner: true, authenticatedAt: new Date().toISOString() };
  const { item } = await createVaultItem(alice, { name: "B only", username: "b@example.com", password: PASSWORD }, env);
  await setVaultGrants(alice, item.id, ["codex-b"], env);
  assert.ok(await issueCodexVaultTurnToken({ threadId: "codex-a", codexThreadId: "thr_a" }, env));
  assert.ok(await issueCodexVaultTurnToken({ threadId: "codex-b", codexThreadId: "thr_b" }, env));

  const file = codexVaultTokenFile("thr_a", home);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal(path.basename(file).includes("thr_a"), false, "file name does not echo the Codex id");

  const tokenA = await readCodexVaultTurnToken(codexEnv("thr_a"), home);
  const tokenB = await readCodexVaultTurnToken(codexEnv("thr_b"), home);
  assert.match(tokenA, /^ovt_/);
  assert.notEqual(tokenA, tokenB);
  assert.equal(await readCodexVaultTurnToken({}, home), "", "no CODEX_THREAD_ID, no token");

  const threadA = await agentThreadIdFromRequest(req(tokenA), "", env);
  assert.equal(threadA, "codex-a");
  assert.deepEqual((await agentListItems(threadA, env)).items, []);
  await assert.rejects(agentReadSecret(threadA, item.id, ["password"], env), { code: "vault_item_not_found" });
  await assert.rejects(agentThreadIdFromRequest(req(tokenA), "codex-b", env), { code: "vault_thread_token_mismatch" });
  const threadB = await agentThreadIdFromRequest(req(tokenB), "", env);
  assert.equal((await agentReadSecret(threadB, item.id, ["password"], env)).password, PASSWORD);
});

test("turn completion revokes the token; a late completion of an older turn does not", async () => {
  const first = await issueCodexVaultTurnToken({ threadId: "codex-a", codexThreadId: "thr_late" }, env);
  await bindCodexVaultTurnToken({ codexThreadId: "thr_late", attemptId: first, turnId: "turn_1" }, env);
  const firstToken = await readCodexVaultTurnToken(codexEnv("thr_late"), home);

  const second = await issueCodexVaultTurnToken({ threadId: "codex-a", codexThreadId: "thr_late" }, env);
  await bindCodexVaultTurnToken({ codexThreadId: "thr_late", attemptId: second, turnId: "turn_2" }, env);
  const secondToken = await readCodexVaultTurnToken(codexEnv("thr_late"), home);
  assert.equal(await threadIdForVaultToken(firstToken, env), "", "a new turn revokes the previous token");

  assert.equal(await revokeCodexVaultTurnToken({ codexThreadId: "thr_late", turnId: "turn_1" }, env), false);
  assert.equal(await threadIdForVaultToken(secondToken, env), "codex-a");
  assert.equal(await revokeCodexVaultTurnToken({ codexThreadId: "thr_late", turnId: "turn_2" }, env), true);
  assert.equal(await threadIdForVaultToken(secondToken, env), "");
  await assert.rejects(fs.stat(codexVaultTokenFile("thr_late", home)), { code: "ENOENT" });
});

test("rejected thread tokens are audited without the token value", async () => {
  const bogus = "ovt_synthetic-bogus-token-value-0000000000000000000";
  const token = await readCodexVaultTurnToken(codexEnv("thr_a"), home);
  await assert.rejects(agentThreadIdFromRequest(req(bogus), "", env), { code: "vault_thread_token_invalid" });
  await assert.rejects(agentThreadIdFromRequest(req(token), "codex-b", env), { code: "vault_thread_token_mismatch" });
  await assert.rejects(agentThreadIdFromRequest(req(""), "codex-b", env), { code: "vault_thread_token_required" });
  const events = (await fs.readFile(path.join(home, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const rejected = events.filter((event) => event.type === "vault_thread_token_rejected").slice(-3);
  assert.deepEqual(rejected.map((event) => event.reason), ["invalid", "mismatch", "missing"]);
  assert.equal(rejected[1].threadId, "codex-a");
  assert.equal(rejected[1].suppliedThreadId, "codex-b");
  const raw = JSON.stringify(events);
  assert.equal(raw.includes(bogus), false);
  assert.equal(raw.includes(token), false);
});

test("orkestr vault reads the calling Codex thread's token file", async () => {
  const token = await readCodexVaultTurnToken(codexEnv("thr_b"), home);
  const seen = [];
  const fetchImpl = async (target, options = {}) => {
    seen.push({ url: String(target), headers: options.headers || {} });
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let out = "";
  const sink = { write(value) { out += String(value); } };
  const cliEnv = { ORKESTR_DISABLE_CLI_AUTH: "1", ORKESTR_ENV_FILE: "", ORKESTR_HOME: home, CODEX_THREAD_ID: "thr_b", ORKESTR_THREAD_ID: "codex-a" };
  const code = await runCli(["vault", "list"], { env: cliEnv, stdout: sink, stderr: sink, fetchImpl, cwd: "/tmp/example-workspace" });
  assert.equal(code, 0, out);
  assert.equal(seen.length, 1, "no whereiam lookup");
  assert.equal(new URL(seen[0].url).search, "", "no thread id named");
  assert.equal(seen[0].headers["x-orkestr-thread-token"], token);
  assert.equal(out.includes(token), false);
});
