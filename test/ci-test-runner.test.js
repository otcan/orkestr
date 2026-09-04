import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCiTestEnv,
  buildNodeTestArgs,
  discoverTestFiles,
  normalizeShard,
  parseCiTestRunnerArgs,
  selectShardFiles,
} from "../scripts/ci-test-runner.mjs";

test("CI test runner selects deterministic one-based shards", () => {
  const files = [
    "test/a.test.js",
    "test/b.test.js",
    "test/c.test.js",
    "test/d.test.js",
    "test/e.test.js",
  ];

  assert.deepEqual(selectShardFiles(files, normalizeShard({ index: "1", total: "2" })), [
    "test/a.test.js",
    "test/c.test.js",
    "test/e.test.js",
  ]);
  assert.deepEqual(selectShardFiles(files, normalizeShard({ index: "2", total: "2" })), [
    "test/b.test.js",
    "test/d.test.js",
  ]);
});

test("CI test runner accepts zero-based shard indices explicitly", () => {
  assert.deepEqual(normalizeShard({ index: "0", total: "4" }), {
    index: 0,
    total: 4,
    displayIndex: 1,
  });
  assert.throws(() => normalizeShard({ index: "5", total: "4" }), /Invalid test shard index/);
});

test("CI test runner treats CI_NODE_INDEX as zero-based fallback", () => {
  const options = parseCiTestRunnerArgs([], {
    CI_NODE_INDEX: "1",
    CI_NODE_TOTAL: "4",
  });

  assert.deepEqual(options.shard, {
    index: 1,
    total: 4,
    displayIndex: 2,
  });
});

test("CI test runner discovers test files and builds node arguments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ci-runner-"));
  await fs.mkdir(path.join(root, "test", "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "test", "b.test.js"), "", "utf8");
  await fs.writeFile(path.join(root, "test", "nested", "a.test.js"), "", "utf8");
  await fs.writeFile(path.join(root, "test", "fixture.js"), "", "utf8");

  const options = parseCiTestRunnerArgs(["--root", root, "--shard-total", "2", "--shard-index", "1", "--concurrency", "3"], {});
  const files = discoverTestFiles(root);
  const args = buildNodeTestArgs(options, selectShardFiles(files, options.shard));

  assert.deepEqual(files, ["test/b.test.js", "test/nested/a.test.js"]);
  assert.equal(options.concurrency, 3);
  assert.deepEqual(args, [
    "--import",
    "./test/test-bootstrap.mjs",
    "--test",
    "--test-concurrency=3",
    "--test-force-exit",
    "test/b.test.js",
  ]);
});

test("CI test runner scrubs production connector and public URL env", () => {
  const env = buildCiTestEnv({
    PATH: "/bin",
    ORKESTR_HOME: "/prod/home",
    ORKESTR_CONNECTOR_INBOX_DB: "/prod/connector-inbox.sqlite",
    ORKESTR_THREAD_RESOURCE_POLICY_DB: "/prod/thread-policy.sqlite",
    ORKESTR_PUBLIC_APPS_FILE: "/prod/public-apps.json",
    ORKESTR_API_SESSION_ID: "api-session-id",
    CODEX_API_SESSION_ID: "codex-api-session-id",
    CODEX_SESSION_ID: "codex-session-id",
    CODEX_CONVERSATION_ID: "codex-conversation-id",
    OPENAI_SESSION_ID: "openai-session-id",
    ORKESTR_CONNECTOR_OUTBOX_STORE: "postgres",
    ORKESTR_CONNECTOR_OUTBOX_POSTGRES_URL: "postgres://production.invalid/orkestr",
    PGHOST: "production-db.invalid",
    ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test",
    ORKESTR_APP_HOST: "app.example.test",
    ORKESTR_AUTH_REQUIRED: "1",
    GMAIL_OAUTH_CLIENT_SECRET: "real-secret",
    WHATSAPP_BRIDGE_MODE: "external",
    WHATSAPP_BRIDGE_URL: "https://bridge.example.test",
    ORKESTR_WHATSAPP_BRIDGE_TOKEN: "bridge-secret",
    ORKESTR_WHATSAPP_INBOUND_TOKEN: "inbound-secret",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "1",
  });

  assert.equal(env.PATH, "/bin");
  assert.match(env.ORKESTR_HOME, /orkestr-ci-home-/);
  assert.equal(env.ORKESTR_AUTH_REQUIRED, "0");
  assert.equal(env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED, "1");
  assert.equal(env.WHATSAPP_BRIDGE_MODE, "local");
  assert.equal(env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED, "0");
  assert.equal(env.ORKESTR_WHATSAPP_DEBUG_FOOTER, "0");
  assert.equal(env.ORKESTR_PUBLIC_HTTPS_URL, undefined);
  assert.equal(env.ORKESTR_CONNECTOR_INBOX_DB, undefined);
  assert.equal(env.ORKESTR_THREAD_RESOURCE_POLICY_DB, undefined);
  assert.equal(env.ORKESTR_PUBLIC_APPS_FILE, undefined);
  assert.equal(env.ORKESTR_API_SESSION_ID, undefined);
  assert.equal(env.CODEX_API_SESSION_ID, undefined);
  assert.equal(env.CODEX_SESSION_ID, undefined);
  assert.equal(env.CODEX_CONVERSATION_ID, undefined);
  assert.equal(env.OPENAI_SESSION_ID, undefined);
  assert.equal(env.ORKESTR_AUTO_RUN_THREAD_INPUT, "0");
  assert.equal(env.ORKESTR_CONNECTOR_OUTBOX_STORE, "sqlite");
  assert.equal(env.ORKESTR_CONNECTOR_OUTBOX_POSTGRES_URL, undefined);
  assert.equal(env.PGHOST, undefined);
  assert.equal(env.ORKESTR_APP_HOST, undefined);
  assert.equal(env.GMAIL_OAUTH_CLIENT_SECRET, undefined);
  assert.equal(env.WHATSAPP_BRIDGE_URL, undefined);
  assert.equal(env.ORKESTR_WHATSAPP_BRIDGE_TOKEN, undefined);
  assert.equal(env.ORKESTR_WHATSAPP_INBOUND_TOKEN, undefined);
});
