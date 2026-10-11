import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { setupCommand } from "../apps/cli/src/setup-command.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { listTimers } from "../packages/core/src/timers.js";

async function read(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function adminCookie(baseUrl) {
  const challenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
  await approvePairingChallenge(challenge.challengeId, { env: process.env });
  const pair = await fetch(`${baseUrl}/api/setup/security/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId }),
  });
  assert.equal(pair.status, 200);
  return pair.headers.get("set-cookie") || "";
}

function cli(baseUrl, cookie) {
  const out = { stdout: "", stderr: "" };
  const ctx = {
    baseUrl,
    headers: cookie ? { cookie } : {},
    env: process.env,
    stdout: { write: (chunk) => { out.stdout += chunk; } },
    stderr: { write: (chunk) => { out.stderr += chunk; } },
  };
  return { out, run: (...argv) => setupCommand(argv, ctx) };
}

// Stand-in for the Codex CLI's `login status`, so no real login is needed.
async function fakeCodex(dir, loggedIn) {
  const bin = path.join(dir, loggedIn ? "codex-in" : "codex-out");
  await fs.writeFile(bin, `#!/bin/sh\necho "${loggedIn ? "Logged in using ChatGPT" : "Not logged in"}"\nexit ${loggedIn ? 0 : 1}\n`, { mode: 0o755 });
  return bin;
}

test("setup CLI lists, refuses without a provider login, installs, reports status and uninstalls via the API", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-setup-api-"));
  const prior = { home: process.env.ORKESTR_HOME, auth: process.env.ORKESTR_AUTH_REQUIRED, bin: process.env.ORKESTR_CODEX_BIN };
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_CODEX_BIN = await fakeCodex(home, false);
  t.after(async () => {
    for (const [key, value] of [["ORKESTR_HOME", prior.home], ["ORKESTR_AUTH_REQUIRED", prior.auth], ["ORKESTR_CODEX_BIN", prior.bin]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const anonymous = await fetch(`${baseUrl}/api/setups`);
  assert.ok([401, 403].includes(anonymous.status), `anonymous list must be refused, got ${anonymous.status}`);

  const cookie = await adminCookie(baseUrl);
  const { out, run } = cli(baseUrl, cookie);

  assert.equal(await run("list"), 0);
  assert.match(out.stdout, /fitness-tracker\s+Personal fitness tracker {2}\(preview, v0\.1\.0\)/);
  assert.match(out.stdout, /Needs: codex or claude-code login; host must stay on/);

  assert.equal(await run("install", "fitness-tracker"), 1);
  assert.match(out.stderr, /needs a signed-in AI provider first \(codex: not_logged_in, claude-code: claude_account_not_ready\)/);
  assert.equal((await listTimers(process.env)).length, 0);

  process.env.ORKESTR_CODEX_BIN = await fakeCodex(home, true);
  assert.equal(await run("install", "fitness-tracker", "--timezone", "Europe/Berlin"), 0);
  assert.match(out.stdout, /Installed\.\nfitness-tracker {2}installed {2}setup_/);
  assert.match(out.stdout, /WhatsApp is not connected/);
  assert.equal(await run("install", "fitness-tracker"), 0);
  assert.match(out.stdout, /Already installed; nothing changed\./);
  assert.equal((await listTimers(process.env)).length, 2);

  out.stdout = "";
  assert.equal(await run("status", "--json"), 0);
  const status = JSON.parse(out.stdout);
  assert.equal(status.instances[0].health.thread, "active");
  assert.equal(status.instances[0].health.whatsapp, "not_bound");

  out.stdout = "";
  assert.equal(await run("uninstall", "fitness-tracker"), 0);
  assert.match(out.stdout, /Uninstalled fitness-tracker\. Thread retired; check-ins: weekly-summary deleted, evening-check-in deleted\./);
  assert.match(out.stdout, /Records kept in /);
  assert.equal((await listTimers(process.env)).length, 0);
  assert.equal(await run("uninstall", "fitness-tracker"), 0);
  assert.match(out.stdout, /fitness-tracker is not installed; nothing changed\./);
});
