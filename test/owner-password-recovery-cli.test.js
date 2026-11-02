import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { createOwnerLogin, verifyOwnerLogin } from "../packages/core/src/owner-login.js";

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text() { return text; } };
}

// A minimal non-TTY stdin that yields one line, like a piped `--stdin`.
function stdinOf(value) {
  const stream = new EventEmitter();
  stream.isTTY = false;
  stream.setEncoding = () => {};
  stream.resume = () => {
    queueMicrotask(() => {
      stream.emit("data", value);
      stream.emit("end");
    });
  };
  return stream;
}

async function home() {
  return fs.mkdtemp(path.join(os.tmpdir(), "orkestr-recover-cli-"));
}

test("orkestr security reset-owner-password resets a locked-out owner from --stdin without data loss", async () => {
  const env = { ORKESTR_HOME: await home(), ORKESTR_DISABLE_CLI_AUTH: "1" };
  await createOwnerLogin({ username: "owner", password: "forgotten-password" }, env);
  const before = JSON.parse(await fs.readFile(path.join(env.ORKESTR_HOME, "owner-login.json"), "utf8"));

  const stdout = capture();
  const stderr = capture();
  const code = await runCli(["security", "reset-owner-password", "owner", "--stdin"], {
    env,
    stdout,
    stderr,
    stdin: stdinOf("brand-new-password\n"),
  });

  assert.equal(code, 0, stderr.text());
  assert.match(stdout.text(), /Owner password reset for owner/);
  assert.ok(!stdout.text().includes("brand-new-password"), "the new password is never printed");
  assert.ok(!stderr.text().includes("brand-new-password"), "the new password is never logged");

  const after = JSON.parse(await fs.readFile(path.join(env.ORKESTR_HOME, "owner-login.json"), "utf8"));
  assert.equal(after.username, before.username, "the username is preserved");
  assert.equal(after.createdAt, before.createdAt, "existing data is preserved");
  assert.notEqual(after.passwordHash, before.passwordHash, "the hash is rotated");

  await assert.rejects(
    verifyOwnerLogin({ username: "owner", password: "forgotten-password", clientKey: "a" }, env),
    /owner_login_invalid/,
    "the forgotten password no longer works",
  );
  assert.ok(
    (await verifyOwnerLogin({ username: "owner", password: "brand-new-password", clientKey: "a" }, env)).token,
    "the recovered password logs in",
  );
});

test("orkestr security reset-owner-password refuses when no owner exists (no bootstrap)", async () => {
  const env = { ORKESTR_HOME: await home(), ORKESTR_DISABLE_CLI_AUTH: "1" };
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(["security", "reset-owner-password", "--stdin"], {
    env,
    stdout,
    stderr,
    stdin: stdinOf("whatever-password\n"),
  });
  assert.notEqual(code, 0);
  assert.match(stderr.text(), /owner_login_missing|no owner login/);
  // Nothing was created.
  await assert.rejects(fs.readFile(path.join(env.ORKESTR_HOME, "owner-login.json"), "utf8"));
});
