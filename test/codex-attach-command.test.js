import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexResumeCommand, codexRuntimeCommand } from "../packages/core/src/codex-attach-command.js";
import { writeRuntimeSettings } from "../packages/core/src/runtime-settings.js";

test("codex resume attach uses the configured runtime command", async () => {
  const env = {
    ORKESTR_RUNTIME_CODEX_COMMAND: "/opt/orkestr/codex-cli/node_modules/.bin/codex --sandbox workspace-write --ask-for-approval on-request --no-alt-screen",
  };

  const command = await codexResumeCommand({
    cwd: "/work/repo",
    codexThreadId: "thread-123",
    env,
  });

  assert.equal(
    command,
    "/opt/orkestr/codex-cli/node_modules/.bin/codex --sandbox workspace-write --ask-for-approval on-request --no-alt-screen resume -C '/work/repo' 'thread-123'"
  );
});

test("codex resume attach strips legacy skip git repo check by default", async () => {
  const env = {
    ORKESTR_RUNTIME_CODEX_COMMAND: "/opt/orkestr/codex-cli/node_modules/.bin/codex --skip-git-repo-check --sandbox workspace-write --ask-for-approval on-request --no-alt-screen",
  };

  const command = await codexResumeCommand({
    cwd: "/work/repo",
    codexThreadId: "thread-123",
    env,
  });

  assert.equal(
    command,
    "/opt/orkestr/codex-cli/node_modules/.bin/codex --sandbox workspace-write --ask-for-approval on-request --no-alt-screen resume -C '/work/repo' 'thread-123'"
  );
});

test("codex resume attach can keep legacy skip git repo check when opted in", async () => {
  const env = {
    ORKESTR_CODEX_KEEP_LEGACY_SKIP_GIT_REPO_CHECK: "1",
    ORKESTR_RUNTIME_CODEX_COMMAND: "/opt/orkestr/codex-cli/node_modules/.bin/codex --skip-git-repo-check --sandbox workspace-write --ask-for-approval on-request --no-alt-screen",
  };

  const command = await codexResumeCommand({
    cwd: "/work/repo",
    codexThreadId: "thread-123",
    env,
  });

  assert.equal(
    command,
    "/opt/orkestr/codex-cli/node_modules/.bin/codex --skip-git-repo-check --sandbox workspace-write --ask-for-approval on-request --no-alt-screen resume -C '/work/repo' 'thread-123'"
  );
});

test("codex runtime command can fall back to the configured Codex binary", async () => {
  const command = await codexRuntimeCommand({
    ORKESTR_CODEX_BIN: "/opt/orkestr/codex-cli/node_modules/.bin/codex",
    ORKESTR_CODEX_SANDBOX: "danger-full-access",
    ORKESTR_CODEX_APPROVAL_POLICY: "never",
  });

  assert.equal(command, "/opt/orkestr/codex-cli/node_modules/.bin/codex --dangerously-bypass-approvals-and-sandbox");
});

test("codex resume attach can read the persisted runtime command", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-attach-"));
  const env = { ORKESTR_HOME: home };
  await writeRuntimeSettings({
    codex: {
      command: "/tmp/orkestr-codex-cli/node_modules/.bin/codex --sandbox workspace-write --ask-for-approval on-request --no-alt-screen",
    },
  }, env);

  const command = await codexResumeCommand({
    cwd: "/repo/with space",
    codexThreadId: "abc'def",
    env,
  });

  assert.equal(
    command,
    "/tmp/orkestr-codex-cli/node_modules/.bin/codex --sandbox workspace-write --ask-for-approval on-request --no-alt-screen resume -C '/repo/with space' 'abc'\\''def'"
  );
});

test("codex resume attach reports disabled Codex runtime", async () => {
  await assert.rejects(
    codexResumeCommand({
      cwd: "/work/repo",
      codexThreadId: "thread-123",
      env: { ORKESTR_RUNTIME_CODEX_COMMAND: "__orkestr_codex_disabled_on_macos__" },
    }),
    /codex_runtime_command_disabled/
  );
});
