import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createThread } from "../packages/core/src/threads.js";
import { issueVaultThreadToken, revokeVaultThreadTokens } from "../packages/core/src/vault-thread-tokens.js";
import { jsonPost, pairedCookie, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

// Boots an isolated server. Synthetic users, values and hosts only.

const CLI_TOKEN = "synthetic-cli-token-for-vault-api-tests";
const PASSWORD = "synthetic-api-password-93b2";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

function request(port, method, pathname, { cookie, bearer, threadToken, body, origin = true } = {}) {
  const headers = {};
  if (threadToken) headers["x-orkestr-thread-token"] = threadToken;
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (origin) headers.origin = `http://127.0.0.1:${port}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return rawRequest(port, { method, pathname, headers, body: body === undefined ? "" : body });
}

async function treeIncludes(root, value) {
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() ? await treeIncludes(full, value) : (await fs.readFile(full, "utf8").catch(() => "")).includes(value)) return true;
  }
  return false;
}

test("vault API: owner endpoints, agent endpoints and approval flow", async (t) => {
  const server = await startFixtureServer({ ORKESTR_HOST_BOUNDARIES: "0", ORKESTR_CLI_AUTH_TOKEN: CLI_TOKEN });
  t.after(async () => {
    delete process.env.ORKESTR_CLI_AUTH_TOKEN;
    await server.close();
  });
  const { port } = server;
  await createThread({ id: "vault-api-thread", name: "Vault API worker", ownerUserId: "alice" }, process.env);
  const alice = await pairedCookie({ userId: "alice", role: "user" });
  const admin = await pairedCookie({ userId: "admin", role: "admin" });
  const scoped = await pairedCookie({ userId: "alice", role: "user", allowedActions: ["desktop:view"] });

  assert.equal((await request(port, "GET", "/api/vault/items")).status, 401);
  const machine = await request(port, "GET", "/api/vault/items", { bearer: CLI_TOKEN });
  assert.equal(machine.status, 403, machine.text);
  assert.equal(machine.json.error, "vault_owner_session_required");
  assert.notEqual((await request(port, "GET", "/api/vault/items", { cookie: scoped })).status, 200);

  const created = await request(port, "POST", "/api/vault/items", {
    cookie: alice,
    body: { name: "Example Mail", url: "https://mail.example.com", username: "alice@example.com", password: PASSWORD, notes: "api note", tags: ["work"], totpSecret: TOTP_SECRET },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.text.includes(PASSWORD), false);
  const itemId = created.json.item.id;
  assert.deepEqual(Object.keys(created.json.item).sort(), ["createdAt", "domain", "hasPassword", "hasTotp", "id", "lastUsedAt", "name", "tags", "threadGrants", "totpType", "updatedAt", "url", "username"]);

  const crossSite = await rawRequest(port, {
    method: "POST",
    pathname: "/api/vault/items",
    headers: { cookie: alice, origin: "https://attacker.example.net", "content-type": "application/json" },
    body: { name: "x" },
  });
  assert.equal(crossSite.status, 403);

  const list = await request(port, "GET", "/api/vault/items", { cookie: alice });
  assert.equal(list.status, 200);
  assert.equal(list.json.items[0].username, "alice@example.com");
  assert.equal(list.text.includes(PASSWORD), false);
  assert.equal((await request(port, "GET", "/api/vault/items", { cookie: admin })).json.items.length, 0, "admin cannot see alice's vault");
  const adminCounts = await request(port, "GET", "/api/vault/status?userId=alice", { cookie: admin });
  assert.equal(adminCounts.json.itemCount, 1);
  assert.equal(adminCounts.json.keySource, "file");
  assert.equal(adminCounts.json.keyFilePresent, true);

  const patched = await request(port, "PATCH", `/api/vault/items/${itemId}`, { cookie: alice, body: { name: "Example Mail 2" } });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.item.name, "Example Mail 2");

  const reveal = await request(port, "POST", `/api/vault/items/${itemId}/reveal`, { cookie: alice });
  assert.equal(reveal.status, 200, reveal.text);
  assert.deepEqual(reveal.json, { password: PASSWORD, notes: "api note" });
  assert.equal(reveal.headers["x-orkestr-secure-input"], "noMirror,noCapture,noCodexContext,noScreenshot");
  assert.equal((await request(port, "POST", `/api/vault/items/${itemId}/reveal`, { cookie: admin })).status, 404);

  const code = await request(port, "GET", `/api/vault/items/${itemId}/totp`, { cookie: alice });
  assert.equal(code.status, 200);
  assert.match(code.json.code, /^\d{6}$/);
  const secret = await request(port, "POST", `/api/vault/items/${itemId}/totp-secret`, { cookie: alice });
  assert.match(secret.json.otpauthUri, /secret=JBSWY3DPEHPK3PXP/);

  const imported = await request(port, "POST", "/api/vault/import", {
    cookie: alice,
    body: { format: "auto", content: "name,url,username,password,note\nsite,https://site.example.com,alice,import-synthetic-pw,\n" },
  });
  assert.equal(imported.status, 200, imported.text);
  assert.deepEqual(imported.json, { imported: 1, skipped: 0, withTotp: 0, reasons: [] });
  // The large import body is parsed only after authentication: an anonymous
  // malformed body is rejected by auth (401), not by the JSON parser (400).
  const anonymousImport = await request(port, "POST", "/api/vault/import", { body: `{"content":"${"x".repeat(200_000)}"` });
  assert.equal(anonymousImport.status, 401, anonymousImport.text);
  const bigImport = await request(port, "POST", "/api/vault/import", {
    cookie: alice,
    body: { format: "auto", content: `name,url,username,password,note\nbig,https://big.example.com,alice,import-synthetic-pw,${"n".repeat(300_000)}\n` },
  });
  assert.equal(bigImport.status, 200, bigImport.text.slice(0, 200));

  // Agent endpoints: CLI credential plus a thread token, granted items only.
  await createThread({ id: "vault-api-other", name: "Other worker", ownerUserId: "alice" }, process.env);
  const token = await issueVaultThreadToken({ threadId: "vault-api-thread", attemptId: "api-turn" }, process.env);
  const otherToken = await issueVaultThreadToken({ threadId: "vault-api-other" }, process.env);
  const agent = { bearer: CLI_TOKEN, threadToken: token };
  const agentQuery = "/api/vault/agent/items";
  assert.equal((await request(port, "GET", agentQuery, { cookie: alice, threadToken: token })).status, 403);
  const noToken = await request(port, "GET", `${agentQuery}?threadId=vault-api-thread`, { bearer: CLI_TOKEN });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.error, "vault_thread_token_required");
  assert.deepEqual((await request(port, "GET", agentQuery, agent)).json.items, []);
  const denied = await request(port, "POST", "/api/vault/agent/credentials", { ...agent, body: { item: itemId } });
  assert.equal(denied.status, 404);
  const grant = await request(port, "PUT", `/api/vault/items/${itemId}/grants`, { cookie: alice, body: { threadIds: ["vault-api-thread"] } });
  assert.equal(grant.status, 200, grant.text);
  assert.deepEqual(grant.json.item.threadGrants, [{ threadId: "vault-api-thread" }]);
  const named = await request(port, "POST", "/api/vault/agent/credentials", { bearer: CLI_TOKEN, body: { threadId: "vault-api-thread", item: itemId } });
  assert.equal(named.status, 401, "a caller-named thread id is not enough");
  const crossThread = await request(port, "POST", "/api/vault/agent/credentials", { bearer: CLI_TOKEN, threadToken: otherToken, body: { threadId: "vault-api-thread", item: itemId } });
  assert.equal(crossThread.status, 403);
  assert.equal(crossThread.json.error, "vault_thread_token_mismatch");
  assert.equal((await request(port, "POST", "/api/vault/agent/credentials", { bearer: CLI_TOKEN, threadToken: otherToken, body: { item: itemId } })).status, 404);
  const tokenWithoutCli = await request(port, "POST", "/api/vault/agent/credentials", { threadToken: token, body: { item: itemId } });
  assert.notEqual(tokenWithoutCli.status, 200, "the thread token alone is not a credential");
  const creds = await request(port, "POST", "/api/vault/agent/credentials", { ...agent, body: { item: itemId } });
  assert.equal(creds.status, 200, creds.text);
  assert.equal(creds.json.password, PASSWORD);

  const pending = await request(port, "POST", "/api/vault/agent/totp", { ...agent, body: { item: itemId } });
  assert.equal(pending.json.status, "pending");
  const approvals = await request(port, "GET", "/api/vault/approvals", { cookie: alice });
  assert.equal(approvals.json.approvals[0].id, pending.json.approval.id);
  assert.equal(approvals.json.approvals[0].threadName, "Vault API worker");
  assert.equal((await request(port, "GET", "/api/vault/status", { cookie: alice })).json.pendingApprovals, 1);
  const approve = await request(port, "POST", `/api/vault/approvals/${pending.json.approval.id}/approve`, { cookie: alice });
  assert.equal(approve.status, 200, approve.text);
  assert.equal(approve.json.approval.status, "approved");
  const issued = await request(port, "POST", "/api/vault/agent/totp", { ...agent, body: { item: itemId, approvalId: pending.json.approval.id } });
  assert.equal(issued.json.status, "issued");
  assert.match(issued.json.code, /^\d{6}$/);
  const second = await request(port, "POST", "/api/vault/agent/totp", { ...agent, body: { item: itemId } });
  assert.equal(second.json.status, "pending");
  const deny = await request(port, "POST", `/api/vault/approvals/${second.json.approval.id}/deny`, { cookie: alice });
  assert.equal(deny.json.approval.status, "denied");

  await revokeVaultThreadTokens({ threadId: "vault-api-thread", attemptId: "api-turn" }, process.env);
  const revoked = await request(port, "POST", "/api/vault/agent/credentials", { ...agent, body: { item: itemId } });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.json.error, "vault_thread_token_invalid");

  assert.deepEqual((await request(port, "DELETE", `/api/vault/items/${itemId}`, { cookie: alice })).json, { ok: true });

  const events = await fs.readFile(path.join(server.home, "events.jsonl"), "utf8");
  assert.match(events, /vault_secret_read/);
  for (const value of [PASSWORD, "import-synthetic-pw", TOTP_SECRET, issued.json.code && `"code":"${issued.json.code}"`]) {
    assert.equal(events.includes(value), false, "no vault values in events");
  }
  for (const value of [token, otherToken]) {
    assert.equal(events.includes(value), false, "no thread tokens in events");
    assert.equal(await treeIncludes(path.join(server.home, "observability"), value), false, "no thread tokens in the perf log");
  }
});
