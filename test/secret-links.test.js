import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import {
  createSecretRequestLink,
  createSecretShareLink,
  revealSecretShareLink,
} from "../packages/core/src/secret-links.js";
import { parseSecretLinkTtl } from "../packages/core/src/secret-links-store.js";
import { resolveSecureSecretReference, setSecureSecret } from "../packages/core/src/secure-secrets.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { jsonPost, pairedCookie, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

// Synthetic values only. Each test boots an isolated server/home so the
// per-client lookup throttle of one test cannot affect another.

const alice = userPrincipal({ id: "alice", role: "user" });
const admin = adminPrincipal("admin");

async function fixture(t, extraEnv = {}) {
  const server = await startFixtureServer({ ORKESTR_HOST_BOUNDARIES: "0", ...extraEnv });
  t.after(() => server.close());
  return server;
}

function linkPath(url) {
  return new URL(url).pathname;
}

function form(port, pathname, cookie, headers = {}, body = "") {
  return rawRequest(port, {
    method: "POST",
    pathname,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${port}`, ...headers },
    body,
  });
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

test("share link: GET never consumes, reveal works once, value never persisted in clear", async (t) => {
  const server = await fixture(t);
  const value = "synthetic-share-value-7f3a";
  const adminCookie = await pairedCookie({ userId: "admin", role: "admin" });
  const created = await jsonPost(server.port, "/api/secret-links/share", { value, label: "Example API key", ttl: "15m" }, { cookie: adminCookie });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.text.includes(value), false);
  assert.match(created.json.url, /\/s\/[A-Za-z0-9_-]{43}$/);
  const token = linkPath(created.json.url).split("/").pop();
  const pathname = linkPath(created.json.url);

  const anonymous = await rawRequest(server.port, { pathname });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.text.includes(value), false);

  for (let index = 0; index < 2; index += 1) {
    const page = await rawRequest(server.port, { pathname, headers: { cookie: adminCookie } });
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /Reveal/);
    assert.equal(page.text.includes(value), false);
    assert.match(page.headers["content-security-policy"], /default-src 'none'/);
    assert.match(page.headers["content-security-policy"], /script-src 'nonce-/);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.match(page.headers["x-robots-tag"], /noindex/);
    assert.match(page.headers["cache-control"], /no-store/);
    assert.match(page.headers["x-orkestr-secure-input"], /noCapture/);
  }

  const revealPath = `${pathname}/reveal`;
  const crossSite = await form(server.port, revealPath, adminCookie, { origin: "https://attacker.example.com", "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403);
  const nullCrossSite = await form(server.port, revealPath, adminCookie, { origin: "null", "sec-fetch-site": "cross-site" });
  assert.equal(nullCrossSite.status, 403);
  const anonymousPost = await rawRequest(server.port, { method: "POST", pathname: revealPath, headers: { origin: server.origin } });
  assert.equal(anonymousPost.status, 401);

  const revealed = await form(server.port, revealPath, adminCookie, { origin: "null", "sec-fetch-site": "same-origin" });
  assert.equal(revealed.status, 200, revealed.text);
  assert.ok(revealed.text.includes(value));
  assert.match(revealed.headers["content-security-policy"], /default-src 'none'/);

  const again = await form(server.port, revealPath, adminCookie);
  assert.equal(again.status, 410);
  assert.equal(again.text.includes(value), false);
  const reopened = await rawRequest(server.port, { pathname, headers: { cookie: adminCookie } });
  assert.equal(reopened.status, 410);

  const list = await rawRequest(server.port, { pathname: "/api/secret-links", headers: { cookie: adminCookie } });
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.links[0].status, "used");
  assert.equal(list.text.includes(value), false);
  assert.equal(list.text.includes(token), false);

  assert.deepEqual(await filesContaining(server.home, value), []);
  assert.deepEqual(await filesContaining(server.home, token), []);
  const events = await fs.readFile(path.join(server.home, "events.jsonl"), "utf8");
  for (const type of ["secret_link_created", "secret_link_revealed"]) assert.match(events, new RegExp(type));
});

test("only the owner's own session can view or reveal; admins and machine credentials cannot", async (t) => {
  const server = await fixture(t);
  const value = "synthetic-alice-only-91c2";
  const created = await createSecretShareLink({ value, ownerUserId: "alice" }, admin);
  const pathname = linkPath(created.url);
  const adminCookie = await pairedCookie({ userId: "admin", role: "admin" });
  const bobCookie = await pairedCookie({ userId: "bob", role: "user" });
  for (const cookie of [adminCookie, bobCookie]) {
    assert.equal((await rawRequest(server.port, { pathname, headers: { cookie } })).status, 404);
    const reveal = await form(server.port, `${pathname}/reveal`, cookie);
    assert.equal(reveal.status, 404);
    assert.equal(reveal.text.includes(value), false);
  }
  const aliceCookie = await pairedCookie({ userId: "alice", role: "user" });
  const revealed = await form(server.port, `${pathname}/reveal`, aliceCookie);
  assert.equal(revealed.status, 200);
  assert.ok(revealed.text.includes(value));

  const aliceList = await rawRequest(server.port, { pathname: "/api/secret-links?userId=admin", headers: { cookie: aliceCookie } });
  assert.equal(aliceList.status, 403);

  // An agent holding the CLI machine credential must not be able to burn or
  // read a link it created for the owner, even when the owner is the admin.
  const cliToken = "synthetic-cli-token-for-tests-0001";
  await fs.writeFile(path.join(server.home, "secrets", "cli-auth.json"), JSON.stringify({ token: cliToken }));
  const adminLink = await createSecretShareLink({ value }, admin);
  const machine = await rawRequest(server.port, {
    method: "POST",
    pathname: `${linkPath(adminLink.url)}/reveal`,
    headers: { authorization: `Bearer ${cliToken}`, origin: server.origin, "sec-fetch-site": "same-origin" },
  });
  assert.equal(machine.status, 401);
  assert.equal(machine.text.includes(value), false);
  const cliList = await rawRequest(server.port, { pathname: "/api/secret-links", headers: { authorization: `Bearer ${cliToken}` } });
  assert.equal(cliList.status, 200, cliList.text);
  assert.equal(cliList.json.links.find((link) => link.id === adminLink.link.id).status, "active");
});

test("concurrent reveals: exactly one caller receives the value", async (t) => {
  const server = await fixture(t);
  const value = "synthetic-race-value-4410";
  const direct = await createSecretShareLink({ value, ownerUserId: "alice" }, admin);
  const token = linkPath(direct.url).split("/").pop();
  const results = await Promise.all(Array.from({ length: 8 }, () => revealSecretShareLink(token, "alice")));
  assert.equal(results.filter((result) => result.state === "revealed" && result.value === value).length, 1);
  assert.equal(results.filter((result) => result.state === "ended").length, 7);

  const viaHttp = await createSecretShareLink({ value, ownerUserId: "alice" }, admin);
  const aliceCookie = await pairedCookie({ userId: "alice", role: "user" });
  const responses = await Promise.all(Array.from({ length: 6 }, () => form(server.port, `${linkPath(viaHttp.url)}/reveal`, aliceCookie)));
  assert.equal(responses.filter((response) => response.status === 200 && response.text.includes(value)).length, 1);
  assert.equal(responses.filter((response) => response.status === 410).length, 5);
});

test("expired links are treated as used and their ciphertext is purged", async (t) => {
  const server = await fixture(t);
  assert.equal(parseSecretLinkTtl(""), 15 * 60 * 1000);
  assert.equal(parseSecretLinkTtl("2h"), 2 * 60 * 60 * 1000);
  assert.throws(() => parseSecretLinkTtl("25h"), /secret_link_ttl_too_long/);
  assert.throws(() => parseSecretLinkTtl("soon"), /secret_link_ttl_invalid/);
  const created = await createSecretShareLink({ value: "synthetic-expiring-value", ownerUserId: "alice", ttl: "1m" }, admin);
  const storePath = path.join(server.home, "secrets", "secret-links.json");
  const store = JSON.parse(await fs.readFile(storePath, "utf8"));
  store.links[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(storePath, JSON.stringify(store));
  const aliceCookie = await pairedCookie({ userId: "alice", role: "user" });
  assert.equal((await rawRequest(server.port, { pathname: linkPath(created.url), headers: { cookie: aliceCookie } })).status, 410);
  assert.equal((await form(server.port, `${linkPath(created.url)}/reveal`, aliceCookie)).status, 410);
  const after = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(after.links[0].status, "expired");
  assert.equal("encryptedValue" in after.links[0], false);
  assert.match(await fs.readFile(path.join(server.home, "events.jsonl"), "utf8"), /secret_link_expired/);
});

test("request link stores the submitted value as a user secret and notes the thread without the value", async (t) => {
  const server = await fixture(t);
  const value = "synthetic-requested-token-5d21";
  await createThread({ id: "alice-thread", name: "Alice thread", ownerUserId: "alice" }, process.env);
  await assert.rejects(createSecretRequestLink({ name: "../escape" }, alice), /secret_name_invalid/);
  const created = await createSecretRequestLink({ name: "service/api-token", threadId: "alice-thread", label: "Example service" }, alice);
  assert.equal(created.link.handle, "secret://user/alice/service/api-token");
  const pathname = linkPath(created.url);
  const aliceCookie = await pairedCookie({ userId: "alice", role: "user" });

  const page = await rawRequest(server.port, { pathname, headers: { cookie: aliceCookie } });
  assert.equal(page.status, 200);
  assert.match(page.text, /name="value"/);

  const tooLarge = await form(server.port, `${pathname}/submit`, aliceCookie, {}, new URLSearchParams({ value: "x".repeat(16 * 1024 + 1) }).toString());
  assert.equal(tooLarge.status, 413);
  const crossSite = await form(server.port, `${pathname}/submit`, aliceCookie, { origin: "https://attacker.example.com" }, new URLSearchParams({ value }).toString());
  assert.equal(crossSite.status, 403);

  const submitted = await form(server.port, `${pathname}/submit`, aliceCookie, {}, new URLSearchParams({ value }).toString());
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal(submitted.text.includes(value), false);
  const again = await form(server.port, `${pathname}/submit`, aliceCookie, {}, new URLSearchParams({ value: "synthetic-overwrite" }).toString());
  assert.equal(again.status, 410);

  const resolved = await resolveSecureSecretReference("secret://user/alice/service/api-token", { ownerUserId: "alice", createRequest: false });
  assert.equal(resolved.value, value);
  const messages = await listThreadMessages("alice-thread", process.env);
  const note = messages.find((message) => message.source === "secret_link");
  assert.ok(note, "thread note appended");
  assert.match(note.text, /service\/api-token/);
  assert.equal(JSON.stringify(messages).includes(value), false);
  assert.deepEqual(await filesContaining(server.home, value), []);
  assert.match(await fs.readFile(path.join(server.home, "events.jsonl"), "utf8"), /secret_link_submitted/);
});

test("share --from reuses a stored secret, revoke kills the link, cross-user sources are refused", async (t) => {
  const server = await fixture(t);
  const value = "synthetic-stored-value-0b77";
  await setSecureSecret({ scope: "user", ownerUserId: "alice", name: "vendor/key", value }, alice);
  await assert.rejects(createSecretShareLink({ from: "secret://user/alice/vendor/key" }, userPrincipal({ id: "bob", role: "user" })), /secure_secret_owner_mismatch|forbidden/);
  const created = await createSecretShareLink({ from: "secret://user/alice/vendor/key" }, alice);
  assert.equal(created.link.name, "vendor/key");
  const aliceCookie = await pairedCookie({ userId: "alice", role: "user" });
  const revoked = await jsonPost(server.port, `/api/secret-links/${created.link.id}/revoke`, {}, { cookie: aliceCookie });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.json.link.status, "revoked");
  assert.equal((await form(server.port, `${linkPath(created.url)}/reveal`, aliceCookie)).status, 410);
  assert.match(await fs.readFile(path.join(server.home, "events.jsonl"), "utf8"), /secret_link_revoked/);
  assert.equal((await fs.readFile(path.join(server.home, "secrets", "secret-links.json"), "utf8")).includes("encryptedValue"), false);
});

test("unknown token lookups are throttled per client", async (t) => {
  const prior = process.env.ORKESTR_SECRET_LINK_LOOKUP_LIMIT;
  process.env.ORKESTR_SECRET_LINK_LOOKUP_LIMIT = "3";
  t.after(() => {
    if (prior === undefined) delete process.env.ORKESTR_SECRET_LINK_LOOKUP_LIMIT;
    else process.env.ORKESTR_SECRET_LINK_LOOKUP_LIMIT = prior;
  });
  const server = await fixture(t);
  const created = await createSecretShareLink({ value: "synthetic-throttle-value", ownerUserId: "alice" }, admin);
  const aliceCookie = await pairedCookie({ userId: "alice", role: "user" });
  for (let index = 0; index < 3; index += 1) {
    const guess = await rawRequest(server.port, { pathname: `/s/${"A".repeat(42)}${index}`, headers: { cookie: aliceCookie } });
    assert.equal(guess.status, 404);
  }
  assert.equal((await rawRequest(server.port, { pathname: `/s/${"B".repeat(43)}`, headers: { cookie: aliceCookie } })).status, 429);
  assert.equal((await form(server.port, `${linkPath(created.url)}/reveal`, aliceCookie)).status, 429);
});
