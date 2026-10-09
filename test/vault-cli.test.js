import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";

// Synthetic values only; the API is faked.

const baseEnv = { ORKESTR_DISABLE_CLI_AUTH: "1", ORKESTR_ENV_FILE: "", ORKESTR_VAULT_POLL_MS: "10" };
const PASSWORD = "synthetic-cli-password";

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text: () => text };
}

function fakeFetch(handler, seen) {
  return async (target, options = {}) => {
    const parsed = new URL(target);
    const body = options.body ? JSON.parse(options.body) : null;
    const key = `${String(options.method || "GET").toUpperCase()} ${parsed.pathname}`;
    seen.push({ key, query: Object.fromEntries(parsed.searchParams), body, headers: options.headers || {} });
    const [status, payload] = handler(key, body, parsed) || [404, { error: `missing route: ${key}` }];
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
}

async function run(argv, handler, { env = {}, ...extra } = {}) {
  const stdout = capture();
  const stderr = capture();
  const seen = [];
  const code = await runCli(argv, { env: { ...baseEnv, ...env }, stdout, stderr, fetchImpl: fakeFetch(handler, seen), cwd: "/tmp/example-workspace", ...extra });
  return { code, stdout: stdout.text(), stderr: stderr.text(), seen };
}

test("vault list resolves the thread from ORKESTR_THREAD_ID or whereiam", async () => {
  const handler = (key) => {
    if (key === "GET /api/vault/agent/items") return [200, { threadId: "t-1", items: [{ id: "vi_1", name: "Example", domain: "example.com", hasPassword: true, hasTotp: false }] }];
    if (key === "GET /api/whereiam") return [200, { thread: { id: "t-from-cwd" } }];
    return null;
  };
  const fromEnv = await run(["vault", "list"], handler, { env: { ORKESTR_THREAD_ID: "t-1" } });
  assert.equal(fromEnv.code, 0, fromEnv.stderr);
  assert.match(fromEnv.stdout, /vi_1\tExample\texample\.com\tpassword/);
  assert.equal(fromEnv.seen[0].query.threadId, "t-1");
  const fromCwd = await run(["vault", "list", "--json"], handler);
  assert.equal(fromCwd.code, 0, fromCwd.stderr);
  assert.equal(fromCwd.seen[0].query.cwd, "/tmp/example-workspace");
  assert.equal(fromCwd.seen[1].query.threadId, "t-from-cwd");
  const unresolved = await run(["vault", "list"], (key) => (key === "GET /api/whereiam" ? [200, { thread: null }] : null));
  assert.equal(unresolved.code, 1);
  assert.match(unresolved.stderr, /vault_thread_unresolved/);
});

test("vault sends the thread token as a header and never names a thread", async () => {
  const TOKEN = "ovt_synthetic-cli-thread-token";
  let spawned = null;
  const spawnImpl = (command, args, options) => {
    spawned = options;
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };
  const handler = (key) => {
    if (key === "GET /api/vault/agent/items") return [200, { threadId: "t-1", items: [] }];
    if (key === "POST /api/vault/agent/credentials") return [200, { username: "u", password: PASSWORD }];
    return null;
  };
  const env = { ORKESTR_VAULT_THREAD_TOKEN: TOKEN, ORKESTR_THREAD_ID: "t-other" };
  const list = await run(["vault", "list"], handler, { env });
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(list.seen.map((entry) => entry.key), ["GET /api/vault/agent/items"], "no whereiam lookup");
  assert.deepEqual(list.seen[0].query, {});
  assert.equal(list.seen[0].headers["x-orkestr-thread-token"], TOKEN);
  const exec = await run(["vault", "exec", "Example", "--", "tool"], handler, { env, spawnImpl });
  assert.equal(exec.code, 0, exec.stderr);
  assert.equal(exec.seen[0].body.threadId, "");
  assert.equal(exec.seen[0].headers["x-orkestr-thread-token"], TOKEN);
  assert.equal(spawned.env.ORKESTR_VAULT_THREAD_TOKEN, undefined, "token is not passed to the child");
  assert.equal(`${list.stdout}${list.stderr}${exec.stdout}${exec.stderr}`.includes(TOKEN), false);
});

test("vault exec injects credentials into the child env without printing them", async () => {
  let spawned = null;
  const spawnImpl = (command, args, options) => {
    spawned = { command, args, options };
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", 7, null));
    return child;
  };
  const result = await run(["vault", "exec", "Example", "--", "deploy-tool", "--user", "x"], (key, body) => {
    if (key === "POST /api/vault/agent/credentials") {
      assert.deepEqual(body, { threadId: "t-1", item: "Example", fields: ["username", "password"] });
      return [200, { itemId: "vi_1", username: "alice@example.com", password: PASSWORD }];
    }
    return null;
  }, { env: { ORKESTR_THREAD_ID: "t-1" }, spawnImpl });
  assert.equal(result.code, 7);
  assert.equal(spawned.command, "deploy-tool");
  assert.deepEqual(spawned.args, ["--user", "x"]);
  assert.equal(spawned.options.stdio, "inherit");
  assert.equal(spawned.options.env.VAULT_PASSWORD, PASSWORD);
  assert.equal(spawned.options.env.VAULT_USERNAME, "alice@example.com");
  assert.equal(`${result.stdout}${result.stderr}`.includes(PASSWORD), false);
});

test("vault get prints one field; secret values are never accepted as argv", async () => {
  const handler = (key) => (key === "POST /api/vault/agent/credentials" ? [200, { password: PASSWORD }] : null);
  const got = await run(["vault", "get", "Example", "--field", "password"], handler, { env: { ORKESTR_THREAD_ID: "t-1" } });
  assert.equal(got.stdout, `${PASSWORD}\n`);
  assert.deepEqual(got.seen[0].body.fields, ["password"]);
  const rejected = await run(["vault", "get", "Example", "--password=abc"], handler, { env: { ORKESTR_THREAD_ID: "t-1" } });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /vault_value_flag_disabled/);
  assert.equal(rejected.seen.length, 0);
});

test("vault totp waits for approval and prints exactly the issued code", async () => {
  let polls = 0;
  const handler = (key, body) => {
    if (key !== "POST /api/vault/agent/totp") return null;
    if (!body.approvalId) return [200, { status: "pending", approval: { id: "vap_1", expiresAt: "2026-01-01T00:05:00.000Z" } }];
    polls += 1;
    return polls < 3
      ? [200, { status: "pending", approval: { id: "vap_1" } }]
      : [200, { status: "issued", code: "123456", expiresInSeconds: 20, period: 30, digits: 6, approval: { id: "vap_1" } }];
  };
  const waited = await run(["vault", "totp", "Example", "--wait", "5"], handler, { env: { ORKESTR_THREAD_ID: "t-1" }, sleepImpl: async () => {} });
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(waited.stdout, "123456\n");
  assert.match(waited.stderr, /Waiting for the owner's approval/);
  assert.equal(polls, 3);
  const noWait = await run(["vault", "totp", "Example"], handler, { env: { ORKESTR_THREAD_ID: "t-1" } });
  assert.equal(noWait.code, 3);
  assert.equal(noWait.stdout, "");
  const denied = await run(["vault", "totp", "Example", "--wait", "5"], (key, body) => (
    body?.approvalId ? [200, { status: "denied", approval: { id: "vap_1" } }] : [200, { status: "pending", approval: { id: "vap_1" } }]
  ), { env: { ORKESTR_THREAD_ID: "t-1" }, sleepImpl: async () => {} });
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /vault_totp_denied/);
});
