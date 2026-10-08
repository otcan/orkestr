import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadVaultKey, openItemPayload, sealItemPayload, vaultKeyStatus } from "../packages/core/src/vault-crypto.js";
import { parseCsv } from "../packages/core/src/vault-csv.js";
import { planVaultImport } from "../packages/core/src/vault-import.js";

// Synthetic values only.

async function tempEnv(t, extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-vault-crypto-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { ORKESTR_HOME: home, ...extra };
}

test("envelope round-trips and is bound to owner and item via AAD", async (t) => {
  const env = await tempEnv(t);
  const payload = { username: "alice@example.com", password: "synthetic-pass-1", notes: "n" };
  const sealed = await sealItemPayload(payload, "alice", "vi_one", env);
  assert.equal(sealed.v, 1);
  assert.equal(sealed.alg, "aes-256-gcm");
  assert.match(sealed.keyId, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(sealed).includes("synthetic-pass-1"), false);
  assert.deepEqual(await openItemPayload(sealed, "alice", "vi_one", env), payload);
  await assert.rejects(openItemPayload(sealed, "bob", "vi_one", env), /^Error: vault_item_decrypt_failed$/);
  await assert.rejects(openItemPayload(sealed, "alice", "vi_two", env), /vault_item_decrypt_failed/);
  const other = await sealItemPayload({ password: "synthetic-pass-2" }, "alice", "vi_two", env);
  const swappedPayload = { ...other, payload: sealed.payload };
  await assert.rejects(openItemPayload(swappedPayload, "alice", "vi_two", env), /vault_item_decrypt_failed/);
  const swappedKey = { ...sealed, wrappedKey: other.wrappedKey };
  await assert.rejects(openItemPayload(swappedKey, "alice", "vi_one", env), /vault_item_decrypt_failed/);
  const tampered = { ...sealed, payload: { ...sealed.payload, tag: other.payload.tag } };
  await assert.rejects(openItemPayload(tampered, "alice", "vi_one", env), /vault_item_decrypt_failed/);
});

test("vault key file is created once with mode 0600 and reused", async (t) => {
  const env = await tempEnv(t);
  const first = await loadVaultKey(env);
  assert.equal(first.source, "file");
  const keyPath = path.join(env.ORKESTR_HOME, "secrets", "vault.key");
  const stat = await fs.stat(keyPath);
  assert.equal(stat.mode & 0o777, 0o600);
  const second = await loadVaultKey(env);
  assert.deepEqual(second.key, first.key);
  assert.deepEqual(await vaultKeyStatus(env), { keySource: "file", keyFilePresent: true });
  const secureInputKey = path.join(env.ORKESTR_HOME, "secrets", "secure-input.key");
  assert.equal(await fs.stat(secureInputKey).then(() => true, () => false), false);
});

test("vault key fails closed when the key file is corrupt or unreadable", async (t) => {
  const env = await tempEnv(t);
  const sealed = await sealItemPayload({ password: "synthetic" }, "alice", "vi_one", env);
  const keyPath = path.join(env.ORKESTR_HOME, "secrets", "vault.key");
  const original = await fs.readFile(keyPath, "utf8");
  await fs.writeFile(keyPath, "not-a-key\n");
  await assert.rejects(loadVaultKey(env), /vault_key_invalid/);
  assert.equal(await fs.readFile(keyPath, "utf8"), "not-a-key\n", "a corrupt key file is never regenerated");
  await fs.rm(keyPath);
  await fs.mkdir(keyPath);
  await assert.rejects(loadVaultKey(env), /vault_key_unavailable/);
  await fs.rmdir(keyPath);
  await fs.writeFile(keyPath, original, { mode: 0o600 });
  assert.deepEqual(await openItemPayload(sealed, "alice", "vi_one", env), { password: "synthetic" });
});

test("ORKESTR_VAULT_KEY is used when set and must be 32 bytes", async (t) => {
  const key = randomBytes(32);
  const env = await tempEnv(t, { ORKESTR_VAULT_KEY: key.toString("base64") });
  const loaded = await loadVaultKey(env);
  assert.equal(loaded.source, "env");
  assert.deepEqual(loaded.key, key);
  assert.equal((await vaultKeyStatus(env)).keySource, "env");
  assert.equal((await vaultKeyStatus(env)).keyFilePresent, false);
  const sealed = await sealItemPayload({ password: "x" }, "alice", "vi_1", env);
  await assert.rejects(openItemPayload(sealed, "alice", "vi_1", { ...env, ORKESTR_VAULT_KEY: randomBytes(32).toString("base64") }), /vault_item_decrypt_failed/);
  await assert.rejects(loadVaultKey({ ...env, ORKESTR_VAULT_KEY: randomBytes(16).toString("base64") }), (error) => error.message === "vault_key_invalid");
});

test("CSV parser handles quotes, embedded commas/newlines, CRLF and BOM", () => {
  const rows = parseCsv("﻿a,b,c\r\n\"x, y\",\"line1\nline2\",\"say \"\"hi\"\"\"\r\n,,\nlast,row,\"\"\n");
  assert.deepEqual(rows, [["a", "b", "c"], ["x, y", "line1\nline2", "say \"hi\""], ["", "", ""], ["last", "row", ""]]);
  assert.throws(() => parseCsv("a,\"b\n"), /vault_import_csv_malformed/);
  assert.throws(() => parseCsv("a\n1\n2\n3", { maxRows: 2 }), /vault_import_too_many_rows/);
});

test("Bitwarden CSV import maps logins, TOTP and fields and skips non-logins", () => {
  const content = [
    "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
    "Work,1,login,Example Mail,\"note, with comma\",\"pin: 1234\",0,https://mail.example.com/login,alice@example.com,synthetic-pw-1,otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example",
    ",,login,Bare TOTP,,,0,https://www.example.org,bob,synthetic-pw-2,JBSWY3DPEHPK3PXP",
    ",,note,Secure note,secret text,,0,,,,",
    ",,login,Bad TOTP,,,0,https://bad.example.net,carol,synthetic-pw-3,!!notbase32",
    ",,login,,,,0,,,,",
  ].join("\n");
  const plan = planVaultImport({ format: "auto", content });
  assert.equal(plan.format, "bitwarden");
  assert.equal(plan.entries.length, 3);
  const [mail, bare, bad] = plan.entries;
  assert.equal(mail.input.name, "Example Mail");
  assert.equal(mail.input.url, "https://mail.example.com/login");
  assert.equal(mail.input.notes, "note, with comma");
  assert.deepEqual(mail.input.fields, [{ name: "pin", value: "1234" }]);
  assert.deepEqual(mail.input.tags, ["Work"]);
  assert.equal(mail.input.totp.issuer, "Example");
  assert.equal(bare.input.totp.secret, "JBSWY3DPEHPK3PXP");
  assert.equal(bad.input.totp, undefined);
  assert.deepEqual(plan.reasons.map(({ row, reason }) => [row, reason]), [[4, "unsupported_item_type"], [5, "totp_invalid_ignored"], [6, "missing_name_and_url"]]);
  assert.equal(JSON.stringify(plan.reasons).includes("synthetic"), false);
});

test("1Password CSV import accepts header variants and OTPAuth", () => {
  const content = "Title,Website,Username,Password,OTPAuth,Notes\n\"Example, Inc\",example.com,dave,\"pw,with\"\"quote\",otpauth://totp/Ex:dave?secret=JBSWY3DPEHPK3PXP,\"multi\nline\"\n";
  const plan = planVaultImport({ format: "auto", content });
  assert.equal(plan.format, "1password");
  assert.equal(plan.entries[0].input.name, "Example, Inc");
  assert.equal(plan.entries[0].input.password, "pw,with\"quote");
  assert.equal(plan.entries[0].input.notes, "multi\nline");
  assert.equal(plan.entries[0].input.totp.accountName, "dave");
  const variant = planVaultImport({ format: "1password", content: "title,url,username,password,one-time password,notesPlain\nSite,https://site.example.com,erin,pw,,\n" });
  assert.equal(variant.entries[0].input.url, "https://site.example.com");
});

test("Chrome CSV import and format errors", () => {
  const plan = planVaultImport({ format: "auto", content: "name,url,username,password,note\nexample.com,https://example.com/,frank,synthetic-pw,\n,,,,\n" });
  assert.equal(plan.format, "chrome");
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].input.username, "frank");
  assert.throws(() => planVaultImport({ format: "auto", content: "foo,bar\n1,2\n" }), /vault_import_format_unknown/);
  assert.throws(() => planVaultImport({ format: "bitwarden", content: "name,url\nx,y\n" }), /vault_import_format_mismatch/);
  assert.throws(() => planVaultImport({ format: "nope", content: "x" }), /vault_import_format_unknown/);
  assert.throws(() => planVaultImport({ content: "x".repeat(2 * 1024 * 1024 + 1) }), /vault_import_too_large/);
  const many = `name,url,username,password\n${"a,https://a.example.com,u,p\n".repeat(5001)}`;
  assert.throws(() => planVaultImport({ content: many }), /vault_import_too_many_rows/);
});

test("otpauth import accepts URI lists and reports invalid lines without values", () => {
  const plan = planVaultImport({
    format: "auto",
    content: "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP\n\nnot-a-uri-synthetic\notpauth://totp/Other:bob?secret=JBSWY3DPEHPK3PXP&issuer=Other\n",
  });
  assert.equal(plan.format, "otpauth");
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries[1].input.name, "Other");
  assert.deepEqual(plan.reasons.map(({ row, reason }) => [row, reason]), [[2, "vault_otpauth_invalid"]]);
});

test("envelopes with a truncated GCM tag are rejected", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const crypto = await import("../packages/core/src/vault-crypto.js");
  const home = await mkdtemp(join(tmpdir(), "orkestr-vault-tag-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home };
  const envelope = await crypto.sealItemPayload({ password: "example-password" }, "alice", "vi_example", env);
  const truncated = structuredClone(envelope);
  truncated.payload.tag = Buffer.from(envelope.payload.tag, "base64url").subarray(0, 4).toString("base64url");
  await assert.rejects(() => crypto.openItemPayload(truncated, "alice", "vi_example", env), { message: "vault_item_decrypt_failed" });
  assert.equal((await crypto.openItemPayload(envelope, "alice", "vi_example", env)).password, "example-password");
});
