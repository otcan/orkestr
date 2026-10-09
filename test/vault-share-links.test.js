import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { revokeSecretLink } from "../packages/core/src/secret-links.js";
import { decryptVaultShare, encryptVaultShare } from "../packages/core/src/vault-share-crypto.js";
import { createVaultShareLink, openVaultShareLink } from "../packages/core/src/vault-share-links.js";
import { jsonPost, pairedCookie, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

// Synthetic values only. Tests use the minimum PBKDF2 cost to stay fast.

const admin = adminPrincipal("admin");
const fast = { iterations: 100_000 };

async function fixture(t) {
  const server = await startFixtureServer({ ORKESTR_HOST_BOUNDARIES: "0" });
  t.after(() => server.close());
  return server;
}

function tokenOf(url) {
  return new URL(url).pathname.split("/").pop();
}

async function filesContaining(root, needle) {
  const hits = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if ((await fs.readFile(full)).includes(Buffer.from(needle))) hits.push(full);
    }
  }
  await walk(root);
  return hits;
}

function open(server, pathname, headers = { origin: server.origin }) {
  return rawRequest(server.port, { method: "POST", pathname: `${pathname}/open`, headers });
}

test("e2e share: server only sees ciphertext, public page needs no login, view-once", async (t) => {
  const server = await fixture(t);
  const value = "synthetic-e2e-share-value-5d21";
  const { envelope, key } = encryptVaultShare(value);
  const body = { envelope, label: "Example login", ttl: "1d", views: 1, name: "example-item" };
  assert.equal(JSON.stringify(body).includes(value), false);
  assert.equal(JSON.stringify(body).includes(key), false);
  const cookie = await pairedCookie({ userId: "admin", role: "admin" });
  const created = await jsonPost(server.port, "/api/secret-links/e2e", body, { cookie });
  assert.equal(created.status, 201, created.text);
  assert.match(created.json.url, /\/s\/e\/[A-Za-z0-9_-]{43}$/);
  assert.equal(created.json.link.kind, "e2e");
  const pathname = new URL(created.json.url).pathname;

  for (let index = 0; index < 2; index += 1) {
    const page = await rawRequest(server.port, { pathname });
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /Reveal/);
    assert.equal(page.text.includes(envelope.ct), false);
    assert.match(page.headers["content-security-policy"], /default-src 'none'.*connect-src 'self'/);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.match(page.headers["x-robots-tag"], /noindex/);
    assert.match(page.headers["cache-control"], /no-store/);
  }

  const crossSite = await open(server, pathname, { origin: "https://attacker.example.com", "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403);
  const opened = await open(server, pathname);
  assert.equal(opened.status, 200, opened.text);
  assert.match(opened.headers["cache-control"], /no-store/);
  assert.equal(decryptVaultShare(opened.json.envelope, key), value);

  const unknown = await rawRequest(server.port, { pathname: `/s/e/${"Z".repeat(43)}` });
  const used = await rawRequest(server.port, { pathname });
  assert.equal(used.status, 404);
  assert.equal(used.text.replace(/nonce="[^"]+"/g, ""), unknown.text.replace(/nonce="[^"]+"/g, ""));
  assert.equal((await open(server, pathname)).status, 404);

  const list = await rawRequest(server.port, { pathname: "/api/secret-links", headers: { cookie } });
  const link = list.json.links.find((item) => item.id === created.json.link.id);
  assert.equal(link.status, "used");
  assert.equal(link.views, 1);
  assert.ok(link.openedAt);
  for (const needle of [value, key, tokenOf(created.json.url), envelope.ct]) {
    assert.deepEqual(await filesContaining(server.home, needle), [], `found ${needle.slice(0, 8)}`);
  }
  assert.match(await fs.readFile(path.join(server.home, "events.jsonl"), "utf8"), /secret_link_opened/);
});

test("e2e share: max views hold under concurrent opens", async (t) => {
  await fixture(t);
  const { envelope } = encryptVaultShare("synthetic-race-e2e");
  const created = await createVaultShareLink({ envelope, views: 3 }, admin);
  const results = await Promise.all(Array.from({ length: 8 }, () => openVaultShareLink(tokenOf(created.url))));
  assert.equal(results.filter((result) => result.state === "opened").length, 3);
  assert.equal(results.filter((result) => result.state === "unknown").length, 5);
});

test("e2e share: passphrase is required and wrong passphrases fail", async (t) => {
  const server = await fixture(t);
  const value = "synthetic-passphrase-value";
  const { envelope, key } = encryptVaultShare(value, { passphrase: "example passphrase", ...fast });
  const created = await createVaultShareLink({ envelope, views: 2 }, admin);
  assert.equal(created.link.passphrase, true);
  const page = await rawRequest(server.port, { pathname: new URL(created.url).pathname });
  assert.match(page.text, /id="passphrase"/);
  const opened = await openVaultShareLink(tokenOf(created.url));
  assert.throws(() => decryptVaultShare(opened.envelope, key), /vault_share_passphrase_required/);
  assert.throws(() => decryptVaultShare(opened.envelope, key, "wrong passphrase"));
  assert.throws(() => decryptVaultShare(opened.envelope, encryptVaultShare("x").key, "example passphrase"));
  assert.equal(decryptVaultShare(opened.envelope, key, "example passphrase"), value);
});

test("e2e share: revoke and expiry end the link and purge the envelope", async (t) => {
  const server = await fixture(t);
  const revoked = await createVaultShareLink({ envelope: encryptVaultShare("synthetic-revoke").envelope }, admin);
  await revokeSecretLink(revoked.link.id, admin);
  assert.equal((await openVaultShareLink(tokenOf(revoked.url))).state, "unknown");

  const expiring = await createVaultShareLink({ envelope: encryptVaultShare("synthetic-expire").envelope, ttl: "1m" }, admin);
  const storePath = path.join(server.home, "secrets", "secret-links.json");
  const store = JSON.parse(await fs.readFile(storePath, "utf8"));
  store.links.find((link) => link.id === expiring.link.id).expiresAt = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(storePath, JSON.stringify(store));
  assert.equal((await rawRequest(server.port, { pathname: new URL(expiring.url).pathname })).status, 404);
  const after = JSON.parse(await fs.readFile(storePath, "utf8"));
  for (const link of after.links) assert.equal("encryptedValue" in link, false);
});

test("e2e share: plaintext bodies, malformed envelopes and bad view counts are refused", async (t) => {
  await fixture(t);
  const { envelope } = encryptVaultShare("synthetic-shape");
  await assert.rejects(createVaultShareLink({ envelope: { value: "synthetic-plaintext" } }, admin), /vault_share_envelope_invalid/);
  await assert.rejects(createVaultShareLink({ envelope: { ...envelope, iv: "short" } }, admin), /vault_share_envelope_invalid/);
  await assert.rejects(createVaultShareLink({ envelope: { ...envelope, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 10, salt: "A".repeat(22) } } }, admin), /vault_share_envelope_invalid/);
  await assert.rejects(createVaultShareLink({ envelope, views: 11 }, admin), /vault_share_views_invalid/);
  const stored = await createVaultShareLink({ envelope: { ...envelope, extra: "dropped" } }, admin);
  assert.equal((await openVaultShareLink(tokenOf(stored.url))).envelope.extra, undefined);
});

// Runs the recipient page's inline script against Node's WebCrypto with a
// minimal fake DOM, proving the browser derivation matches the CLI envelope.
async function revealInPage(server, url, key, passphrase = "") {
  const pathname = new URL(url).pathname;
  const page = await rawRequest(server.port, { pathname });
  const script = page.text.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const elements = {};
  const element = (id) => (elements[id] ||= { id, value: id === "passphrase" ? passphrase : "", hidden: false, textContent: "", listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, select() {} });
  if (!page.text.includes('id="passphrase"')) elements.passphrase = null;
  const sent = [];
  const scope = {
    document: { getElementById: (id) => (id in elements && elements[id] === null ? null : element(id)) },
    location: { hash: `#${key}`, pathname },
    history: { replaceState() {} },
    window: { crypto: globalThis.crypto },
    fetch: async (target, options) => {
      sent.push({ target, options });
      const response = await open(server, target.replace(/\/open$/, ""));
      return { ok: response.status === 200, json: async () => response.json };
    },
  };
  new Function(...Object.keys(scope), script)(...Object.values(scope));
  await elements.open.listeners.click();
  return { value: elements["secret-value"]?.value || "", status: elements.status.textContent, sent };
}

test("e2e share: the recipient page decrypts in the browser without sending the key", async (t) => {
  const server = await fixture(t);
  const plain = encryptVaultShare("synthetic-page-value");
  const created = await createVaultShareLink({ envelope: plain.envelope }, admin);
  const revealed = await revealInPage(server, created.url, plain.key);
  assert.equal(revealed.value, "synthetic-page-value", revealed.status);
  assert.equal(JSON.stringify(revealed.sent).includes(plain.key), false);

  const locked = encryptVaultShare("synthetic-page-locked", { passphrase: "example passphrase", ...fast });
  const lockedLink = await createVaultShareLink({ envelope: locked.envelope, views: 2 }, admin);
  const wrong = await revealInPage(server, lockedLink.url, locked.key, "wrong passphrase");
  assert.equal(wrong.value, "");
  assert.match(wrong.status, /Check the passphrase/);
  assert.equal((await revealInPage(server, lockedLink.url, locked.key, "example passphrase")).value, "synthetic-page-locked");
});
