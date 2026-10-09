import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireDesktopLease } from "../packages/browsers/src/desktop-leases.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import { agentFillDesktop, fillSteps, ownerFillDesktop } from "../packages/core/src/vault-fill.js";
import { createVaultItem, setVaultGrants } from "../packages/core/src/vault-service.js";
import { mutateVault } from "../packages/core/src/vault-store.js";

// Synthetic users, threads, desktops and values only. browserctl and xdotool
// are fakes; the fake typist records its own /proc-visible argv and environ.

const USERNAME = "synthetic-fill-user@example.com";
const PASSWORD = "synthetic-fill-password-7d2a";
const managed = ["ORKESTR_HOME", "ORKESTR_BROWSERCTL_PATH", "ORKESTR_DESKTOP_KEYSTROKE_COMMAND", "ORKESTR_VAULT_AGENT_READ_LIMIT", "ORKESTR_BROWSER_SESSIONS_CACHE_MS"];
let home;
let typist;
let typistLog;
let itemId;

const fakeBrowserctl = `#!/usr/bin/env node
const [command, slug] = process.argv.slice(2);
const sessions = [{ slug: "example-desk", display: ":95" }, { slug: "remote-desk" }];
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
  Object.assign(process.env, {
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
  await acquireDesktopLease("example-desk", { threadId: "alice-thread", threadName: "alice-thread" }, process.env, { principal: userPrincipal({ id: "alice" }) });
});

test.after(async () => {
  for (const key of managed) delete process.env[key];
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(path.dirname(typist), { recursive: true, force: true });
});

test("fill steps type username, Tab, password and optionally Enter", () => {
  assert.deepEqual(fillSteps({ username: "u", password: "p" }, "both", true), [{ text: "u" }, { key: "Tab" }, { text: "p" }, { key: "Return" }]);
  assert.deepEqual(fillSteps({ username: "u", password: "p" }, "password"), [{ text: "p" }]);
  assert.throws(() => fillSteps({ username: "u" }, "password"), { code: "vault_fill_field_empty" });
});

test("agent fill types values only through the typing process's stdin", async () => {
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
    assert.deepEqual(await agentFillDesktop("alice-thread", itemId, { desktop: "example-desk" }), { status: "failed" });
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
  assert.equal((await typed()).length, 1);
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
  assert.deepEqual(await ownerFillDesktop(owner("alice"), itemId, { desktop: "example-desk", field: "username" }), { status: "filled" });
  assert.deepEqual((await typed()).map((call) => call.stdin), [USERNAME]);
});
