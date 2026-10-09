import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import { vaultOwnerFromRequest } from "../packages/core/src/vault-access.js";
import { agentListItems, agentReadSecret, agentRequestTotp, decideVaultApproval, listVaultApprovals } from "../packages/core/src/vault-agent.js";
import {
  createVaultItem,
  deleteVaultItem,
  exportTotpSecret,
  importVault,
  listVaultItems,
  ownerTotpCode,
  revealVaultItem,
  setVaultGrants,
  updateVaultItem,
  vaultStatus,
} from "../packages/core/src/vault-service.js";
import { mutateVault } from "../packages/core/src/vault-store.js";

// Synthetic users, threads and values only.

const PASSWORD = "synthetic-vault-password-4c1e";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const managed = ["ORKESTR_HOME", "ORKESTR_VAULT_AGENT_READ_LIMIT", "ORKESTR_VAULT_AGENT_TOTP_LIMIT", "ORKESTR_VAULT_OWNER_REVEAL_LIMIT"];
let home;

test.before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-vault-access-"));
  process.env.ORKESTR_HOME = home;
  await createThread({ id: "alice-thread", name: "Alice worker", ownerUserId: "alice" }, process.env);
  await createThread({ id: "alice-other", name: "Alice other", ownerUserId: "alice" }, process.env);
  await createThread({ id: "bob-thread", name: "Bob worker", ownerUserId: "bob" }, process.env);
});

test.after(async () => {
  for (const key of managed) delete process.env[key];
  await fs.rm(home, { recursive: true, force: true });
});

function owner(id, { role = "user", authAgeMs = 0 } = {}) {
  return { ...userPrincipal({ id, role }), vaultOwner: true, authenticatedAt: new Date(Date.now() - authAgeMs).toISOString() };
}

async function treeText(root) {
  let text = "";
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    text += entry.isDirectory() ? await treeText(full) : await fs.readFile(full, "utf8").catch(() => "");
  }
  return text;
}

test("owner principal requires a real, unscoped browser session", () => {
  const principal = userPrincipal({ id: "alice" });
  const session = { id: "sess_1" };
  assert.equal(vaultOwnerFromRequest({ orkestrPrincipal: principal, orkestrSecuritySession: session }).vaultOwner, true);
  for (const request of [
    { orkestrPrincipal: principal, orkestrSecuritySession: session, orkestrAnonymous: true },
    { orkestrPrincipal: principal, orkestrSecuritySession: session, orkestrMachineAuth: "cli" },
    { orkestrPrincipal: principal, orkestrSecuritySession: null },
    { orkestrPrincipal: principal, orkestrSecuritySession: { id: "s", shareId: "share" } },
    { orkestrPrincipal: principal, orkestrSecuritySession: { id: "s", authIntent: { kind: "x" } } },
    { orkestrPrincipal: principal, orkestrSecuritySession: { id: "s", allowedActions: ["desktop:view"] } },
    { orkestrPrincipal: { kind: "system", userId: "system", role: "admin" }, orkestrSecuritySession: session },
  ]) {
    assert.equal(vaultOwnerFromRequest(request), null);
  }
});

test("owner CRUD keeps secrets encrypted and events value-free; vaults are per user", async () => {
  const alice = owner("alice");
  const created = await createVaultItem(alice, { name: "Example Mail", url: "https://www.Mail.Example.com/login", username: "alice@example.com", password: PASSWORD, notes: "synthetic note", tags: ["Work"], totpSecret: TOTP_SECRET });
  assert.match(created.item.id, /^vi_/);
  assert.equal(created.item.domain, "mail.example.com");
  assert.equal(created.item.username, "alice@example.com");
  assert.equal(created.item.hasPassword, true);
  assert.equal(created.item.hasTotp, true);
  assert.equal(JSON.stringify(created).includes(PASSWORD), false);
  const vaultFile = await fs.readFile(path.join(home, "users", "alice", "secrets", "vault.json"), "utf8");
  for (const value of [PASSWORD, "alice@example.com", "synthetic note", TOTP_SECRET]) assert.equal(vaultFile.includes(value), false, value);
  assert.equal((await fs.stat(path.join(home, "users", "alice", "secrets", "vault.json"))).mode & 0o777, 0o600);

  const updated = await updateVaultItem(alice, created.item.id, { password: "" });
  assert.equal(updated.item.hasPassword, false);
  await updateVaultItem(alice, created.item.id, { password: PASSWORD });
  assert.equal((await listVaultItems(owner("bob"))).items.length, 0, "bob sees only his own vault");
  await assert.rejects(updateVaultItem(owner("bob"), created.item.id, { name: "x" }), /vault_item_not_found/);
  const status = await vaultStatus(owner("admin", { role: "admin" }), { userId: "alice" });
  assert.equal(status.itemCount, 1);
  assert.equal(status.totpCount, 1);
  assert.equal(Object.keys(status).includes("items"), false);
  assert.equal((await vaultStatus(owner("bob"), { userId: "alice" })).itemCount, 0, "non-admins only see their own counts");
  await assert.rejects(listVaultItems(adminPrincipal("admin")), /vault_owner_session_required/);
  await assert.rejects(listVaultItems(userPrincipal({ id: "alice" })), /vault_owner_session_required/);

  const removable = await createVaultItem(alice, { name: "Temp", password: "temp-synthetic" });
  assert.deepEqual(await deleteVaultItem(alice, removable.item.id), { ok: true });
  assert.equal((await listVaultItems(alice)).items.length, 1);
  await assert.rejects(createVaultItem(alice, { name: 5 }), /vault_field_invalid/);
});

test("reveal and TOTP secret export require a recent sign-in", async () => {
  const [item] = (await listVaultItems(owner("alice"))).items;
  await assert.rejects(revealVaultItem(owner("alice", { authAgeMs: 16 * 60_000 }), item.id), (error) => error.message === "vault_reauth_required" && error.statusCode === 401);
  await assert.rejects(exportTotpSecret(owner("alice", { authAgeMs: 16 * 60_000 }), item.id), /vault_reauth_required/);
  const revealed = await revealVaultItem(owner("alice"), item.id);
  assert.deepEqual(revealed, { password: PASSWORD, notes: "synthetic note" });
  const exported = await exportTotpSecret(owner("alice"), item.id);
  assert.match(exported.otpauthUri, /^otpauth:\/\/totp\/.*secret=JBSWY3DPEHPK3PXP/);
  const code = await ownerTotpCode(owner("alice", { authAgeMs: 60 * 60_000 }), item.id);
  assert.match(code.code, /^\d{6}$/);
  assert.equal(code.period, 30);
  assert.ok(code.expiresInSeconds >= 1 && code.expiresInSeconds <= 30);
});

test("grants: only the owner's threads; agents see and read only granted items", async () => {
  const alice = owner("alice");
  const [item] = (await listVaultItems(alice)).items;
  await assert.rejects(setVaultGrants(alice, item.id, ["bob-thread"]), /vault_grant_thread_invalid/);
  await assert.rejects(setVaultGrants(alice, item.id, ["missing-thread"]), /vault_grant_thread_invalid/);
  await assert.rejects(agentReadSecret("alice-thread", item.id, ["password"]), /vault_item_not_found/);
  assert.deepEqual((await agentListItems("alice-thread")).items, []);

  const granted = await setVaultGrants(alice, item.id, ["alice-thread"]);
  assert.deepEqual(granted.item.threadGrants, [{ threadId: "alice-thread" }]);
  const listed = await agentListItems("alice-thread");
  assert.equal(listed.items.length, 1);
  assert.equal(JSON.stringify(listed).includes("alice@example.com"), false, "agent list is metadata only");
  await assert.rejects(agentReadSecret("alice-other", item.id, ["password"]), /vault_item_not_found/);
  await assert.rejects(agentReadSecret("bob-thread", item.id, ["password"]), /vault_item_not_found/);
  await assert.rejects(agentReadSecret("unknown-thread", item.id, ["password"]), /vault_agent_thread_unknown/);
  await assert.rejects(agentReadSecret("alice-thread", item.id, ["notes"]), /vault_field_invalid/);

  const read = await agentReadSecret("alice-thread", "example mail", ["username", "password"]);
  assert.deepEqual(read, { itemId: item.id, username: "alice@example.com", password: PASSWORD });
  const events = await fs.readFile(path.join(home, "events.jsonl"), "utf8").catch(async () => treeText(home));
  assert.match(events, /"type":"vault_secret_read"[^\n]*"field":"password"[^\n]*"principalKind":"agent"/);
  const after = (await listVaultItems(alice)).items[0];
  assert.ok(after.lastUsedAt);
});

test("TOTP approval flow: pending, approve, exactly one code, deny, expiry", async () => {
  const alice = owner("alice");
  const [item] = (await listVaultItems(alice)).items;
  const first = await agentRequestTotp("alice-thread", item.id);
  assert.equal(first.status, "pending");
  assert.match(first.approval.id, /^vap_/);
  assert.equal(first.code, undefined);
  const again = await agentRequestTotp("alice-thread", item.id);
  assert.equal(again.approval.id, first.approval.id, "an unexpired pending approval is reused");
  const listed = await listVaultApprovals(alice);
  assert.equal(listed.approvals[0].itemName, "Example Mail");
  assert.equal(listed.approvals[0].threadName, "Alice worker");
  assert.equal((await listVaultApprovals(owner("bob"))).approvals.length, 0);
  await assert.rejects(decideVaultApproval(owner("bob"), first.approval.id, "approve"), /vault_approval_not_found/);

  const approved = await decideVaultApproval(alice, first.approval.id, "approve");
  assert.equal(approved.approval.status, "approved");
  await assert.rejects(decideVaultApproval(alice, first.approval.id, "deny"), /vault_approval_not_pending/);
  const issued = await agentRequestTotp("alice-thread", item.id, { approvalId: first.approval.id });
  assert.equal(issued.status, "issued");
  assert.match(issued.code, /^\d{6}$/);
  const reused = await agentRequestTotp("alice-thread", item.id, { approvalId: first.approval.id });
  assert.equal(reused.status, "consumed");
  assert.equal(reused.code, undefined);
  const next = await agentRequestTotp("alice-thread", item.id);
  assert.equal(next.status, "pending");
  assert.notEqual(next.approval.id, first.approval.id);

  await decideVaultApproval(alice, next.approval.id, "deny");
  const denied = await agentRequestTotp("alice-thread", item.id, { approvalId: next.approval.id });
  assert.equal(denied.status, "denied");
  assert.equal(denied.code, undefined);

  const third = await agentRequestTotp("alice-thread", item.id);
  await mutateVault("alice", (store) => {
    store.approvals.find((approval) => approval.id === third.approval.id).expiresAt = new Date(Date.now() - 1000).toISOString();
  });
  assert.equal((await agentRequestTotp("alice-thread", item.id, { approvalId: third.approval.id })).status, "expired");
  await assert.rejects(decideVaultApproval(alice, third.approval.id, "approve"), /vault_approval_expired/);
  await assert.rejects(agentRequestTotp("alice-other", item.id), /vault_item_not_found/);

  const events = await treeText(home);
  for (const type of ["vault_totp_requested", "vault_totp_approved", "vault_totp_denied", "vault_totp_issued"]) assert.match(events, new RegExp(`"type":"${type}"`));
  assert.equal(events.includes(issued.code) && events.includes(`"code":"${issued.code}"`), false);
});

test("HOTP codes advance only on explicit requests, never on the automatic read", async () => {
  const alice = owner("alice");
  const { item } = await createVaultItem(alice, { name: "Counter", totpUri: `otpauth://hotp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=0` });
  assert.equal(item.totpType, "hotp");
  // The page's automatic refresh (POST without advance) must never use up a counter code.
  await assert.rejects(() => ownerTotpCode(alice, item.id), { statusCode: 409 });
  await assert.rejects(() => ownerTotpCode(alice, item.id), { statusCode: 409 });
  const advance = { advance: true };
  assert.equal((await ownerTotpCode(alice, item.id, process.env, advance)).code, "755224");
  assert.equal((await ownerTotpCode(alice, item.id, process.env, advance)).code, "287082");
  assert.equal((await ownerTotpCode(alice, item.id, process.env, advance)).code, "359152");
  await deleteVaultItem(alice, item.id);
});

test("rate limits for agent reads, TOTP requests and owner reveals", async () => {
  process.env.ORKESTR_VAULT_AGENT_READ_LIMIT = "2";
  process.env.ORKESTR_VAULT_AGENT_TOTP_LIMIT = "1";
  process.env.ORKESTR_VAULT_OWNER_REVEAL_LIMIT = "1";
  const alice = owner("alice");
  const { item } = await createVaultItem(alice, { name: "Limited", password: "limited-synthetic", totpSecret: TOTP_SECRET });
  await setVaultGrants(alice, item.id, ["alice-other"]);
  await agentReadSecret("alice-other", item.id, ["password"]);
  await agentReadSecret("alice-other", item.id, ["password"]);
  await assert.rejects(agentReadSecret("alice-other", item.id, ["password"]), (error) => error.message === "vault_rate_limited" && error.statusCode === 429);
  const pending = await agentRequestTotp("alice-other", item.id);
  await decideVaultApproval(alice, pending.approval.id, "deny");
  await assert.rejects(agentRequestTotp("alice-other", item.id), /vault_rate_limited/);
  const carol = owner("carol");
  const own = await createVaultItem(carol, { name: "Carol", password: "carol-synthetic", totpSecret: TOTP_SECRET });
  await revealVaultItem(carol, own.item.id);
  await assert.rejects(revealVaultItem(carol, own.item.id), /vault_rate_limited/);
  await assert.rejects(exportTotpSecret(carol, own.item.id), /vault_rate_limited/);
  for (const key of managed.slice(1)) delete process.env[key];
});

test("imports through the service attach TOTP only when asked; no values in events or errors", async () => {
  const bob = owner("bob");
  await createVaultItem(bob, { name: "Example", url: "https://example.com", password: "bob-synthetic-pw" });
  const uri = `otpauth://totp/Example:bob?secret=${TOTP_SECRET}&issuer=Example`;
  const separate = await importVault(bob, { format: "otpauth", content: uri });
  assert.deepEqual(separate, { imported: 1, skipped: 0, withTotp: 1, reasons: [] });
  assert.equal((await listVaultItems(bob)).items.length, 2);
  const attached = await importVault(bob, { format: "otpauth", content: uri, attachToExisting: true });
  assert.equal(attached.imported, 1);
  const items = (await listVaultItems(bob)).items;
  assert.equal(items.length, 2);
  assert.ok(items.every((entry) => entry.hasTotp));
  const csv = await importVault(bob, { format: "chrome", content: "name,url,username,password,note\nsite,https://site.example.com,bob,csv-synthetic-pw,\n,,,,\n" });
  assert.equal(csv.imported, 1);
  const errors = [];
  for (const attempt of [
    () => createVaultItem(bob, { name: "x", totpSecret: "!!bad-synthetic!!" }),
    () => importVault(bob, { format: "bitwarden", content: "name,secret-synthetic-header\n" }),
    () => revealVaultItem(owner("bob", { authAgeMs: 3_600_000 }), items[0].id),
  ]) {
    await attempt().catch((error) => errors.push(error.message));
  }
  assert.equal(errors.length, 3);
  for (const message of errors) assert.match(message, /^vault_[a-z_]+$/);
  const everything = await treeText(home);
  const events = everything.split("\n").filter((line) => line.includes("\"type\":\"vault_")).join("\n");
  assert.ok(events.includes("vault_imported"));
  for (const value of [PASSWORD, "bob-synthetic-pw", "csv-synthetic-pw", "limited-synthetic", TOTP_SECRET, "alice@example.com"]) {
    assert.equal(events.includes(value), false, `event leaked ${value}`);
  }
});
