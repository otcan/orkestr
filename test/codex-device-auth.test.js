import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexLoginStatus, loginCodexWithApiKey, startCodexDeviceAuth } from "../packages/connectors/src/codex.js";

test("codex device auth parses browser URL and reuses an active session", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-auth-"));
  const fakeCodex = path.join(home, "codex");
  await fs.writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      "echo 'Follow these steps to sign in with ChatGPT using device code authorization:'",
      "echo 'https://auth.openai.com/codex/device'",
      "echo 'ABCD-1234'",
      "sleep 1",
    ].join("\n"),
    { mode: 0o755 },
  );

  const env = {
    ORKESTR_HOME: home,
    CODEX_HOME: path.join(home, "codex-home"),
    ORKESTR_CODEX_BIN: fakeCodex,
  };
  const first = await startCodexDeviceAuth({ env, home });
  const second = await startCodexDeviceAuth({ env, home });

  assert.equal(first.ok, true);
  assert.equal(first.authUrl, "https://auth.openai.com/codex/device");
  assert.equal(first.code, "ABCD-1234");
  assert.equal(second.startedAt, first.startedAt);
});

test("codex status creates missing Codex home before invoking CLI", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-home-create-"));
  const fakeCodex = path.join(home, "codex");
  await fs.writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      "set -eu",
      "test -d \"$CODEX_HOME\"",
      "echo 'Not logged in'",
    ].join("\n"),
    { mode: 0o755 },
  );
  const codexHome = path.join(home, "missing-codex-home");
  const env = {
    ORKESTR_HOME: home,
    CODEX_HOME: codexHome,
    ORKESTR_CODEX_BIN: fakeCodex,
  };

  const status = await codexLoginStatus({ env, home });
  const stat = await fs.stat(codexHome);

  assert.equal(status.available, true);
  assert.equal(status.connected, false);
  assert.equal(stat.isDirectory(), true);
});

test("codex API key login writes Codex auth through the CLI", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-api-key-"));
  const fakeCodex = path.join(home, "codex");
  await fs.writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      "set -eu",
      "mkdir -p \"$CODEX_HOME\"",
      "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then",
      "  if [ -f \"$CODEX_HOME/api-key-login\" ]; then echo 'Logged in using API key'; else echo 'Not logged in'; fi",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"--with-api-key\" ]; then",
      "  read key",
      "  test -n \"$key\"",
      "  echo ok > \"$CODEX_HOME/api-key-login\"",
      "  echo 'Logged in using API key'",
      "  exit 0",
      "fi",
      "echo unexpected \"$@\" >&2",
      "exit 2",
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = {
    ORKESTR_HOME: home,
    CODEX_HOME: path.join(home, "codex-home"),
    ORKESTR_CODEX_BIN: fakeCodex,
  };

  const before = await codexLoginStatus({ env, home });
  const result = await loginCodexWithApiKey("sk-test", { env, home });
  const after = await codexLoginStatus({ env, home });

  assert.equal(before.connected, false);
  assert.equal(result.ok, true);
  assert.equal(result.authMode, "api_key");
  assert.equal(after.connected, true);
  assert.equal(after.authMode, "api_key");
});
