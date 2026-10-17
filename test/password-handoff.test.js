import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { desktopPasswordBlind, endPasswordHandoff, handoffOrigin, passwordHandoffStatus, startPasswordHandoff } from "../packages/core/src/password-handoff.js";
import { msToChromeTime, savedLoginSince } from "../packages/browsers/src/chrome-saved-login-probe.js";
import { exactOrigin } from "../packages/browsers/src/password-field-probe.js";
import { operateManagedDesktop } from "../packages/browsers/src/desktop-operator.js";

// Synthetic only: a local signup fixture, a headless Chrome and a fake Chrome
// login store. No real site, account, signup or submission is involved.
const SECRET = "Synthetic-Generated-Pass-7Q!x";
const SIGNUP_HTML = `<!doctype html><title>Signup fixture</title>
<form action="/never-submitted" onsubmit="return false">
  <input id="name" name="name" value="Ada">
  <input id="new-password" type="password" autocomplete="new-password" name="password">
  <input id="plain" type="text" name="note">
</form>`;

async function findChrome() {
  for (const candidate of [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // next
    }
  }
  return "";
}

function fixtureServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(SIGNUP_HTML);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function loginStore(profileDir) {
  const dir = path.join(profileDir, "Default");
  return fs.mkdir(dir, { recursive: true }).then(() => {
    const db = new DatabaseSync(path.join(dir, "Login Data"));
    db.exec("create table logins (origin_url text, signon_realm text, username_value text, password_value blob, date_created integer)");
    return db;
  });
}

async function setup(t) {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    t.skip("Puppeteer is not installed.");
    return null;
  }
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome available.");
    return null;
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pw-handoff-"));
  const profileDir = path.join(home, "profile");
  const db = await loginStore(profileDir);
  const server = await fixtureServer();
  const port = server.address().port;
  const browser = await puppeteer.launch({ headless: "new", executablePath: chrome, args: ["--no-sandbox", "--remote-debugging-port=0"] });
  const cdpUrl = `http://${new URL(browser.wsEndpoint()).host}`;
  const signup = await browser.newPage();
  await signup.goto(`http://127.0.0.1:${port}/signup`);
  const other = await browser.newPage();
  await other.goto(`http://localhost:${port}/signup`); // same server, different origin
  const targetIdOf = async (page) => (await (await page.target().createCDPSession()).send("Target.getTargetInfo")).targetInfo.targetId;
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "owner" };
  let lease = { active: true, threadId: "pa-thread" };
  const deps = {
    activeDesktopLeaseStatus: async () => lease,
    readManagedDesktopSession: async () => ({ cdp_url: cdpUrl, profileDir }),
  };
  const owner = { kind: "user", userId: "owner", role: "admin", vaultOwner: true, recentAuthAt: new Date().toISOString() };
  t.after(async () => {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return {
    env, deps, owner, db, signup, other, origin: `http://127.0.0.1:${port}`, otherOrigin: `http://localhost:${port}`,
    signupTarget: await targetIdOf(signup), otherTarget: await targetIdOf(other),
    setLease: (value) => { lease = value; },
  };
}

async function eventsText(env) {
  return fs.readFile(path.join(env.ORKESTR_HOME, "events.jsonl"), "utf8").catch(() => "");
}

test("origins: exact https or loopback http only", () => {
  assert.equal(handoffOrigin("https://iletimerkezi.example.test"), "https://iletimerkezi.example.test");
  assert.equal(handoffOrigin("https://iletimerkezi.example.test/signup"), "", "a path is not an origin");
  assert.equal(handoffOrigin("http://iletimerkezi.example.test"), "", "plain http only on loopback");
  assert.equal(handoffOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(exactOrigin("about:blank"), "");
});

test("saved-login check reads only realm/date metadata and only logins created after the start", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pw-store-"));
  const db = await loginStore(home);
  const since = Date.now();
  db.prepare("insert into logins values (?, ?, ?, ?, ?)").run("https://a.test/signup", "https://a.test/", "ada", Buffer.from(SECRET), msToChromeTime(since - 60_000));
  assert.deepEqual(await savedLoginSince(home, "https://a.test", since), { ok: true, saved: false, count: 0 }, "an older login is not this save");
  db.prepare("insert into logins values (?, ?, ?, ?, ?)").run("https://a.test/signup", "https://a.test/", "ada", Buffer.from(SECRET), msToChromeTime(since + 1000));
  db.exec("PRAGMA locking_mode=EXCLUSIVE");
  db.exec("BEGIN EXCLUSIVE"); // Chrome keeps the store locked while running
  assert.deepEqual(await savedLoginSince(home, "https://a.test", since), { ok: true, saved: true, count: 1 });
  assert.deepEqual(await savedLoginSince(home, "https://other.test", since), { ok: true, saved: false, count: 0 });
  db.exec("COMMIT");
  db.close();
  assert.equal((await savedLoginSince(path.join(home, "missing"), "https://a.test", since)).reason, "login_store_missing");
  await fs.rm(home, { recursive: true, force: true });
});

test("handoff binds the exact tab and origin, blinds the desktop, and reports accepted then saved_verified without the value", { timeout: 60_000 }, async (t) => {
  const f = await setup(t);
  if (!f) return;
  const handoff = await startPasswordHandoff(f.owner, { desktopSlug: "pa-desk", threadId: "pa-thread", targetId: f.signupTarget, origin: f.origin, selector: "#new-password" }, f.env, f.deps);
  assert.equal(handoff.status, "awaiting_owner");
  assert.equal(await desktopPasswordBlind("pa-desk", f.env), true, "the desktop is blind for agents");
  await assert.rejects(operateManagedDesktop("pa-desk", { operation: "observe" }, f.env), /desktop_password_blind/, "agent observe is refused");

  // The owner accepts Chrome's suggestion (simulated: headless Chrome has no generation UI).
  await f.signup.type("#new-password", SECRET);
  const accepted = await passwordHandoffStatus({ ownerUserId: "owner", threadId: "pa-thread" }, handoff.id, f.env, f.deps);
  assert.equal(accepted.status, "accepted", "a filled field is accepted, never saved");
  assert.equal(accepted.chromeFilled, false, "typed by hand, not filled by Chrome");

  f.db.prepare("insert into logins values (?, ?, ?, ?, ?)").run(`${f.origin}/signup`, `${f.origin}/`, "ada", Buffer.from(SECRET), msToChromeTime(Date.now()));
  const saved = await passwordHandoffStatus({ ownerUserId: "owner" }, handoff.id, f.env, f.deps);
  assert.equal(saved.status, "saved_verified");

  const ended = await endPasswordHandoff(f.owner, handoff.id, {}, f.env, f.deps);
  assert.equal(ended.status, "saved_verified");
  assert.equal(await desktopPasswordBlind("pa-desk", f.env), false);

  const outputs = JSON.stringify([handoff, accepted, saved, ended]) + await eventsText(f.env) +
    await fs.readFile(path.join(f.env.ORKESTR_HOME, "password-handoffs.json"), "utf8");
  assert.equal(outputs.includes(SECRET), false, "the password never appears in results, events or state");
  assert.equal(/"length"|valueLength/.test(outputs), false, "not even its length");
});

test("handoff refuses the wrong tab, a foreign origin, a non-password or filled field, another thread's lease and a second open handoff", { timeout: 60_000 }, async (t) => {
  const f = await setup(t);
  if (!f) return;
  const base = { desktopSlug: "pa-desk", threadId: "pa-thread", targetId: f.signupTarget, origin: f.origin, selector: "#new-password" };
  const start = (patch = {}, principal = f.owner) => startPasswordHandoff(principal, { ...base, ...patch }, f.env, f.deps);
  await assert.rejects(start({ targetId: "no-such-target" }), /password_handoff_tab_not_found/);
  await assert.rejects(start({ targetId: f.otherTarget }), /password_handoff_origin_mismatch/, "the other tab has another origin");
  await assert.rejects(start({ origin: f.otherOrigin }), /password_handoff_origin_mismatch/);
  await assert.rejects(start({ selector: "#plain" }), /password_handoff_field_not_password/);
  await assert.rejects(start({ threadId: "other-thread" }), /desktop_lease_owned_by_other_thread/);
  await assert.rejects(start({}, { ...f.owner, recentAuthAt: "2020-01-01T00:00:00Z" }), /vault_reauth_required/, "needs a recent owner sign-in");
  await assert.rejects(start({}, { ...f.owner, vaultOwner: false }), /vault_owner_session_required/, "agents cannot start it");
  f.setLease({ active: false });
  await assert.rejects(start(), /desktop_lease_required/);
  f.setLease({ active: true, threadId: "pa-thread" });
  await start();
  await assert.rejects(start(), /password_handoff_already_open/, "one owner handoff per desktop");
  await f.signup.type("#new-password", "x");
  const fresh = { ...f.env, ORKESTR_HOME: `${f.env.ORKESTR_HOME}-2` };
  await assert.rejects(startPasswordHandoff(f.owner, base, fresh, f.deps), /password_handoff_field_not_empty/);
});

test("navigating the bound tab away closes the handoff as aborted with status unknown", { timeout: 60_000 }, async (t) => {
  const f = await setup(t);
  if (!f) return;
  const handoff = await startPasswordHandoff(f.owner, { desktopSlug: "pa-desk", threadId: "pa-thread", targetId: f.signupTarget, origin: f.origin, selector: "#new-password" }, f.env, f.deps);
  await f.signup.goto(`${f.otherOrigin}/signup`);
  const status = await passwordHandoffStatus({ ownerUserId: "owner" }, handoff.id, f.env, f.deps);
  assert.deepEqual([status.status, status.reason, status.state], ["unknown", "origin_mismatch", "aborted"]);
  assert.equal(await desktopPasswordBlind("pa-desk", f.env), false);
  await assert.rejects(passwordHandoffStatus({ ownerUserId: "someone-else" }, handoff.id, f.env, f.deps), /password_handoff_not_found/, "other owners cannot read it");
});
