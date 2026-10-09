import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createThread } from "../packages/core/src/threads.js";
import { issueVaultThreadToken } from "../packages/core/src/vault-thread-tokens.js";
import { pairedCookie, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

// "Request into vault" over HTTP and the /s/<token> page. Synthetic values only.

const CLI_TOKEN = "synthetic-cli-token-for-vault-request-tests";

function call(port, method, pathname, { cookie, bearer, threadToken, body, form } = {}) {
  const headers = { origin: `http://127.0.0.1:${port}` };
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (threadToken) headers["x-orkestr-thread-token"] = threadToken;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  return rawRequest(port, { method, pathname, headers, body: form !== undefined ? new URLSearchParams(form).toString() : body === undefined ? "" : body });
}

test("vault request API: agent link, owner page submit, grant and listing", async (t) => {
  const server = await startFixtureServer({ ORKESTR_HOST_BOUNDARIES: "0", ORKESTR_CLI_AUTH_TOKEN: CLI_TOKEN });
  t.after(async () => {
    delete process.env.ORKESTR_CLI_AUTH_TOKEN;
    await server.close();
  });
  const { port } = server;
  await createThread({ id: "vr-thread", name: "Request worker", ownerUserId: "alice" }, process.env);
  const threadToken = await issueVaultThreadToken({ threadId: "vr-thread" }, process.env);
  const alice = await pairedCookie({ userId: "alice", role: "user" });
  const password = "synthetic-api-requested-3f9d";

  assert.equal((await call(port, "POST", "/api/vault/agent/requests", { bearer: CLI_TOKEN, body: { name: "Example Bank" } })).status, 401, "thread token required");
  const mismatch = await call(port, "POST", "/api/vault/agent/requests", { bearer: CLI_TOKEN, threadToken, body: { name: "Example Bank", threadId: "other-thread" } });
  assert.equal(mismatch.status, 403);
  const created = await call(port, "POST", "/api/vault/agent/requests", { bearer: CLI_TOKEN, threadToken, body: { name: "Example Bank", once: true, usernameToo: true } });
  assert.equal(created.status, 201, created.text);
  const pathname = new URL(created.json.url).pathname;

  const page = await call(port, "GET", pathname, { cookie: alice });
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /name="password" type="password"/);
  assert.match(page.text, /name="username"/);
  assert.match(page.text, /\/vault"/);

  const pending = await call(port, "GET", "/api/vault/requests", { cookie: alice });
  assert.equal(pending.status, 200, pending.text);
  assert.equal(pending.json.requests[0].status, "active");
  assert.equal((await call(port, "GET", "/api/vault/requests", { bearer: CLI_TOKEN })).status, 403, "agents cannot list owner requests");

  const stored = await call(port, "POST", `${pathname}/vault`, { cookie: alice, form: { password, username: "alice@example.com" } });
  assert.equal(stored.status, 200, stored.text);
  assert.equal(stored.text.includes(password), false);
  assert.equal((await call(port, "POST", `${pathname}/vault`, { cookie: alice, form: { password: "synthetic-again" } })).status, 410);

  const items = await call(port, "GET", "/api/vault/items", { cookie: alice });
  const item = items.json.items.find((entry) => entry.name === "Example Bank");
  assert.deepEqual(item.threadGrants, [{ threadId: "vr-thread" }]);
  assert.equal(item.singleUseStatus, "active");
  const read = await call(port, "POST", "/api/vault/agent/credentials", { bearer: CLI_TOKEN, threadToken, body: { item: item.id } });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.json.password, password);
  const second = await call(port, "POST", "/api/vault/agent/credentials", { bearer: CLI_TOKEN, threadToken, body: { item: item.id } });
  assert.equal(second.status, 410);
  assert.equal(second.text.includes(password), false);

  const events = await fs.readFile(path.join(server.home, "events.jsonl"), "utf8");
  assert.equal(events.includes(password), false);
  assert.match(events, /vault_single_use_consumed/);
});
