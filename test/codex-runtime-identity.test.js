import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexRuntimeOwner, setCodexRuntimeIdentityHooksForTest } from "../packages/core/src/codex-runtime-identity.js";
import { codexVaultTokenFile, issueCodexVaultTurnToken, readCodexVaultTurnToken } from "../packages/core/src/vault-codex-turn-tokens.js";
import { revokeVaultThreadTokens } from "../packages/core/src/vault-thread-tokens.js";

// Simulates a root Orkestr server whose external Codex app-server unit runs
// as a different, unprivileged user. Synthetic users, units and ids only.

let home;
let passwdFile;
let systemctlCalls;
let chowns;

function simulateRoot({ unitUser = "codex-runtime", chownError = null } = {}) {
  systemctlCalls = [];
  chowns = [];
  setCodexRuntimeIdentityHooksForTest({
    getuid: () => 0,
    passwdFile,
    async execFile(command, args) {
      systemctlCalls.push([command, ...args]);
      return { stdout: `${unitUser}\n` };
    },
    async chown(target, uid, gid) {
      if (chownError) throw chownError;
      chowns.push({ target, uid, gid });
    },
  });
}

test.before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-runtime-identity-"));
  passwdFile = path.join(home, "passwd");
  await fs.writeFile(passwdFile, [
    "root:x:0:0:root:/root:/bin/sh",
    "orkestr-home:x:2001:2001::/srv/example:/bin/sh",
    "codex-runtime:x:2345:2346::/srv/example-runtime:/bin/sh",
    "run-user:x:2400:2401::/srv/example-run:/bin/sh",
    "",
  ].join("\n"));
});

test.afterEach(() => setCodexRuntimeIdentityHooksForTest());

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const external = { ORKESTR_CODEX_APP_SERVER_MODE: "external", ORKESTR_CODEX_APP_SERVER_SERVICE_NAME: "example-codex" };

test("root server hands vault turn token files to the Codex unit's user", async () => {
  simulateRoot();
  const env = { ...process.env, ...external, ORKESTR_HOME: path.join(home, "orkestr"), ORKESTR_RUN_USER: "run-user" };
  delete env.ORKESTR_CODEX_RUNTIME_USER;
  assert.ok(await issueCodexVaultTurnToken({ threadId: "thread-a", codexThreadId: "thr_runtime" }, env));

  const file = codexVaultTokenFile("thr_runtime", env.ORKESTR_HOME);
  const dir = path.dirname(file);
  assert.deepEqual(systemctlCalls[0], ["systemctl", "show", "example-codex", "-p", "User", "--value"]);
  assert.ok(chowns.length >= 2);
  assert.ok(chowns.every((entry) => entry.uid === 2345 && entry.gid === 2346), "runtime user, not ORKESTR_HOME owner or ORKESTR_RUN_USER");
  assert.equal(chowns[0].target, dir);
  assert.ok(chowns.some((entry) => path.dirname(entry.target) === dir && entry.target.startsWith(`${file}.`)), "file chowned before it becomes visible");
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.match(await readCodexVaultTurnToken({ CODEX_THREAD_ID: "thr_runtime" }, env.ORKESTR_HOME), /^ovt_/);
});

test("runtime user resolution: explicit setting, unit User=, ORKESTR_RUN_USER, and no-ops", async () => {
  simulateRoot();
  assert.equal((await codexRuntimeOwner({ ...external, ORKESTR_CODEX_RUNTIME_USER: "run-user" })).uid, 2400, "explicit setting wins");
  assert.equal(systemctlCalls.length, 0);
  assert.equal((await codexRuntimeOwner({ ...external, ORKESTR_CODEX_RUNTIME_USER: "2345" })).user, "codex-runtime", "numeric uid accepted");

  simulateRoot({ unitUser: "" });
  assert.equal((await codexRuntimeOwner({ ...external, ORKESTR_RUN_USER: "run-user" })).uid, 2400, "falls back to ORKESTR_RUN_USER");
  simulateRoot({ unitUser: "root" });
  assert.equal(await codexRuntimeOwner(external), null, "a root runtime needs no handover");
  simulateRoot({ unitUser: "missing-user" });
  assert.equal(await codexRuntimeOwner(external), null);
  simulateRoot();
  assert.equal(await codexRuntimeOwner({ ORKESTR_RUN_USER: "run-user" }), null, "self-spawned stdio app-server runs as the server");

  setCodexRuntimeIdentityHooksForTest({ getuid: () => 2001, passwdFile });
  assert.equal(await codexRuntimeOwner({ ...external, ORKESTR_CODEX_RUNTIME_USER: "codex-runtime" }), null, "non-root server cannot chown");
});

test("a failed handover issues no readable token file", async () => {
  simulateRoot({ chownError: Object.assign(new Error("EPERM"), { code: "EPERM" }) });
  const env = { ...process.env, ...external, ORKESTR_HOME: path.join(home, "orkestr-fail") };
  await assert.rejects(issueCodexVaultTurnToken({ threadId: "thread-a", codexThreadId: "thr_fail" }, env), { code: "EPERM" });
  const dir = path.dirname(codexVaultTokenFile("thr_fail", env.ORKESTR_HOME));
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(await revokeVaultThreadTokens({ threadId: "thread-a" }, env), 0, "the issued token was revoked");
});
