import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { startServer } from "../apps/server/src/server.js";
import { createTimer, createTimerForPrincipal, doctorTimersForPrincipal, listTimers, listTimersForPrincipal, markDueTimers } from "../packages/core/src/timers.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { sanitizeAction } from "../packages/core/src/llm-sanitizer.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { createUser, disableUser, findOrCreateExternalUser, listUsers, readUserPrivateIdentities, updateUser, upsertUser } from "../packages/core/src/users.js";
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

test("non-admin thread creation cannot request root-trusted Codex access", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-codex-profile-"));
  const env = { ORKESTR_HOME: home };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env));

  const thread = await createThreadForPrincipal({
    id: "alice-thread",
    name: "Main",
    codexSandbox: "danger-full-access",
    codexApprovalPolicy: "never",
    securityProfile: "trusted-root",
    executor: {
      type: "codex",
      metadata: {
        codexSandbox: "danger-full-access",
        codexApprovalPolicy: "never",
        securityProfile: "trusted-root",
      },
    },
  }, alice, env);

  assert.equal(thread.ownerUserId, "alice");
  assert.equal(thread.securityProfile, "external-user");
  assert.equal(thread.codexSandbox, "workspace-write");
  assert.equal(thread.codexApprovalPolicy, "on-request");
  assert.equal(thread.executor.metadata.securityProfile, "external-user");
  assert.equal(thread.executor.metadata.codexSandbox, "workspace-write");
  assert.equal(thread.executor.metadata.codexApprovalPolicy, "on-request");
});

test("admin chat summary hides tenant-owned WhatsApp-only threads by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-chat-scope-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  let server;
  try {
    await upsertUser({ id: "otcan", role: "user", displayName: "otcan" }, process.env);
    await createThread({ id: "admin-main", name: "Admin Main", ownerUserId: "admin" }, process.env);
    await createThread({
      id: "otcantest",
      name: "otcantest",
      ownerUserId: "otcan",
      binding: {
        connector: "whatsapp",
        chatId: "120363423847331215@g.us",
        displayName: "otcantest",
        generated: true,
        mirrorToWhatsApp: true,
      },
    }, process.env);

    server = await startServer({ port: 0, host: "127.0.0.1" });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const defaultResponse = await fetch(`${baseUrl}/api/threads`);
    const defaultPayload = await defaultResponse.json();
    const allResponse = await fetch(`${baseUrl}/api/threads?scope=all`);
    const allPayload = await allResponse.json();

    assert.equal(defaultResponse.status, 200);
    assert.deepEqual(defaultPayload.threads.map((thread) => thread.id), ["admin-main"]);
    assert.equal(allResponse.status, 200);
    assert.deepEqual(allPayload.threads.map((thread) => thread.id).sort(), ["admin-main", "otcantest"]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorRecover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START;
    else process.env.ORKESTR_RECOVER_RUNNING_ON_START = priorRecover;
  }
});

test("generated WhatsApp binding persists restricted Codex defaults for tenant threads", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-binding-codex-profile-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  let server;
  try {
    await createThread({
      id: "otcantest",
      name: "otcantest",
      ownerUserId: "otcan",
      codexSandbox: "danger-full-access",
      codexApprovalPolicy: "never",
      securityProfile: "trusted-root",
      executor: {
        type: "codex",
        metadata: {
          codexSandbox: "danger-full-access",
          codexApprovalPolicy: "never",
          securityProfile: "trusted-root",
        },
      },
    }, process.env);

    server = await startServer({ port: 0, host: "127.0.0.1" });
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/threads/otcantest/binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: "120363423847331215@g.us",
        displayName: "otcantest",
        generated: true,
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.thread.securityProfile, "generated-whatsapp");
    assert.equal(payload.thread.codexSandbox, "workspace-write");
    assert.equal(payload.thread.codexApprovalPolicy, "on-request");
    assert.equal(payload.thread.executor.metadata.securityProfile, "generated-whatsapp");
    assert.equal(payload.thread.executor.metadata.codexSandbox, "workspace-write");
    assert.equal(payload.thread.executor.metadata.codexApprovalPolicy, "on-request");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorRecover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START;
    else process.env.ORKESTR_RECOVER_RUNNING_ON_START = priorRecover;
  }
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
  assert.equal("linkedIdentities" in user, false);
  assert.equal((await readUserPrivateIdentities(user.id, env))[0].externalId, "15551234567");
});

test("admin user management preserves at least one active admin", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-users-"));
  const env = { ORKESTR_HOME: home };

  const alice = await createUser({ id: "alice", role: "user", displayName: "Alice" }, env);
  const opsAdmin = await createUser({ id: "ops-admin", role: "admin", displayName: "Ops Admin" }, env);
  const promoted = await updateUser(alice.id, { role: "admin", limits: { maxThreads: null } }, env);
  const disabledDefaultAdmin = await disableUser("admin", env);

  assert.equal(alice.role, "user");
  assert.equal(opsAdmin.role, "admin");
  assert.equal(promoted.role, "admin");
  assert.equal(promoted.limits.maxThreads, null);
  assert.equal(disabledDefaultAdmin.status, "disabled");
  assert.equal((await disableUser("alice", env)).status, "disabled");
  await assert.rejects(() => disableUser("ops-admin", env), /last_admin_required/);
});

test("managed users use unique email and non-unique phone contact fields", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-contact-"));
  const env = { ORKESTR_HOME: home };

  const alice = await createUser({ email: "Alice@Example.test", phoneNumber: "+15551234567", role: "user", displayName: "Alice" }, env);
  const bob = await createUser({ email: "bob@example.test", phoneNumber: "+15551234567", role: "user", displayName: "Bob" }, env);

  assert.equal(alice.id, "alice-example.test");
  assert.equal(alice.email, "alice@example.test");
  assert.equal(alice.phoneNumber, "+15551234567");
  assert.equal(bob.phoneNumber, alice.phoneNumber);
  await assert.rejects(
    () => createUser({ email: "missing-phone@example.test", role: "user" }, env),
    /user_phone_required/,
  );
  await assert.rejects(
    () => createUser({ email: "ALICE@example.test", phoneNumber: "+15559876543", role: "user" }, env),
    /user_email_already_exists/,
  );
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

test("LLM sanitizer command preserves unavailable decisions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-sanitizer-unavailable-"));
  const script = path.join(home, "unavailable-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "console.log(JSON.stringify({ allow: false, reason: 'llm_sanitizer_model_down', unavailable: true, model: 'test-llm' }));",
      "",
    ].join("\n"),
    "utf8",
  );
  const decision = await sanitizeAction({
    action: "thread.input",
    principal: { role: "user", userId: "alice" },
    resource: { type: "thread", id: "thread-1", ownerUserId: "alice" },
    input: { text: "hello" },
  }, {
    ORKESTR_HOME: home,
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.unavailable, true);
  assert.equal(decision.reason, "llm_sanitizer_model_down");
  assert.equal(decision.model, "test-llm");
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

test("non-admin due timer execution must pass the LLM sanitizer", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-due-timer-"));
  const payloadLog = path.join(home, "sanitizer-payloads.jsonl");
  const script = path.join(home, "capture-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "import fs from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  fs.appendFileSync(${JSON.stringify(payloadLog)}, input.trim() + '\\n');`,
      "  console.log(JSON.stringify({ allow: true, reason: 'test-allow', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user" }, env));
  await createThreadForPrincipal({ id: "alice-thread", name: "Main" }, alice, env);
  const timer = await createTimerForPrincipal({
    label: "Due",
    targetType: "thread",
    target: "alice-thread",
    prompt: "Run due timer safely",
    cadence: "interval",
    every: "1h",
  }, alice, env);
  const timers = await listTimers(env);
  timers[0].nextRunAt = "2020-01-01T00:00:00.000Z";
  await fs.writeFile(path.join(home, "timers.json"), `${JSON.stringify(timers, null, 2)}\n`);

  const due = await markDueTimers(env, new Date("2026-05-15T10:00:00Z"));
  const messages = await listThreadMessages("alice-thread", env);
  const payloads = (await fs.readFile(payloadLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(due.length, 1);
  assert.equal(messages[0].source, "timer_due");
  assert.ok(payloads.some((payload) =>
    payload.action === "timer.execute" &&
    payload.principal.userId === "alice" &&
    payload.resource.id === timer.id &&
    payload.input.source === "timer_due"
  ));
});

test("non-admin due timer execution fails closed when sanitizer is unavailable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-due-timer-block-"));
  const env = { ORKESTR_HOME: home };
  await upsertUser({ id: "alice", role: "user" }, env);
  await createThread({ id: "alice-thread", name: "Alice", ownerUserId: "alice" }, env);
  await createTimer({
    label: "Blocked due",
    ownerUserId: "alice",
    targetType: "thread",
    target: "alice-thread",
    prompt: "Run due timer",
    cadence: "interval",
    every: "1h",
  }, env);
  const timers = await listTimers(env);
  timers[0].nextRunAt = "2020-01-01T00:00:00.000Z";
  await fs.writeFile(path.join(home, "timers.json"), `${JSON.stringify(timers, null, 2)}\n`);

  const due = await markDueTimers(env, new Date("2026-05-15T10:00:00Z"));
  const after = await listTimers(env);
  const messages = await listThreadMessages("alice-thread", env);

  assert.deepEqual(due, []);
  assert.equal(messages.length, 0);
  assert.equal(after[0].lastError, "llm_sanitizer_unconfigured");
  assert.equal(after[0].lastErrorAt, "2026-05-15T10:00:00.000Z");
});

test("non-admin timer doctor only reports owned timers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-timer-doctor-"));
  const env = { ORKESTR_HOME: home };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user" }, env));
  await upsertUser({ id: "bob", role: "user" }, env);
  await createThread({ id: "alice-thread", name: "Alice", ownerUserId: "alice" }, env);
  await createThread({ id: "bob-thread", name: "Bob", ownerUserId: "bob" }, env);
  await createTimer({
    label: "Alice missing thread",
    ownerUserId: "alice",
    targetType: "thread",
    target: "alice-missing",
    prompt: "Alice work.",
  }, env);
  await createTimer({
    label: "Bob missing thread",
    ownerUserId: "bob",
    targetType: "thread",
    target: "bob-missing",
    prompt: "Bob work.",
  }, env);

  const aliceDoctor = await doctorTimersForPrincipal(alice, env, new Date("2026-05-15T10:00:00.000Z"));
  const adminDoctor = await doctorTimersForPrincipal(adminPrincipal(), env, new Date("2026-05-15T10:00:00.000Z"));

  assert.deepEqual(aliceDoctor.issues.map((issue) => issue.timerLabel), ["Alice missing thread"]);
  assert.deepEqual(adminDoctor.issues.map((issue) => issue.timerLabel).sort(), ["Alice missing thread", "Bob missing thread"]);
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

test("user management API is admin-only and can pair a browser to a managed user", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-api-users-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function read(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  try {
    const firstChallenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
    await approvePairingChallenge(firstChallenge.challengeId, { env: process.env });
    const adminPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: firstChallenge.challengeId }),
    });
    const adminCookie = adminPair.headers.get("set-cookie") || "";
    assert.equal(adminPair.status, 200);

    const created = await read(await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ email: "alice@example.test", phoneNumber: "+15551234567", role: "user", displayName: "Alice" }),
    }));
    assert.equal(created.user.id, "alice-example.test");
    assert.equal(created.user.role, "user");
    assert.equal(created.user.email, "alice@example.test");

    const userChallenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ userId: "alice-example.test" }),
    }));
    assert.equal(userChallenge.challenge.userId, "alice-example.test");
    assert.equal(userChallenge.challenge.role, "user");
    await approvePairingChallenge(userChallenge.challengeId, { env: process.env });

    const userPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: userChallenge.challengeId }),
    });
    const userCookie = userPair.headers.get("set-cookie") || "";
    assert.equal(userPair.status, 200);

    const denied = await fetch(`${baseUrl}/api/users`, { headers: { cookie: userCookie } });
    assert.equal(denied.status, 403);

    const deniedConnectorResponse = await fetch(`${baseUrl}/api/connectors/whatsapp/status`, {
      headers: { cookie: userCookie, connection: "close" },
    });
    const deniedConnector = await read(deniedConnectorResponse);
    assert.equal(deniedConnectorResponse.status, 403);
    assert.equal(deniedConnector.error, "connector_admin_required");

    const where = await read(await fetch(`${baseUrl}/api/whereiam`, { headers: { cookie: userCookie } }));
    assert.equal(where.user.userId, "alice-example.test");
    assert.equal(where.user.role, "user");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorRecover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START;
    else process.env.ORKESTR_RECOVER_RUNNING_ON_START = priorRecover;
  }
});
