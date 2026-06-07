import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteSecureSecret,
  listSecureInputRequests,
  listSecureSecrets,
  parseSecureSecretReference,
  resolveSecureSecretReference,
  resolveSecureSecretValue,
  secureSecretHandleFor,
  setSecureSecret,
} from "../packages/core/src/secure-secrets.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { listEvents } from "../packages/storage/src/store.js";

async function readTreeText(root) {
  let text = "";
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) text += await readTreeText(filePath);
    else text += await fs.readFile(filePath, "utf8").catch(() => "");
  }
  return text;
}

test("secure secrets store metadata only and resolve user/admin/global order", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-secure-secrets-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const admin = adminPrincipal("admin");
  const alice = userPrincipal({ id: "alice", role: "user" });

  const global = await setSecureSecret({ scope: "global", name: "openai/api-key", value: "global-secret" }, admin, env);
  const adminUser = await setSecureSecret({ scope: "user", ownerUserId: "alice", name: "openai/api-key", value: "admin-user-secret" }, admin, env);
  const own = await setSecureSecret({ scope: "user", name: "openai/api-key", value: "alice-secret" }, alice, env);

  assert.equal(global.secret.handle, "secret://global/openai/api-key");
  assert.equal(adminUser.secret.handle, "secret://user/alice/openai/api-key");
  assert.equal(own.secret.handle, "secret://user/alice/openai/api-key");
  for (const metadata of [global.secret, adminUser.secret, own.secret]) {
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, "value"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, "secret"), false);
  }

  const listedAlice = await listSecureSecrets({ scope: "user", ownerUserId: "alice" }, alice, env);
  assert.equal(listedAlice.secrets.length, 2);
  assert.deepEqual(listedAlice.secrets.map((secret) => secret.managedBy).sort(), ["admin", "user"]);
  assert.equal(JSON.stringify(listedAlice).includes("alice-secret"), false);
  assert.equal(JSON.stringify(listedAlice).includes("admin-user-secret"), false);
  const storedAfterSet = await readTreeText(home);
  assert.match(storedAfterSet, /encryptedValue/);
  assert.equal(storedAfterSet.includes("global-secret"), false);
  assert.equal(storedAfterSet.includes("admin-user-secret"), false);
  assert.equal(storedAfterSet.includes("alice-secret"), false);

  const resolved = await resolveSecureSecretValue("openai/api-key", { ownerUserId: "alice", usedBy: "test-connector" }, env);
  assert.equal(resolved.value, "alice-secret");
  assert.equal(resolved.secret.managedBy, "user");
  assert.ok(resolved.secret.lastUsedAt);
  assert.deepEqual(resolved.secret.usedBy, ["test-connector"]);
  const storedAfterResolve = await readTreeText(home);
  assert.equal(storedAfterResolve.includes("alice-secret"), false);

  await deleteSecureSecret({ scope: "user", ownerUserId: "alice", name: "openai/api-key" }, alice, env);
  const fallback = await resolveSecureSecretValue("openai/api-key", { ownerUserId: "alice" }, env);
  assert.equal(fallback.value, "admin-user-secret");
  assert.equal(fallback.secret.managedBy, "admin");

  await deleteSecureSecret({ scope: "user", ownerUserId: "alice", name: "openai/api-key" }, admin, env);
  const globalFallback = await resolveSecureSecretValue("openai/api-key", { ownerUserId: "alice" }, env);
  assert.equal(globalFallback.value, "global-secret");
  assert.equal(globalFallback.secret.scope, "global");
});

test("secure secrets enforce user and global permissions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-secure-secret-policy-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const admin = adminPrincipal("admin");
  const alice = userPrincipal({ id: "alice", role: "user" });
  const bob = userPrincipal({ id: "bob", role: "user" });

  await setSecureSecret({ scope: "user", name: "github/token", value: "alice-token" }, alice, env);
  await setSecureSecret({ scope: "user", ownerUserId: "alice", name: "github/token", value: "admin-token" }, admin, env);

  await assert.rejects(
    () => listSecureSecrets({ scope: "user", ownerUserId: "alice" }, bob, env),
    /secret\.list_forbidden/,
  );
  await assert.rejects(
    () => setSecureSecret({ scope: "global", name: "github/token", value: "bob-global" }, bob, env),
    /secret\.write_global_forbidden/,
  );
  await assert.rejects(
    () => deleteSecureSecret({ scope: "user", ownerUserId: "alice", name: "github/token" }, bob, env),
    /secret\.delete_forbidden/,
  );

  const ownDeleted = await deleteSecureSecret({ scope: "user", name: "github/token" }, alice, env);
  assert.equal(ownDeleted.secret.managedBy, "user");
  await assert.rejects(
    () => deleteSecureSecret({ scope: "user", name: "github/token" }, alice, env),
    /secret_not_found/,
  );
});

test("secure secret connector resolution creates metadata-only missing requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-secure-secret-requests-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const admin = adminPrincipal("admin");
  const alice = userPrincipal({ id: "alice", role: "user" });

  const missing = await resolveSecureSecretReference("secret://user/openai/api-key", {
    ownerUserId: "alice",
    connector: "openai",
    threadId: "thread-alice",
    chatId: "chat-alice",
  }, env);
  assert.equal(missing.missing, true);
  assert.equal(missing.value, null);
  assert.equal(missing.request.handle, "secret://user/alice/openai/api-key");
  assert.equal(missing.request.status, "missing");
  assert.equal(Object.prototype.hasOwnProperty.call(missing.request, "value"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(missing.request, "secret"), false);

  const listedRequests = await listSecureInputRequests({ scope: "user", ownerUserId: "alice" }, alice, env);
  assert.equal(listedRequests.requests.length, 1);
  assert.equal(listedRequests.requests[0].handle, "secret://user/alice/openai/api-key");

  const listedSecrets = await listSecureSecrets({ scope: "user", ownerUserId: "alice" }, alice, env);
  assert.equal(listedSecrets.secrets.length, 1);
  assert.equal(listedSecrets.secrets[0].configured, false);
  assert.equal(listedSecrets.secrets[0].status, "missing");

  await setSecureSecret({ scope: "user", ownerUserId: "alice", name: "openai/api-key", value: "alice-secret-value" }, admin, env);
  const resolved = await resolveSecureSecretReference("secret://user/alice/openai/api-key", {
    ownerUserId: "alice",
    connector: "openai",
  }, env);
  assert.equal(resolved.value, "alice-secret-value");

  const afterSet = await listSecureSecrets({ scope: "user", ownerUserId: "alice" }, alice, env);
  assert.equal(afterSet.secrets.length, 1);
  assert.equal(afterSet.secrets[0].configured, true);
  assert.equal(afterSet.secrets[0].status, "configured");
  assert.equal(JSON.stringify(afterSet).includes("alice-secret-value"), false);

  const tree = await readTreeText(home);
  assert.equal(tree.includes("alice-secret-value"), false);
  const events = await listEvents(env, 20);
  assert.equal(JSON.stringify(events).includes("alice-secret-value"), false);
  assert.match(JSON.stringify(events), /secure_input_requested/);
});

test("secure secret handles do not allow cross-user resolution by default", async () => {
  assert.deepEqual(parseSecureSecretReference("secret://user/alice/gmail/client-secret").ownerUserId, "alice");
  assert.throws(
    () => parseSecureSecretReference("secret://user/bob/gmail/client-secret", { ownerUserId: "alice" }),
    /secure_secret_owner_mismatch/,
  );
});

test("secure secret handles normalize names without exposing values", () => {
  assert.equal(secureSecretHandleFor("OpenAI API Key", { scope: "global" }), "secret://global/openai-api-key");
  assert.equal(secureSecretHandleFor("gmail/client secret", { ownerUserId: "Alice Example" }), "secret://user/alice-example/gmail/client-secret");
});
