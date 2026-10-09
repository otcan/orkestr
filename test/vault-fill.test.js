import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { acquireDesktopLease } from "../packages/browsers/src/desktop-leases.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import { agentFillDesktop, fillPlan, ownerFillDesktop } from "../packages/core/src/vault-fill.js";
import { createVaultItem, setVaultGrants } from "../packages/core/src/vault-service.js";
import { mutateVault } from "../packages/core/src/vault-store.js";

// Synthetic users, threads, desktops and values only. browserctl, xdotool and
// Chrome DevTools are fakes; the fake typist records its own /proc-visible
// argv and environ, the fake DevTools records every CDP method it receives.

const USERNAME = "synthetic-fill-user@example.com";
const PASSWORD = "synthetic-fill-password-7d2a";
const managed = ["ORKESTR_HOME", "ORKESTR_BROWSERCTL_PATH", "ORKESTR_DESKTOP_KEYSTROKE_COMMAND", "ORKESTR_VAULT_AGENT_READ_LIMIT", "ORKESTR_BROWSER_SESSIONS_CACHE_MS", "FAKE_CDP_URL"];
let home;
let typist;
let typistLog;
let itemId;
let cdpServer;
let cdpMethods = [];
// Focus reported by the fake DevTools: "login-form" moves focus from the
// username to the password field once the fake typist pressed Tab.
let focusMode = "password";

const fields = {
  password: { focused: true, tag: "input", type: "password", writable: true, formHasPassword: true },
  email: { focused: true, tag: "input", type: "email", writable: true, formHasPassword: true },
  search: { focused: true, tag: "input", type: "search", writable: true, formHasPassword: false },
  textarea: { focused: true, tag: "textarea", type: "", writable: true, formHasPassword: false },
  omnibox: { focused: false },
};

function currentFocus() {
  if (focusMode !== "login-form") return fields[focusMode];
  const log = (() => { try { return readFileSync(typistLog, "utf8"); } catch { return ""; } })();
  return log.includes("Tab") ? fields.password : fields.email;
}

async function startFakeCdp() {
  const server = http.createServer((request, response) => {
    const { port } = server.address();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/json/list"
      ? [{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }, { type: "service_worker", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/sw` }]
      : {}));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    cdpMethods.push(message.method);
    socket.send(JSON.stringify({ id: message.id, result: { result: { value: currentFocus() } } }));
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, wss, url: `http://127.0.0.1:${server.address().port}` };
}

const fakeBrowserctl = `#!/usr/bin/env node
const [command, slug] = process.argv.slice(2);
const sessions = [
  { slug: "example-desk", display: ":95", cdp_url: process.env.FAKE_CDP_URL },
  { slug: "nocdp-desk", display: ":96" },
  { slug: "remote-desk" },
];
if (command === "target") {
  const session = sessions.find((entry) => entry.slug === slug);
  if (!session) { process.stderr.write("not found"); process.exit(1); }
  process.stdout.write(JSON.stringify({ ok: true, session }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, sessions }));
}
`;

const fakeTypist = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const record = {
    cmdline: fs.readFileSync("/proc/self/cmdline", "utf8").split("\\0").filter(Boolean),
    environ: fs.readFileSync("/proc/self/environ", "utf8"),
    display: process.env.DISPLAY,
    stdin,
  };
  fs.appendFileSync(path.join(__dirname, "typist.log"), JSON.stringify(record) + "\\n");
});
`;

function owner(id, { authAgeMs = 0 } = {}) {
  return { ...userPrincipal({ id, role: "user" }), vaultOwner: true, authenticatedAt: new Date(Date.now() - authAgeMs).toISOString() };
}

async function treeText(root) {
  let text = "";
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    text += entry.isDirectory() ? await treeText(full) : await fs.readFile(full, "utf8").catch(() => "");
  }
  return text;
}

async function typed() {
  const text = await fs.readFile(typistLog, "utf8").catch(() => "");
  await fs.rm(typistLog, { force: true });
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function writeExecutable(file, content) {
  await fs.writeFile(file, content, { mode: 0o755 });
  return file;
}

test.before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-vault-fill-"));
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-vault-fill-bin-"));
  typist = await writeExecutable(path.join(bin, "fake-xdotool"), fakeTypist);
  typistLog = path.join(bin, "typist.log");
  cdpServer = await startFakeCdp();
  Object.assign(process.env, {
    FAKE_CDP_URL: cdpServer.url,
    ORKESTR_HOME: home,
    ORKESTR_BROWSERCTL_PATH: await writeExecutable(path.join(bin, "fake-browserctl"), fakeBrowserctl),
    ORKESTR_DESKTOP_KEYSTROKE_COMMAND: typist,
    ORKESTR_VAULT_AGENT_READ_LIMIT: "1000",
    ORKESTR_BROWSER_SESSIONS_CACHE_MS: "0",
  });
  for (const [id, ownerUserId] of [["alice-thread", "alice"], ["alice-other", "alice"], ["bob-thread", "bob"]]) {
    await createThread({ id, name: id, ownerUserId }, process.env);
  }
  const created = await createVaultItem(owner("alice"), { name: "Example Login", url: "https://login.example.com", username: USERNAME, password: PASSWORD });
  itemId = created.item.id;
  await setVaultGrants(owner("alice"), itemId, ["alice-thread", "alice-other"]);
  for (const slug of ["example-desk", "nocdp-desk"]) {
    await acquireDesktopLease(slug, { threadId: "alice-thread", threadName: "alice-thread" }, process.env, { principal: userPrincipal({ id: "alice" }) });
  }
});

test.beforeEach(() => {
  focusMode = "password";
  cdpMethods = [];
});

test.after(async () => {
  cdpServer.wss.close();
  await new Promise((resolve) => cdpServer.server.close(resolve));
  for (const key of managed) delete process.env[key];
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(path.dirname(typist), { recursive: true, force: true });
});

test("fill plan checks focus before each value: username, Tab, password, Enter", () => {
  assert.deepEqual(fillPlan({ username: "u", password: "p" }, "both", true), [
    { expect: "login-username", steps: [{ text: "u" }, { key: "Tab" }] },
    { expect: "password", steps: [{ text: "p" }, { key: "Return" }] },
  ]);
  assert.deepEqual(fillPlan({ username: "u", password: "p" }, "password"), [{ expect: "password", steps: [{ text: "p" }] }]);
  assert.throws(() => fillPlan({ username: "u" }, "password"), { code: "vault_fill_field_empty" });
});

test("agent fill types values only through the typing process's stdin", async () => {
  focusMode = "login-form";
  const result = await agentFillDesktop("alice-thread", "Example Login", { desktop: "example-desk", field: "both", submit: true });
  assert.deepEqual(result, { status: "filled" });
  const calls = await typed();
  assert.deepEqual(calls.map((call) => call.stdin), [USERNAME, "", PASSWORD, ""]);
  assert.deepEqual(calls.map((call) => call.cmdline.slice(2).join(" ")), [
    "type --clearmodifiers --delay 20 --file -",
    "key --clearmodifiers Tab",
    "type --clearmodifiers --delay 20 --file -",
    "key --clearmodifiers Return",
  ]);
  for (const call of calls) {
    assert.equal(call.display, ":95");
    assert.ok(!call.cmdline.join(" ").includes(PASSWORD) && !call.cmdline.join(" ").includes(USERNAME));
    assert.ok(!call.environ.includes(PASSWORD) && !call.environ.includes(USERNAME));
    assert.ok(!call.environ.includes("ORKESTR_"), "only DISPLAY and PATH reach the typist");
  }
  const stored = await treeText(home);
  assert.ok(!stored.includes(PASSWORD) && !stored.includes(USERNAME), "no value in events, logs or the store");
  assert.match(stored, /"type":"vault_fill".*"outcome":"filled"/);
  assert.ok(cdpMethods.length >= 2 && cdpMethods.every((method) => method === "Runtime.evaluate"), "focus probe is read-only");
});

test("fill refuses and types nothing unless a password field has focus", async () => {
  for (const [mode, field, reason] of [
    ["omnibox", "password", "focus_not_password_field"],
    ["search", "password", "focus_not_password_field"],
    ["textarea", "password", "focus_not_password_field"],
    ["email", "password", "focus_not_password_field"],
    ["password", "username", "focus_not_username_field"],
    ["search", "both", "focus_not_username_field"],
  ]) {
    focusMode = mode;
    assert.deepEqual(await agentFillDesktop("alice-thread", itemId, { desktop: "example-desk", field }), { status: "failed", reason }, `${mode}/${field}`);
  }
  assert.deepEqual(await typed(), []);
  assert.match(await treeText(home), /"outcome":"failed","reason":"focus_not_password_field"/);
});

test("without DevTools the focus is unverifiable; only the owner may override", async () => {
  assert.deepEqual(await agentFillDesktop("alice-thread", itemId, { desktop: "nocdp-desk", allowUnverifiedFocus: true }), { status: "failed", reason: "focus_unverifiable" });
  assert.deepEqual(await ownerFillDesktop(owner("alice"), itemId, { desktop: "nocdp-desk" }), { status: "failed", reason: "focus_unverifiable" });
  assert.deepEqual(await typed(), []);
  assert.deepEqual(await ownerFillDesktop(owner("alice"), itemId, { desktop: "nocdp-desk", allowUnverifiedFocus: true }), { status: "filled" });
  assert.deepEqual((await typed()).map((call) => call.stdin), [PASSWORD]);
  focusMode = "search";
  assert.deepEqual(await ownerFillDesktop(owner("alice"), itemId, { desktop: "example-desk", allowUnverifiedFocus: true }), { status: "failed", reason: "focus_not_password_field" });
  assert.deepEqual(await typed(), []);
});

test("fill is refused without the desktop lease or the item grant", async () => {
  await assert.rejects(agentFillDesktop("alice-other", itemId, { desktop: "example-desk" }), { code: "desktop_lease_owned_by_other_thread" });
  await assert.rejects(agentFillDesktop("alice-thread", itemId, { desktop: "remote-desk" }), { code: "desktop_lease_required" });
  await assert.rejects(agentFillDesktop("bob-thread", itemId, { desktop: "example-desk" }), { code: "vault_item_not_found" });
  await assert.rejects(agentFillDesktop("alice-thread", itemId, { desktop: "" }), { code: "vault_fill_desktop_required" });
  await assert.rejects(agentFillDesktop("alice-thread", itemId, { desktop: "example-desk", field: "notes" }), { code: "vault_field_invalid" });
  assert.deepEqual(await typed(), []);
});

test("a failing typist reports failed without details", async () => {
  process.env.ORKESTR_DESKTOP_KEYSTROKE_COMMAND = "/bin/false";
  try {
    assert.deepEqual(await agentFillDesktop("alice-thread", itemId, { desktop: "example-desk" }), { status: "failed", reason: "typing_failed" });
  } finally {
    process.env.ORKESTR_DESKTOP_KEYSTROKE_COMMAND = typist;
  }
});

test("single-use items are used up by their first fill", async () => {
  const single = await createVaultItem(owner("alice"), { name: "One Time", password: PASSWORD });
  await setVaultGrants(owner("alice"), single.item.id, ["alice-thread"]);
  await mutateVault("alice", (store) => { store.items.find((item) => item.id === single.item.id).singleUse = true; });
  assert.deepEqual(await agentFillDesktop("alice-thread", "One Time", { desktop: "example-desk" }), { status: "filled" });
  await assert.rejects(agentFillDesktop("alice-thread", "One Time", { desktop: "example-desk" }), { code: "vault_item_used" });
  const refused = await createVaultItem(owner("alice"), { name: "One Time Refused", password: PASSWORD });
  await setVaultGrants(owner("alice"), refused.item.id, ["alice-thread"]);
  await mutateVault("alice", (store) => { store.items.find((item) => item.id === refused.item.id).singleUse = true; });
  focusMode = "omnibox";
  assert.equal((await agentFillDesktop("alice-thread", "One Time Refused", { desktop: "example-desk" })).reason, "focus_not_password_field");
  focusMode = "password";
  assert.deepEqual(await agentFillDesktop("alice-thread", "One Time Refused", { desktop: "example-desk" }), { status: "filled" }, "a refused fill does not use up the item");
  assert.equal((await typed()).length, 2);
});

test("owner fill needs a recent sign-in and a desktop with a display", async () => {
  await assert.rejects(ownerFillDesktop(owner("alice", { authAgeMs: 60 * 60_000 }), itemId, { desktop: "example-desk" }), { code: "vault_reauth_required" });
  await assert.rejects(ownerFillDesktop(owner("alice"), itemId, { desktop: "remote-desk" }), { code: "vault_fill_desktop_unsupported" });
  process.env.ORKESTR_BROWSER_API_URL = "https://browsers.example.test";
  try {
    await assert.rejects(ownerFillDesktop(owner("alice"), itemId, { desktop: "example-desk" }), { code: "vault_fill_desktop_unsupported" });
  } finally {
    delete process.env.ORKESTR_BROWSER_API_URL;
  }
  await assert.rejects(ownerFillDesktop(owner("bob"), itemId, { desktop: "example-desk" }), { code: "vault_item_not_found" });
  focusMode = "email";
  assert.deepEqual(await ownerFillDesktop(owner("alice"), itemId, { desktop: "example-desk", field: "username" }), { status: "filled" });
  assert.deepEqual((await typed()).map((call) => call.stdin), [USERNAME]);
});
