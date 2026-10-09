import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { userPrincipal } from "../packages/core/src/principal.js";
import { revokeSecretLink } from "../packages/core/src/secret-links.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { createVaultReceiveLink, submitVaultReceiveLink } from "../packages/core/src/vault-receive-links.js";
import { openRecord, readVault } from "../packages/core/src/vault-store.js";
import { jsonPost, pairedCookie, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

// Synthetic values only. The browser side is exercised by running the real
// page script against Node's WebCrypto.

const alice = userPrincipal({ id: "alice", role: "user" });

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

/** Node counterpart of the page's encryption, for direct core calls. */
function encryptFor(publicKey, value, username = "") {
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
  const raw = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", raw, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify({ u: username, p: value })), cipher.final(), cipher.getAuthTag()]);
  const wk = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, raw);
  return { v: 1, alg: "RSA-OAEP-256+A256GCM", wk: wk.toString("base64url"), iv: iv.toString("base64url"), ct: ct.toString("base64url") };
}

async function publicKeyOf(created) {
  const store = JSON.parse(await fs.readFile(path.join(process.env.ORKESTR_HOME, "secrets", "secret-links.json"), "utf8"));
  return store.links.find((link) => link.id === created.link.id).publicKey;
}

/** Runs the page's inline script with a fake DOM; returns what it posted. */
async function submitInPage(server, url, values) {
  const pathname = new URL(url).pathname;
  const page = await rawRequest(server.port, { pathname });
  assert.equal(page.status, 200, page.text);
  const script = page.text.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const dataKey = page.text.match(/data-key="([^"]+)"/)[1];
  const elements = {};
  const element = (id) => (elements[id] ||= { id, value: values[id] || "", hidden: false, disabled: false, textContent: "", listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, getAttribute: () => dataKey });
  const posted = [];
  const scope = {
    document: { getElementById: element },
    location: { pathname },
    window: { crypto: globalThis.crypto },
    fetch: async (target, options) => {
      const body = options.body.toString();
      posted.push(body);
      const response = await rawRequest(server.port, {
        method: "POST",
        pathname: target,
        headers: { origin: server.origin, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      return { ok: response.status === 200, status: response.status };
    },
  };
  new Function(...Object.keys(scope), script)(...Object.values(scope));
  await elements.receive.listeners.submit({ preventDefault() {} });
  return { status: elements.status.textContent, posted, page };
}

test("receive: outsider page encrypts in the browser and the item lands in the owner's vault only", async (t) => {
  const server = await fixture(t);
  await createThread({ id: "alice-thread", name: "Alice thread", ownerUserId: "alice" }, process.env);
  const value = "synthetic-received-password-73b1";
  const cookie = await pairedCookie({ userId: "alice", role: "user" });
  const created = await jsonPost(server.port, "/api/secret-links/e2e-request", { name: "Example Portal", threadId: "alice-thread", once: true, ttl: "1d" }, { cookie });
  assert.equal(created.status, 201, created.text);
  assert.match(created.json.url, /\/s\/r\/[A-Za-z0-9_-]{43}$/);
  assert.equal(created.json.link.kind, "e2e-request");
  assert.equal(created.json.link.once, true);

  const result = await submitInPage(server, created.json.url, { username: "synthetic-user", password: value });
  assert.match(result.status, /^Sent/, result.status);
  assert.match(result.page.headers["content-security-policy"], /default-src 'none'.*connect-src 'self'/);
  assert.match(result.page.headers["cache-control"], /no-store/);
  assert.equal(result.posted.join("").includes(value), false);
  assert.equal(result.posted.join("").includes("synthetic-user"), false);

  const store = await readVault("alice");
  assert.equal(store.items.length, 1);
  const [item] = store.items;
  assert.equal(item.name, "Example Portal");
  assert.equal(item.singleUse, true);
  assert.deepEqual(item.threadGrants.map((grant) => grant.threadId), ["alice-thread"]);
  const payload = await openRecord("alice", item);
  assert.equal(payload.password, value);
  assert.equal(payload.username, "synthetic-user");
  assert.equal((await readVault("admin")).items.length, 0);
  assert.equal((await readVault("bob")).items.length, 0);

  assert.equal((await rawRequest(server.port, { pathname: new URL(created.json.url).pathname })).status, 404);
  const list = await rawRequest(server.port, { pathname: "/api/secret-links", headers: { cookie } });
  const link = list.json.links.find((entry) => entry.id === created.json.link.id);
  assert.equal(link.status, "used");
  assert.equal(link.itemId, item.id);

  const messages = await listThreadMessages("alice-thread", process.env);
  const note = messages.find((message) => message.source === "vault_receive");
  assert.ok(note, "record-only thread note");
  assert.match(note.text, new RegExp(item.id));
  assert.equal(JSON.stringify(messages).includes(value), false);
  for (const needle of [value, tokenOf(created.json.url)]) {
    assert.deepEqual(await filesContaining(server.home, needle), [], `found ${needle.slice(0, 8)}`);
  }
  assert.equal((await fs.readFile(path.join(server.home, "secrets", "secret-links.json"), "utf8")).includes("encryptedValue"), false);
});

test("receive: the private key is never stored in clear", async (t) => {
  const server = await fixture(t);
  const created = await createVaultReceiveLink({ name: "Example" }, alice);
  const raw = await fs.readFile(path.join(server.home, "secrets", "secret-links.json"), "utf8");
  const link = JSON.parse(raw).links.find((entry) => entry.id === created.link.id);
  assert.doesNotMatch(raw, /PRIVATE KEY/);
  const sealed = JSON.parse(link.encryptedValue);
  assert.deepEqual(Object.keys(sealed).sort(), ["alg", "keyId", "payload", "v", "wrappedKey"]);
  assert.equal(JSON.stringify(created).includes(link.encryptedValue), false);
  // The served public key alone cannot open the record.
  assert.equal(crypto.createPublicKey({ key: Buffer.from(link.publicKey, "base64url"), format: "der", type: "spki" }).asymmetricKeyDetails.modulusLength, 3072);
});

test("receive: concurrent submissions store exactly one item", async (t) => {
  await fixture(t);
  const created = await createVaultReceiveLink({ name: "Race" }, alice);
  const publicKey = await publicKeyOf(created);
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => submitVaultReceiveLink(tokenOf(created.url), encryptFor(publicKey, `synthetic-race-${index}`))));
  assert.equal(results.filter((result) => result.state === "submitted").length, 1);
  assert.equal(results.filter((result) => result.state === "unknown").length, 5);
  assert.equal((await readVault("alice")).items.length, 1);
});

test("receive: garbage, wrong-key and oversized envelopes do not consume the link; revoke and expiry end it", async (t) => {
  const server = await fixture(t);
  const created = await createVaultReceiveLink({ name: "Shape" }, alice);
  const token = tokenOf(created.url);
  const publicKey = await publicKeyOf(created);
  const otherKey = (await publicKeyOf(await createVaultReceiveLink({ name: "Other" }, alice)));
  assert.equal((await submitVaultReceiveLink(token, { value: "synthetic-plaintext" })).state, "invalid");
  assert.equal((await submitVaultReceiveLink(token, encryptFor(otherKey, "synthetic-wrong-key"))).state, "invalid");
  await assert.rejects(submitVaultReceiveLink(token, encryptFor(publicKey, "x".repeat(16 * 1024 + 1))), /secret_value_too_large/);
  const crossSite = await rawRequest(server.port, { method: "POST", pathname: `/s/r/${token}/submit`, headers: { origin: "https://attacker.example.com", "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  assert.equal((await submitVaultReceiveLink(token, encryptFor(publicKey, "synthetic-ok"))).state, "submitted");
  assert.equal((await readVault("alice")).items[0].singleUse, undefined);

  const revoked = await createVaultReceiveLink({ name: "Revoked" }, alice);
  await revokeSecretLink(revoked.link.id, alice);
  assert.equal((await rawRequest(server.port, { pathname: new URL(revoked.url).pathname })).status, 404);

  const expiring = await createVaultReceiveLink({ name: "Expiring", ttl: "1m" }, alice);
  const storePath = path.join(server.home, "secrets", "secret-links.json");
  const store = JSON.parse(await fs.readFile(storePath, "utf8"));
  store.links.find((link) => link.id === expiring.link.id).expiresAt = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(storePath, JSON.stringify(store));
  assert.equal((await submitVaultReceiveLink(tokenOf(expiring.url), encryptFor(await publicKeyOf(expiring).catch(() => publicKey), "synthetic-late"))).state, "unknown");
  assert.equal((await readVault("alice")).items.length, 1);
});
