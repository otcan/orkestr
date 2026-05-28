import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { startServer } from "../apps/server/src/server.js";
import { createTimerForPrincipal, listTimersForPrincipal } from "../packages/core/src/timers.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { sanitizeAction } from "../packages/core/src/llm-sanitizer.js";
import { findOrCreateExternalUser, listUsers, upsertUser } from "../packages/core/src/users.js";
import {
  createThread,
  createThreadForPrincipal,
  enqueueThreadInputForPrincipal,
  getThreadForPrincipal,
  listThreadMessages,
  listThreadsForPrincipal,
} from "../packages/core/src/threads.js";

async function allowSanitizerEnv(home) {
  const script = path.join(home, "allow-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  JSON.parse(input);",
      "  console.log(JSON.stringify({ allow: true, reason: 'test-allow', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    ORKESTR_HOME: home,
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
}

test("use control keeps a default admin user for existing installs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-admin-"));
  const env = { ORKESTR_HOME: home };
  const users = await listUsers(env);
  const thread = await createThread({ id: "legacy-thread", name: "Legacy" }, env);

  assert.equal(users[0].id, "admin");
  assert.equal(users[0].role, "admin");
  assert.equal(thread.ownerUserId, "admin");
});

test("non-admin users are limited to one owned thread and cannot read another owner", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-scope-"));
  const env = { ORKESTR_HOME: home };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env));
  const bob = userPrincipal(await upsertUser({ id: "bob", role: "user", displayName: "Bob" }, env));

  const first = await createThreadForPrincipal({ id: "alice-thread", name: "Main" }, alice, env);
  const duplicate = await createThreadForPrincipal({ id: "other-id", name: "Main" }, alice, env);
  await createThreadForPrincipal({ id: "bob-thread", name: "Main" }, bob, env);

  await assert.rejects(
    () => createThreadForPrincipal({ id: "alice-second", name: "Second" }, alice, env),
    /thread_limit_reached/,
  );
  await assert.rejects(() => getThreadForPrincipal("bob-thread", alice, env), /thread_access_forbidden/);

  assert.equal(duplicate.id, first.id);
  assert.deepEqual((await listThreadsForPrincipal(alice, env)).map((thread) => thread.id), ["alice-thread"]);
  assert.deepEqual((await listThreadsForPrincipal(adminPrincipal(), env)).map((thread) => thread.id).sort(), ["alice-thread", "bob-thread"]);
});

test("external WhatsApp identities can provision scoped non-admin users", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-wa-"));
  const env = { ORKESTR_HOME: home };
  const user = await findOrCreateExternalUser({
    provider: "whatsapp",
    accountId: "wa-example",
    externalId: "15551234567",
    displayName: "Example User",
  }, env);
  const again = await findOrCreateExternalUser({
    provider: "whatsapp",
    accountId: "wa-example",
    externalId: "15551234567",
  }, env);

  assert.equal(user.role, "user");
  assert.equal(user.id, "whatsapp-wa-example-15551234567");
  assert.equal(again.id, user.id);
});

test("LLM sanitizer is fail-closed when no provider is configured", async () => {
  const decision = await sanitizeAction({
    action: "thread.input",
    principal: { role: "user", userId: "alice" },
    resource: { type: "thread", id: "thread-1", ownerUserId: "alice" },
    input: { text: "hello" },
  }, { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-sanitizer-missing-")) });

  assert.equal(decision.allow, false);
  assert.equal(decision.unavailable, true);
  assert.equal(decision.reason, "llm_sanitizer_unconfigured");
});

test("non-admin thread input must pass the LLM sanitizer", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-input-"));
  const env = await allowSanitizerEnv(home);
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user" }, env));
  await createThreadForPrincipal({ id: "alice-thread", name: "Main" }, alice, env);

  const message = await enqueueThreadInputForPrincipal("alice-thread", { text: "safe work item" }, alice, env);
  const messages = await listThreadMessages("alice-thread", env);

  assert.equal(message.state, "queued");
  assert.equal(message.ownerUserId, "alice");
  assert.equal(messages.length, 1);
});

test("non-admin timer creation is scoped and sanitizer-gated", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-timer-"));
  const env = await allowSanitizerEnv(home);
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user" }, env));
  const bob = userPrincipal(await upsertUser({ id: "bob", role: "user" }, env));
  await createThreadForPrincipal({ id: "alice-thread", name: "Main" }, alice, env);
  await createThreadForPrincipal({ id: "bob-thread", name: "Main" }, bob, env);

  const timer = await createTimerForPrincipal({
    label: "Daily follow-up",
    targetType: "thread",
    target: "alice-thread",
    cadence: "daily",
    prompt: "Run my daily follow-up.",
  }, alice, env);

  await assert.rejects(
    () => createTimerForPrincipal({
      label: "Bad",
      targetType: "thread",
      target: "bob-thread",
      prompt: "Cross user",
    }, alice, env),
    /thread_access_forbidden/,
  );

  assert.equal(timer.ownerUserId, "alice");
  assert.deepEqual((await listTimersForPrincipal(alice, env)).map((entry) => entry.id), [timer.id]);
});

test("sanitizer command JSON form accepts paths with spaces", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr sanitizer spaced "));
  const env = await allowSanitizerEnv(home);
  const decision = await sanitizeAction({
    action: "thread.input",
    principal: { role: "user", userId: "alice" },
    resource: { type: "thread", id: "thread-1", ownerUserId: "alice" },
    input: { text: "hello" },
  }, env);

  assert.equal(decision.allow, true);
  assert.equal(decision.model, "test-llm");
  assert.equal(pathToFileURL(home).protocol, "file:");
});

test("thread API rejects ambiguous same-name routes across owners", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-ambiguous-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  await createThread({ id: "alice-main", name: "Shared", ownerUserId: "alice" }, process.env);
  await createThread({ id: "bob-main", name: "Shared", ownerUserId: "bob" }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();

  try {
    const ambiguous = await fetch(`http://127.0.0.1:${port}/api/threads/Shared/messages`);
    const exact = await fetch(`http://127.0.0.1:${port}/api/threads/alice-main/messages`);
    const ambiguousPayload = await ambiguous.json();

    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguousPayload.error, "ambiguous_thread_name_use_id");
    assert.equal(exact.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});
