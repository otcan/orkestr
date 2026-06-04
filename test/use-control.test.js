import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { startServer } from "../apps/server/src/server.js";
import { userDataPaths } from "../packages/storage/src/paths.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { appendEvent } from "../packages/storage/src/store.js";
import { listEventsForPrincipal } from "../packages/core/src/audit-events.js";
import {
  listFilesForPrincipal,
  listWorkspaceFoldersForPrincipal,
  resolveWorkspacePathForPrincipal,
  workspaceRootForPrincipal,
} from "../packages/core/src/workspace-files.js";
import { createTimer, createTimerForPrincipal, doctorTimersForPrincipal, listTimers, listTimersForPrincipal, markDueTimers } from "../packages/core/src/timers.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { sanitizeAction } from "../packages/core/src/llm-sanitizer.js";
import { recordCreditUsage } from "../packages/core/src/credit-usage.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { createUser, disableUser, findOrCreateExternalUser, listUsers, readUserPrivateIdentities, updateUser, upsertUser } from "../packages/core/src/users.js";
import {
  createUserSkillForPrincipal,
  deleteUserSkillForPrincipal,
  getUserSkillForPrincipal,
  listUserSkillsForPrincipal,
  searchUserSkillsForPrincipal,
  setUserSkillForPrincipal,
  userScopedCapabilityHints,
} from "../packages/core/src/user-skills.js";
import { createTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import { acquireDesktopLease } from "../packages/browsers/src/desktop-leases.js";
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

async function readWebSocketMessage(url, cookie, predicate) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("websocket_message_timeout"));
    }, 3000);
    const done = (error, payload) => {
      clearTimeout(timer);
      ws.close();
      error ? reject(error) : resolve(payload);
    };
    ws.on("message", (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch (error) {
        done(error);
        return;
      }
      if (!predicate || predicate(payload)) done(null, payload);
    });
    ws.on("unexpected-response", (_request, response) => {
      done(new Error(`websocket_unexpected_status:${response.statusCode}`));
    });
    ws.on("error", (error) => done(error));
  });
}

async function rejectedWebSocketStatus(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("websocket_rejection_timeout"));
    }, 3000);
    const done = (error, statusCode) => {
      clearTimeout(timer);
      error ? reject(error) : resolve(statusCode);
    };
    ws.on("unexpected-response", (_request, response) => done(null, response.statusCode));
    ws.on("open", () => done(new Error("websocket_opened_unexpectedly")));
    ws.on("error", (error) => done(error));
  });
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

test("non-admin audit events are scoped to owned resources", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-events-"));
  const env = { ORKESTR_HOME: home };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env));
  const bob = userPrincipal(await upsertUser({ id: "bob", role: "user", displayName: "Bob" }, env));
  await createThreadForPrincipal({ id: "alice-thread", name: "Alice Main" }, alice, env);
  await createThreadForPrincipal({ id: "bob-thread", name: "Bob Main" }, bob, env);
  await appendEvent({ type: "alice_thread_event", threadId: "alice-thread" }, env);
  await appendEvent({
    type: "thread_message_completed",
    actorUserId: "alice",
    threadId: "alice-thread",
    connector: "gmail",
    text: "sensitive message body",
    prompt: "sensitive prompt",
  }, env);
  await appendEvent({ type: "bob_owner_event", ownerUserId: "bob" }, env);
  await appendEvent({ type: "global_event" }, env);

  const aliceEvents = await listEventsForPrincipal(alice, env);
  const bobEvents = await listEventsForPrincipal(bob, env);
  const adminEvents = await listEventsForPrincipal(adminPrincipal(), env);

  assert.deepEqual(aliceEvents.map((event) => event.type), ["user_created", "thread_created", "alice_thread_event", "thread_message_completed"]);
  assert.deepEqual(bobEvents.map((event) => event.type), ["user_created", "thread_created", "bob_owner_event"]);
  assert.deepEqual(adminEvents.map((event) => event.type), [
    "user_created",
    "user_created",
    "thread_created",
    "thread_created",
    "alice_thread_event",
    "thread_message_completed",
    "bob_owner_event",
    "global_event",
  ]);

  const filtered = await listEventsForPrincipal(adminPrincipal(), env, 20, {
    user: "alice",
    resource: "thread",
    connector: "gmail",
    outcome: "allowed",
  });
  const messageEvent = filtered.find((event) => event.type === "thread_message_completed");
  assert.equal(messageEvent.ownerUserId, "alice");
  assert.equal(messageEvent.actorUserId, "alice");
  assert.equal(messageEvent.resourceType, "thread");
  assert.equal(messageEvent.action, "thread.message.completed");
  assert.equal(messageEvent.outcome, "allowed");
  assert.equal(messageEvent.connector, "gmail");
  assert.equal(messageEvent.text, "[redacted]");
  assert.equal(messageEvent.prompt, "[redacted]");
});

test("non-admin workspace and file browsing stays inside per-user roots", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-files-"));
  const runtimeWorkspaceRoot = path.join(home, "runtime-workspaces");
  const env = { ORKESTR_HOME: home, ORKESTR_RUNTIME_WORKSPACE_ROOT: runtimeWorkspaceRoot };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env));
  const bob = userPrincipal(await upsertUser({ id: "bob", role: "user", displayName: "Bob" }, env));
  const alicePaths = userDataPaths("alice", env);
  const bobPaths = userDataPaths("bob", env);
  const aliceWorkspaceRoot = path.join(runtimeWorkspaceRoot, "users", "alice");
  const bobWorkspaceRoot = path.join(runtimeWorkspaceRoot, "users", "bob");
  await fs.mkdir(path.join(aliceWorkspaceRoot, "project-a"), { recursive: true });
  await fs.mkdir(path.join(alicePaths.files, "notes"), { recursive: true });
  await fs.writeFile(path.join(alicePaths.files, "notes", "todo.txt"), "hello", "utf8");
  await fs.mkdir(path.join(bobWorkspaceRoot, "project-b"), { recursive: true });

  const aliceRoot = await workspaceRootForPrincipal(alice, env);
  const aliceWorkspacePath = await resolveWorkspacePathForPrincipal("project-a", alice, env);
  const aliceFolders = await listWorkspaceFoldersForPrincipal("", alice, env);
  const aliceFiles = await listFilesForPrincipal(path.join(alicePaths.files, "notes"), alice, env);
  const bobProbe = await listWorkspaceFoldersForPrincipal(bobWorkspaceRoot, alice, env);
  const adminFolders = await listWorkspaceFoldersForPrincipal(aliceWorkspaceRoot, adminPrincipal(), env);
  const adminFiles = await listFilesForPrincipal("", adminPrincipal(), env);

  assert.equal(aliceRoot, aliceWorkspaceRoot);
  assert.equal(aliceWorkspacePath, path.join(aliceWorkspaceRoot, "project-a"));
  assert.deepEqual(aliceFolders.roots.map((root) => root.path), [aliceWorkspaceRoot]);
  assert.deepEqual(aliceFolders.entries.map((entry) => entry.name), ["project-a"]);
  assert.deepEqual(aliceFiles.entries.map((entry) => entry.name), ["todo.txt"]);
  assert.equal(bobProbe.ok, false);
  assert.equal(bobProbe.error, "workspace_path_forbidden");
  assert.ok(adminFolders.roots.some((root) => root.path === runtimeWorkspaceRoot));
  assert.equal(adminFiles.ok, true);
  assert.ok(adminFiles.roots.some((root) => root.path === path.join(home, "files")));
  assert.notEqual(aliceRoot, alicePaths.workspaces);
  assert.notEqual(bobWorkspaceRoot, bobPaths.workspaces);
  await assert.rejects(() => resolveWorkspacePathForPrincipal(bobWorkspaceRoot, alice, env), /workspace_path_forbidden/);
});

test("non-admin workspaces fall back to deploy workspace root outside ORKESTR_HOME", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-deploy-workspace-"));
  const deployRoot = path.join(home, "deploy");
  const env = { ORKESTR_HOME: path.join(home, "private-home"), ORKESTR_DEPLOY_ROOT: deployRoot };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env));

  const root = await workspaceRootForPrincipal(alice, env);

  assert.equal(root, path.join(deployRoot, "workspace", "users", "alice"));
  assert.equal(root.startsWith(env.ORKESTR_HOME), false);
});

test("admin-created user threads use the target user's workspace root", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-admin-user-workspace-"));
  const runtimeWorkspaceRoot = path.join(home, "runtime-workspaces");
  const priorHome = process.env.ORKESTR_HOME;
  const priorWorkspaceRoot = process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT = runtimeWorkspaceRoot;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  let server;

  try {
    await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, process.env);
    server = await startServer({ port: 0, host: "127.0.0.1" });
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice Admin Created", ownerUserId: "alice", executorId: "noop" }),
    });
    const payload = await response.json();
    const aliceWorkspaceRoot = path.join(runtimeWorkspaceRoot, "users", "alice");

    assert.equal(response.status, 201);
    assert.equal(payload.thread.ownerUserId, "alice");
    assert.ok(String(payload.thread.workspace || "").startsWith(aliceWorkspaceRoot));
    assert.ok(String(payload.thread.cwd || "").startsWith(aliceWorkspaceRoot));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorWorkspaceRoot === undefined) delete process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT;
    else process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT = priorWorkspaceRoot;
    if (priorRecover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START;
    else process.env.ORKESTR_RECOVER_RUNNING_ON_START = priorRecover;
  }
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

test("non-admin creation helpers fail closed without an explicit owner principal", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-owner-required-"));
  const env = await allowSanitizerEnv(home);

  await assert.rejects(
    () => createThreadForPrincipal({ id: "missing-owner-thread", name: "Missing Owner" }, { role: "user" }, env),
    /thread_owner_required/,
  );
  await assert.rejects(
    () => createTimerForPrincipal({ label: "Missing Owner Timer", prompt: "hello" }, { role: "user" }, env),
    /timer_owner_required/,
  );
  assert.deepEqual((await listThreadsForPrincipal(adminPrincipal(), env)).map((thread) => thread.id), []);
  assert.deepEqual((await listTimers(env)).map((timer) => timer.id), []);
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

test("user skill registry is scoped per owner and stores public skill toggles", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-skills-"));
  const env = { ORKESTR_HOME: home };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env));
  const bob = userPrincipal(await upsertUser({ id: "bob", role: "user", displayName: "Bob" }, env));

  const initial = await listUserSkillsForPrincipal("alice", alice, env);
  assert.ok(initial.skills.some((skill) => skill.id === "gmail" && skill.enabled));
  assert.equal(initial.skills.find((skill) => skill.id === "linkedin")?.label, "Managed Desktop");
  assert.ok(initial.skills.some((skill) => skill.id === "learning" && skill.scopes.includes("own_workspace")));
  assert.equal(initial.skills.some((skill) => Object.hasOwn(skill, "token")), false);

  const disabled = await setUserSkillForPrincipal("alice", "gmail", { enabled: false }, alice, env);
  const created = await createUserSkillForPrincipal("alice", {
    name: "Box transfer",
    description: "Use the user's Box account for their own transfer workflow.",
    instructions: "Ask the user what they want moved, then use only the accounts they connected.",
    metadata: { endpoint: "box", token: "never-store-this" },
  }, alice, env);
  const fetched = await getUserSkillForPrincipal("alice", created.skill.id, alice, env);
  const searched = await searchUserSkillsForPrincipal("alice", "transfer", alice, env);
  const updated = await setUserSkillForPrincipal("alice", created.skill.id, {
    instructions: "Only work with the user's own connected accounts.",
    enabled: true,
  }, alice, env);
  const deleted = await deleteUserSkillForPrincipal("alice", created.skill.id, alice, env);
  const after = await listUserSkillsForPrincipal("alice", adminPrincipal(), env);
  const file = await fs.readFile(userDataPaths("alice", env).skills, "utf8");

  assert.equal(disabled.skill.id, "gmail");
  assert.equal(disabled.skill.enabled, false);
  assert.equal(created.skill.id, "box-transfer");
  assert.equal(created.skill.builtIn, false);
  assert.equal(created.skill.metadata.endpoint, "box");
  assert.equal(Object.hasOwn(created.skill.metadata, "token"), false);
  assert.equal(fetched.skill.id, "box-transfer");
  assert.equal(searched.skills.some((skill) => skill.id === "box-transfer"), true);
  assert.match(updated.skill.instructions, /own connected accounts/);
  assert.equal(deleted.deleted, true);
  assert.equal(after.skills.find((skill) => skill.id === "gmail").enabled, false);
  assert.equal(after.skills.some((skill) => skill.id === "box-transfer"), false);
  assert.match(file, /"gmail"/);
  assert.equal(file.includes("secret"), false);
  assert.equal(file.includes("token"), false);
  await assert.rejects(() => listUserSkillsForPrincipal("bob", alice, env), /user_skills_access_forbidden/);
  await assert.rejects(() => setUserSkillForPrincipal("bob", "timers", { enabled: false }, alice, env), /user_skills_update_forbidden/);
  assert.ok((await listUserSkillsForPrincipal("bob", bob, env)).skills.some((skill) => skill.id === "timers"));
});

test("non-admin thread input sanitizer receives user skill guarded capabilities", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-skill-sanitizer-"));
  const captureFile = path.join(home, "sanitizer-payload.json");
  const script = path.join(home, "capture-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "import fs from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  fs.writeFileSync(${JSON.stringify(captureFile)}, input);`,
      "  const payload = JSON.parse(input);",
      "  const caps = payload.resource?.capabilities || {};",
      "  const ok = caps.whatsapp === true && caps.gmail === false && caps.scopedConnectors?.gmail === true && caps.hostSkills === false && Array.isArray(caps.disabledSkills) && caps.disabledSkills.includes('gmail');",
      "  console.log(JSON.stringify({ allow: ok, reason: ok ? 'skill-caps-ok' : 'skill-caps-mismatch', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env));
  await createTenantVm({
    id: "alice-tenant",
    ownerUserId: "alice",
    status: "running",
    capabilities: ["codex", "whatsapp", "gmail"],
    connectors: { whatsappChatId: "wa-1", gmailAccountId: "alice-gmail" },
  }, env);
  await setUserSkillForPrincipal("alice", "gmail", { enabled: false }, alice, env);
  await createThreadForPrincipal({
    id: "alice-thread",
    name: "Main",
    binding: { connector: "whatsapp", chatId: "wa-1" },
  }, alice, env);

  const message = await enqueueThreadInputForPrincipal("alice-thread", { text: "Check my Gmail", source: "whatsapp" }, alice, env);
  const captured = JSON.parse(await fs.readFile(captureFile, "utf8"));

  assert.equal(message.state, "queued");
  assert.equal(captured.resource.capabilities.whatsapp, true);
  assert.equal(captured.resource.capabilities.gmail, false);
  assert.equal(captured.resource.capabilities.scopedConnectors.gmail, true);
  assert.equal(captured.resource.capabilities.hostSkills, false);
  assert.ok(captured.resource.capabilities.disabledSkills.includes("gmail"));
  assert.ok(captured.resource.capabilities.enabledSkills.includes("whatsapp"));
});

test("WhatsApp-bound tenant thread exposes scoped WhatsApp capability without tenant VM connector state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-wa-thread-caps-"));
  const env = { ORKESTR_HOME: home };
  const alice = userPrincipal(await upsertUser({ id: "alice", role: "user", displayName: "Alice" }, env));
  const thread = await createThreadForPrincipal({
    id: "alice-wa-thread",
    name: "Alice WA",
    binding: { connector: "whatsapp", chatId: "chat-alice" },
  }, alice, env);

  const capabilities = await userScopedCapabilityHints({ userId: "alice", thread }, env);

  assert.equal(capabilities.whatsapp, true);
  assert.equal(capabilities.scopedConnectors.whatsapp, true);
  assert.equal(capabilities.gmail, false);
  assert.equal(capabilities.linkedin, true);
  assert.equal(capabilities.desktopLeases, true);
  assert.equal(capabilities.scopedConnectors.linkedin, true);
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
  const auditEvents = await listEventsForPrincipal(adminPrincipal(), env, 20, {
    user: "alice",
    resource: "thread",
    outcome: "allowed",
  });
  const sanitizerEvent = auditEvents.find((event) => event.type === "policy_sanitizer_decision" && event.action === "thread.input");

  assert.equal(message.state, "queued");
  assert.equal(message.ownerUserId, "alice");
  assert.equal(messages.length, 1);
  assert.equal(sanitizerEvent.ownerUserId, "alice");
  assert.equal(sanitizerEvent.actorUserId, "alice");
  assert.equal(sanitizerEvent.resourceType, "thread");
  assert.equal(sanitizerEvent.outcome, "allowed");
  assert.equal(sanitizerEvent.model, "test-llm");
  assert.equal("input" in sanitizerEvent, false);
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

test("fresh local admin can create a user-targeted browser pairing challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-local-pairing-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_AUTH_REQUIRED;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  await createUser({ email: "alice@example.test", phoneNumber: "+15551234567", role: "user", displayName: "Alice" }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function read(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  try {
    const challenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "alice-example.test" }),
    }));
    assert.equal(challenge.ok, true);
    assert.equal(challenge.challenge.userId, "alice-example.test");
    assert.equal(challenge.challenge.role, "user");
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

test("user management API is admin-only and can pair a browser to a managed user", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-use-control-api-users-"));
  const runtimeWorkspaceRoot = path.join(home, "runtime-workspaces");
  const priorHome = process.env.ORKESTR_HOME;
  const priorWorkspaceRoot = process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT = runtimeWorkspaceRoot;
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
    await createUser({ email: "bob@example.test", phoneNumber: "+15557654321", role: "user", displayName: "Bob" }, process.env);

    const linkedWhatsApp = await read(await fetch(`${baseUrl}/api/users/alice-example.test/identities/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        accountId: "main",
        externalId: "491234567890@c.us",
        chatId: "manual-chat@g.us",
        displayName: "Alice WhatsApp",
      }),
    }));
    assert.equal(linkedWhatsApp.identities[0].provider, "whatsapp");
    assert.equal(linkedWhatsApp.identities[0].source, "manual");
    assert.equal(linkedWhatsApp.identities[0].externalId, "491234567890@c.us");
    assert.equal(linkedWhatsApp.identities[0].chatId, "manual-chat@g.us");

    const duplicateWhatsAppResponse = await fetch(`${baseUrl}/api/users/bob-example.test/identities/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ accountId: "main", externalId: "491234567890@c.us" }),
    });
    const duplicateWhatsApp = await read(duplicateWhatsAppResponse);
    assert.equal(duplicateWhatsAppResponse.status, 409);
    assert.equal(duplicateWhatsApp.error, "whatsapp_identity_already_assigned");

    const migratedWhatsApp = await read(await fetch(`${baseUrl}/api/users/bob-example.test/identities/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ accountId: "main", externalId: "491234567890@c.us", migrate: true }),
    }));
    assert.equal(migratedWhatsApp.userId, "bob-example.test");
    assert.equal(migratedWhatsApp.identities[0].externalId, "491234567890@c.us");
    const aliceIdentitiesAfterMigration = await read(await fetch(`${baseUrl}/api/users/alice-example.test/identities`, { headers: { cookie: adminCookie } }));
    assert.deepEqual(aliceIdentitiesAfterMigration.identities, []);
    const unlinkedWhatsApp = await read(await fetch(`${baseUrl}/api/users/bob-example.test/identities/whatsapp/unlink`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ accountId: "main", externalId: "491234567890@c.us" }),
    }));
    assert.deepEqual(unlinkedWhatsApp.identities, []);

    const linkedChatOnlyWhatsApp = await read(await fetch(`${baseUrl}/api/users/alice-example.test/identities/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ accountId: "main", chatId: "chat-only@g.us", displayName: "Alice Group" }),
    }));
    assert.equal(linkedChatOnlyWhatsApp.identities[0].chatId, "chat-only@g.us");

    const linkedGmail = await read(await fetch(`${baseUrl}/api/users/alice-example.test/identities/gmail`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ account: "Alice@Example.Test", displayName: "Alice Gmail" }),
    }));
    const gmailIdentity = linkedGmail.identities.find((identity) => identity.provider === "gmail");
    assert.equal(gmailIdentity.externalId, "alice@example.test");
    assert.equal(gmailIdentity.source, "manual");

    const duplicateGmailResponse = await fetch(`${baseUrl}/api/users/bob-example.test/identities/gmail`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ account: "alice@example.test" }),
    });
    const duplicateGmail = await read(duplicateGmailResponse);
    assert.equal(duplicateGmailResponse.status, 409);
    assert.equal(duplicateGmail.error, "gmail_identity_already_assigned");

    const linkedOutlook = await read(await fetch(`${baseUrl}/api/users/alice-example.test/identities/outlook`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ account: "alice@outlook.example", displayName: "Alice Outlook" }),
    }));
    assert.ok(linkedOutlook.identities.some((identity) => identity.provider === "outlook" && identity.externalId === "alice@outlook.example"));

    const unlinkedOutlook = await read(await fetch(`${baseUrl}/api/users/alice-example.test/identities/outlook/unlink`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ account: "alice@outlook.example" }),
    }));
    assert.equal(unlinkedOutlook.identities.some((identity) => identity.provider === "outlook"), false);

    await writeConnectorConfig("gmail", {
      clientId: "gmail-client",
      redirectUri: `${baseUrl}/oauth/gmail/callback`,
    }, process.env);
    const userGmailOAuth = await read(await fetch(`${baseUrl}/api/users/alice-example.test/connectors/gmail/oauth/start`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ account: "alice-oauth@example.test" }),
    }));
    assert.equal(userGmailOAuth.userId, "alice-example.test");
    assert.match(userGmailOAuth.authorizeUrl, /accounts\.google\.com/);
    assert.ok(userGmailOAuth.identities.some((identity) => identity.provider === "gmail" && identity.externalId === "alice-oauth@example.test"));
    const aliceGmailState = JSON.parse(await fs.readFile(path.join(userDataPaths("alice-example.test", process.env).oauth, "gmail-state.json"), "utf8"));
    assert.equal(aliceGmailState.userId, "alice-example.test");
    assert.equal(aliceGmailState.account, "alice-oauth@example.test");

    const adminSkills = await read(await fetch(`${baseUrl}/api/users/alice-example.test/skills`, { headers: { cookie: adminCookie } }));
    assert.ok(adminSkills.skills.some((skill) => skill.id === "learning"));
    const disabledSkill = await read(await fetch(`${baseUrl}/api/users/alice-example.test/skills/linkedin`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ enabled: false }),
    }));
    assert.equal(disabledSkill.skill.id, "linkedin");
    assert.equal(disabledSkill.skill.enabled, false);
    assert.equal(disabledSkill.skill.label, "Managed Desktop");
    const createdSkill = await read(await fetch(`${baseUrl}/api/users/alice-example.test/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        name: "Calendly follow-up",
        description: "Help this user handle their own scheduling workflow.",
        instructions: "Use only accounts connected by this user.",
        metadata: { workspace: "calendar", apiKey: "not-stored" },
      }),
    }));
    assert.equal(createdSkill.skill.id, "calendly-follow-up");
    assert.equal(createdSkill.skill.metadata.workspace, "calendar");
    assert.equal(Object.hasOwn(createdSkill.skill.metadata, "apiKey"), false);
    const fetchedSkill = await read(await fetch(`${baseUrl}/api/users/alice-example.test/skills/calendly-follow-up`, { headers: { cookie: adminCookie } }));
    assert.equal(fetchedSkill.skill.description, "Help this user handle their own scheduling workflow.");
    const searchedSkill = await read(await fetch(`${baseUrl}/api/users/alice-example.test/skills/search?q=calendly`, { headers: { cookie: adminCookie } }));
    assert.equal(searchedSkill.skills.some((skill) => skill.id === "calendly-follow-up"), true);
    const deletedSkill = await read(await fetch(`${baseUrl}/api/users/alice-example.test/skills/calendly-follow-up`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    }));
    assert.equal(deletedSkill.deleted, true);

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
    const adminSessions = await read(await fetch(`${baseUrl}/api/setup/security/sessions`, { headers: { cookie: adminCookie } }));
    const userSession = adminSessions.sessions.find((session) => session.userId === "alice-example.test");
    assert.ok(userSession, JSON.stringify(adminSessions));
    assert.equal(userSession.role, "user");
    await createThread({ id: "alice-existing", name: "Alice Existing", ownerUserId: "alice-example.test" }, process.env);
    await createThread({ id: "bob-hidden", name: "Bob Hidden", ownerUserId: "bob-example.test" }, process.env);
    await acquireDesktopLease("linkedin", { threadId: "alice-existing", threadName: "Alice Existing" }, process.env, {
      principal: userPrincipal({ id: "alice-example.test", role: "user" }),
    });
    await acquireDesktopLease("gmail", { threadId: "bob-hidden", threadName: "Bob Hidden" }, process.env, {
      principal: userPrincipal({ id: "bob-example.test", role: "user" }),
    });

    const currentUser = await read(await fetch(`${baseUrl}/api/users/me`, { headers: { cookie: userCookie } }));
    assert.ok(currentUser.user, JSON.stringify(currentUser));
    assert.equal(currentUser.user.id, "alice-example.test");
    assert.equal(currentUser.user.role, "user");
    assert.equal(currentUser.user.resourceSummary.threadCount, 1);
    const selfOnboardingPatch = await read(await fetch(`${baseUrl}/api/users/me/onboarding`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ profile: { timezone: "Europe/Berlin" } }),
    }));
    assert.equal(selfOnboardingPatch.onboarding.profile.timezone, "Europe/Berlin");
    const selfOnboarding = await read(await fetch(`${baseUrl}/api/users/me/onboarding`, { headers: { cookie: userCookie } }));
    assert.equal(selfOnboarding.onboarding.profile.timezone, "Europe/Berlin");
    const deniedSelfStateResponse = await fetch(`${baseUrl}/api/users/me/onboarding`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ state: "active" }),
    });
    const deniedSelfState = await read(deniedSelfStateResponse);
    assert.equal(deniedSelfStateResponse.status, 403);
    assert.equal(deniedSelfState.error, "admin_required");
    const deniedCrossOnboardingResponse = await fetch(`${baseUrl}/api/users/bob-example.test/onboarding`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ profile: { timezone: "Europe/London" } }),
    });
    const deniedCrossOnboarding = await read(deniedCrossOnboardingResponse);
    assert.equal(deniedCrossOnboardingResponse.status, 403);
    assert.equal(deniedCrossOnboarding.error, "user_onboarding_forbidden");
    await recordCreditUsage({
      tenantId: "alice-example.test",
      threadId: "alice-existing",
      messageId: "message-1",
      responseId: "resp-usage-1",
      model: "gpt-5-mini",
      usage: { input_tokens: 1000, output_tokens: 25 },
    }, process.env);

    const denied = await fetch(`${baseUrl}/api/users`, { headers: { cookie: userCookie } });
    assert.equal(denied.status, 403);

    const deniedTargetChallengeResponse = await fetch(`${baseUrl}/api/setup/security/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ userId: "bob-example.test" }),
    });
    const deniedTargetChallenge = await read(deniedTargetChallengeResponse);
    assert.equal(deniedTargetChallengeResponse.status, 403);
    assert.equal(deniedTargetChallenge.error, "admin_pairing_required");

    const selfSkills = await read(await fetch(`${baseUrl}/api/users/me/skills`, { headers: { cookie: userCookie } }));
    assert.equal(selfSkills.userId, "alice-example.test");
    assert.equal(selfSkills.skills.find((skill) => skill.id === "linkedin").enabled, false);
    const selfSkillCreate = await read(await fetch(`${baseUrl}/api/users/me/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({
        name: "Job board helper",
        description: "Help this user with job board workflows they control.",
        instructions: "Use only the user's own accounts and browser sessions.",
      }),
    }));
    assert.equal(selfSkillCreate.skill.id, "job-board-helper");
    const selfSkillSearch = await read(await fetch(`${baseUrl}/api/users/me/skills/search?q=job`, { headers: { cookie: userCookie } }));
    assert.equal(selfSkillSearch.skills.some((skill) => skill.id === "job-board-helper"), true);
    const selfSkillUpdate = await read(await fetch(`${baseUrl}/api/users/me/skills/learning`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ enabled: false }),
    }));
    assert.equal(selfSkillUpdate.skill.enabled, false);
    const selfLinkedInEnable = await read(await fetch(`${baseUrl}/api/users/me/skills/linkedin`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ enabled: true }),
    }));
    assert.equal(selfLinkedInEnable.skill.enabled, true);
    const selfSkillDelete = await read(await fetch(`${baseUrl}/api/users/me/skills/job-board-helper`, {
      method: "DELETE",
      headers: { cookie: userCookie },
    }));
    assert.equal(selfSkillDelete.deleted, true);
    const crossSkillsResponse = await fetch(`${baseUrl}/api/users/bob-example.test/skills`, { headers: { cookie: userCookie } });
    const crossSkills = await read(crossSkillsResponse);
    assert.equal(crossSkillsResponse.status, 403);
    assert.equal(crossSkills.error, "user_skills_access_forbidden");

    for (const route of [
      "/api/codex/threads",
      "/api/executions",
      "/api/runtime-leases",
      "/api/settings",
      "/api/system/processes",
      "/api/setup/backup/status",
      "/api/setup/security/sessions",
    ]) {
      const response = await fetch(`${baseUrl}${route}`, { headers: { cookie: userCookie } });
      const payload = await read(response);
      assert.equal(response.status, 403, route);
      assert.equal(payload.error, "control_plane_admin_required", route);
    }

    const deniedConnectorResponse = await fetch(`${baseUrl}/api/connectors/whatsapp/status`, {
      headers: { cookie: userCookie, connection: "close" },
    });
    const deniedConnector = await read(deniedConnectorResponse);
    assert.equal(deniedConnectorResponse.status, 403);
    assert.equal(deniedConnector.error, "connector_admin_required");

    const userGmailStatusResponse = await fetch(`${baseUrl}/api/connectors/gmail/test`, {
      method: "POST",
      headers: { cookie: userCookie, connection: "close" },
    });
    const userGmailStatus = await read(userGmailStatusResponse);
    assert.equal(userGmailStatusResponse.status, 200);
    assert.equal(userGmailStatus.id, "gmail");

    const userBrowsers = await read(await fetch(`${baseUrl}/api/browser-sessions`, { headers: { cookie: userCookie } }));
    assert.equal(userBrowsers.ok, true);
    assert.ok(userBrowsers.sessions.length > 0);
    assert.ok(userBrowsers.sessions.every((session) => session.ownerUserId === "alice-example.test"));
    const userDesktopLeases = await read(await fetch(`${baseUrl}/api/desktops/leases`, { headers: { cookie: userCookie } }));
    assert.deepEqual(userDesktopLeases.desktopLeases.map((lease) => lease.ownerUserId), ["alice-example.test"]);
    assert.deepEqual(userDesktopLeases.desktopLeases.map((lease) => lease.desktopSlug), ["linkedin"]);
    const adminDesktopLeases = await read(await fetch(`${baseUrl}/api/desktops/leases`, { headers: { cookie: adminCookie } }));
    assert.deepEqual(
      adminDesktopLeases.desktopLeases.map((lease) => `${lease.ownerUserId}:${lease.desktopSlug}`).sort(),
      ["alice-example.test:linkedin", "bob-example.test:gmail"],
    );
    const deniedBobReleaseResponse = await fetch(`${baseUrl}/api/desktops/gmail/release`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ force: true, ownerUserId: "bob-example.test", reason: "cross_user_release_attempt" }),
    });
    const deniedBobRelease = await read(deniedBobReleaseResponse);
    assert.equal(deniedBobReleaseResponse.status, 404);
    assert.equal(deniedBobRelease.error, "lease_not_found");
    const bobLeaseStillVisibleToAdmin = await read(await fetch(`${baseUrl}/api/desktops/leases`, { headers: { cookie: adminCookie } }));
    assert.ok(bobLeaseStillVisibleToAdmin.desktopLeases.some((lease) => lease.ownerUserId === "bob-example.test" && lease.desktopSlug === "gmail"));
    const adminReleaseBob = await read(await fetch(`${baseUrl}/api/desktops/gmail/release`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ force: true, ownerUserId: "bob-example.test", reason: "admin_test_release" }),
    }));
    assert.equal(adminReleaseBob.ok, true);
    assert.equal(adminReleaseBob.lease.ownerUserId, "bob-example.test");

    const deniedDesktopResponse = await fetch(`${baseUrl}/api/browsers/linkedin/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ reason: "test desktop sanitizer" }),
    });
    const deniedDesktop = await read(deniedDesktopResponse);
    assert.equal(deniedDesktopResponse.status, 403);
    assert.equal(deniedDesktop.error, "llm_sanitizer_unconfigured");

    const deniedThreadCreateResponse = await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ name: "Alice Workspace", executorId: "noop" }),
    });
    const deniedThreadCreate = await read(deniedThreadCreateResponse);
    assert.equal(deniedThreadCreateResponse.status, 403);
    assert.equal(deniedThreadCreate.error, "llm_sanitizer_unconfigured");

    const deniedWakeResponse = await fetch(`${baseUrl}/api/threads/alice-existing/wake`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ reason: "test wake sanitizer" }),
    });
    const deniedWake = await read(deniedWakeResponse);
    assert.equal(deniedWakeResponse.status, 403);
    assert.equal(deniedWake.error, "llm_sanitizer_unconfigured");

    const deniedWorkersResponse = await fetch(`${baseUrl}/api/threads/alice-existing/workers`, {
      headers: { cookie: userCookie },
    });
    const deniedWorkers = await read(deniedWorkersResponse);
    assert.equal(deniedWorkersResponse.status, 403);
    assert.equal(deniedWorkers.error, "thread_workers_admin_required");

    const unauthenticatedSummaryStatus = await rejectedWebSocketStatus(`ws://127.0.0.1:${port}/api/threads/summary/stream`, "");
    assert.equal(unauthenticatedSummaryStatus, 401);
    const summary = await readWebSocketMessage(
      `ws://127.0.0.1:${port}/api/threads/summary/stream`,
      userCookie,
      (payload) => payload.type === "threads_summary",
    );
    assert.deepEqual(summary.threads.map((thread) => thread.id), ["alice-existing"]);
    const rawStreamStatus = await rejectedWebSocketStatus(`ws://127.0.0.1:${port}/api/threads/alice-existing/stream`, userCookie);
    assert.equal(rawStreamStatus, 403);

    const where = await read(await fetch(`${baseUrl}/api/whereiam`, { headers: { cookie: userCookie } }));
    assert.equal(where.user.userId, "alice-example.test");
    assert.equal(where.user.role, "user");
    const adminUsage = await read(await fetch(`${baseUrl}/api/users/credit-usage`, { headers: { cookie: adminCookie } }));
    const userUsage = await read(await fetch(`${baseUrl}/api/users/me/credit-usage`, { headers: { cookie: userCookie } }));
    const scopedUsage = await read(await fetch(`${baseUrl}/api/users/alice-example.test/credit-usage`, { headers: { cookie: userCookie } }));
    const forbiddenUsage = await fetch(`${baseUrl}/api/users/admin/credit-usage`, { headers: { cookie: userCookie } });
    assert.equal(adminUsage.tenants.some((usage) => usage.tenantId === "alice-example.test"), true);
    assert.ok(userUsage.usage, JSON.stringify(userUsage));
    assert.equal(userUsage.usage.tenantId, "alice-example.test");
    assert.equal(userUsage.usage.count, 1);
    assert.equal(scopedUsage.usage.count, 1);
    assert.equal(forbiddenUsage.status, 403);

    const userPaths = userDataPaths("alice-example.test", process.env);
    const userWorkspaceRoot = path.join(runtimeWorkspaceRoot, "users", "alice-example.test");
    await fs.mkdir(path.join(userWorkspaceRoot, "visible-project"), { recursive: true });
    await fs.mkdir(path.join(userPaths.files, "uploads"), { recursive: true });
    await fs.writeFile(path.join(userPaths.files, "uploads", "readme.txt"), "scoped", "utf8");

    const workspaceFolders = await read(await fetch(`${baseUrl}/api/system/workspace-folders`, { headers: { cookie: userCookie } }));
    const forbiddenFolders = await read(await fetch(`${baseUrl}/api/system/workspace-folders?path=${encodeURIComponent(home)}`, {
      headers: { cookie: userCookie },
    }));
    const files = await read(await fetch(`${baseUrl}/api/files?path=${encodeURIComponent(path.join(userPaths.files, "uploads"))}`, {
      headers: { cookie: userCookie },
    }));

    assert.deepEqual(workspaceFolders.roots.map((root) => root.path), [userWorkspaceRoot]);
    assert.deepEqual(workspaceFolders.entries.map((entry) => entry.name), ["visible-project"]);
    assert.equal(forbiddenFolders.ok, false);
    assert.equal(forbiddenFolders.error, "workspace_path_forbidden");
    assert.deepEqual(files.entries.map((entry) => entry.name), ["readme.txt"]);

    const createdFolder = await read(await fetch(`${baseUrl}/api/files/folders`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ path: userPaths.files, name: "docs" }),
    }));
    assert.equal(createdFolder.ok, true);
    assert.ok(createdFolder.entries.some((entry) => entry.name === "docs" && entry.directory));

    const uploadBody = new FormData();
    uploadBody.append("path", path.join(userPaths.files, "docs"));
    uploadBody.append("files", new Blob(["uploaded"], { type: "text/plain" }), "note.txt");
    const uploaded = await read(await fetch(`${baseUrl}/api/files/uploads`, {
      method: "POST",
      headers: { cookie: userCookie },
      body: uploadBody,
    }));
    assert.equal(uploaded.ok, true);
    assert.deepEqual(uploaded.files.map((entry) => entry.name), ["note.txt"]);
    assert.deepEqual(uploaded.entries.map((entry) => entry.name), ["note.txt"]);

    const deletedUpload = await read(await fetch(`${baseUrl}/api/files?path=${encodeURIComponent(path.join(userPaths.files, "docs", "note.txt"))}`, {
      method: "DELETE",
      headers: { cookie: userCookie },
    }));
    assert.equal(deletedUpload.ok, true);
    assert.deepEqual(deletedUpload.entries.map((entry) => entry.name), []);

    const forbiddenDelete = await read(await fetch(`${baseUrl}/api/files?path=${encodeURIComponent(path.join(home, "users.json"))}`, {
      method: "DELETE",
      headers: { cookie: userCookie },
    }));
    assert.equal(forbiddenDelete.ok, false);
    assert.equal(forbiddenDelete.error, "file_path_forbidden");

    const revokedUserSession = await read(await fetch(`${baseUrl}/api/setup/security/sessions/${userSession.id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
    }));
    assert.deepEqual(revokedUserSession.revoked, [userSession.id]);
    const afterRevoke = await fetch(`${baseUrl}/api/users/me`, { headers: { cookie: userCookie } });
    assert.equal(afterRevoke.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorWorkspaceRoot === undefined) delete process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT;
    else process.env.ORKESTR_RUNTIME_WORKSPACE_ROOT = priorWorkspaceRoot;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorRecover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START;
    else process.env.ORKESTR_RECOVER_RUNNING_ON_START = priorRecover;
  }
});
