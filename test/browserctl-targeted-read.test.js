import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readManagedDesktopSession } from "../packages/browsers/src/browserctl.js";
import { readVirtualBrowserTarget } from "../packages/browsers/src/browsers.js";

const SESSION = '{"slug":"example-desk","status":"active","type":"desktop","upstream":"127.0.0.1:16084","managed":true}';

// A fake browserctl from a shell body; every invocation is logged to calls.log.
async function fakeBrowserctl(t, body, extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-targeted-desktop-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const command = path.join(home, "browserctl");
  const log = path.join(home, "calls.log");
  await fs.writeFile(command, `#!/bin/sh\necho "$*" >> "${log}"\n${body}\n`, { mode: 0o700 });
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_BROWSERCTL_PATH: command, ...extraEnv };
  const calls = async () => (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { env, calls };
}

test("desktop routing reads one session with browserctl target by default", async (t) => {
  const { env, calls } = await fakeBrowserctl(t, `
if [ "$1" = target ] && [ "$2" = example-desk ]; then printf '%s\\n' '{"ok":true,"session":${SESSION}}'; exit 0; fi
if [ "$1" = target ]; then echo "browser session not found: $2" >&2; exit 1; fi
exit 41`);
  const session = await readManagedDesktopSession("example-desk", env);
  assert.equal(session.slug, "example-desk");
  assert.equal(session.status, "active");
  assert.equal(session.upstream, "127.0.0.1:16084");
  assert.deepEqual(await calls(), ["target example-desk"]);

  // An unknown desktop is a plain miss (404), not a provider failure.
  assert.equal(await readManagedDesktopSession("other-desk", env), null);
  await assert.rejects(() => readVirtualBrowserTarget("other-desk", { ...env, ORKESTR_BROWSER_DESKTOP_MODE: "browserctl" }), { statusCode: 404 });
  assert.ok(!(await calls()).some((call) => call.startsWith("list")));
});

test("a provider without a target command falls back to the inventory once and is remembered", async (t) => {
  const { env, calls } = await fakeBrowserctl(t, `
if [ "$1" = list ]; then printf '%s\\n' '{"ok":true,"sessions":[${SESSION}]}'; exit 0; fi
echo "browserctl: error: argument command: invalid choice: '$1' (choose from 'list', 'start')" >&2; exit 2`);
  assert.equal((await readManagedDesktopSession("example-desk", env)).slug, "example-desk");
  assert.equal((await readManagedDesktopSession("example-desk", env)).slug, "example-desk");
  assert.deepEqual(await calls(), ["target example-desk", "list --json", "list --json"]);
});

test("a provider that ignores the subcommand and prints the inventory still resolves the desktop", async (t) => {
  const { env } = await fakeBrowserctl(t, `printf '%s\\n' '{"ok":true,"sessions":[${SESSION}]}'`);
  assert.equal((await readManagedDesktopSession("example-desk", env)).slug, "example-desk");
});

test("ORKESTR_BROWSERCTL_TARGETED_READ=0 keeps the inventory read", async (t) => {
  const { env, calls } = await fakeBrowserctl(t, `
if [ "$1" = list ]; then printf '%s\\n' '{"ok":true,"sessions":[${SESSION}]}'; exit 0; fi
exit 41`, { ORKESTR_BROWSERCTL_TARGETED_READ: "0" });
  assert.equal((await readManagedDesktopSession("example-desk", env)).slug, "example-desk");
  assert.deepEqual(await calls(), ["list --json"]);
});

test("other target failures are reported, not mistaken for a missing desktop", async (t) => {
  const { env } = await fakeBrowserctl(t, `echo "provider exploded" >&2; exit 3`);
  await assert.rejects(() => readManagedDesktopSession("example-desk", env), /provider exploded/);
});
