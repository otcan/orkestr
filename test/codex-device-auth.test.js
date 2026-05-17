import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startCodexDeviceAuth } from "../packages/connectors/src/codex.js";

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
