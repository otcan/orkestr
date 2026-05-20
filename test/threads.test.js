import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { startServer } from "../apps/server/src/server.js";
import { threadRuntimeSummary } from "../apps/server/src/thread-summary.ts";
import { runNextThreadMessage } from "../packages/core/src/executors.js";
import { applyRuntimeCodexMode, consumeThreadConnectorDeliverySignalCount, deliverPendingThreadInputs, drainAllPendingThreadInputs, hardResetThreadRuntime, listRuntimeLeases, resetThreadRuntime, runtimeStatus, sleepThread, syncRuntimeLeases, syncRuntimeWindowName, wakeThread } from "../packages/core/src/runtime-leases.js";
import { ensureDataDirs } from "../packages/storage/src/paths.js";
import { parseThreadInputCommand } from "../packages/core/src/thread-commands.js";
import { createThreadWorker, detectThreadGitState, listThreadWorkers, syncThreadWorkerWithParent, updateThreadRepo } from "../packages/core/src/thread-workers.js";
import { appendThreadMessage, createThread, deleteThread, enqueueThreadInput, getThread, listThreadMessages, listThreads, updateThread, updateThreadMessage } from "../packages/core/src/threads.js";

const execFileAsync = promisify(execFile);

async function createTempGitRepo(prefix = "orkestr-worker-repo-") {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "orkestr@example.test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Orkestr Test"], { cwd: repo });
  await fs.writeFile(path.join(repo, "README.md"), "# test repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function createFakeTmux(home) {
  const bin = path.join(home, "bin");
  const log = path.join(home, "tmux.log");
  const state = path.join(home, "tmux.sessions");
  await fs.mkdir(bin, { recursive: true });
  const tmuxPath = path.join(bin, "tmux");
  await fs.writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
set -euo pipefail
{
  printf '__CALL__'
  for arg in "$@"; do printf '\\t%s' "$arg"; done
  printf '\\n'
} >> "$TMUX_LOG"

cmd="\${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
valid_panes="\${TMUX_VALID_PANES:-%42}"
target_from_args() {
  local target=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-t" ]; then target="\${2:-}"; shift 2; else shift; fi
  done
  printf '%s' "$target"
}
literal_from_args() {
  local literal=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-l" ]; then literal="\${2:-}"; shift 2; else shift; fi
  done
  printf '%s' "$literal"
}
pane_exists() {
  local target="$1"
  if [ -z "$target" ]; then return 0; fi
  printf '%s\\n' $valid_panes | grep -Fxq "$target"
}
require_pane() {
  local target="$1"
  if ! pane_exists "$target"; then
    printf "can't find pane: %s\\n" "$target" >&2
    exit 1
  fi
}
case "$cmd" in
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-t" ]; then target="\${2:-}"; shift 2; else shift; fi
    done
    if [ -f "$TMUX_STATE" ] && grep -Fxq "$target" "$TMUX_STATE"; then exit 0; fi
    exit 1
    ;;
  new-session)
    session=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-s" ]; then session="\${2:-}"; shift 2; else shift; fi
    done
    if [ -n "$session" ]; then printf '%s\\n' "$session" >> "$TMUX_STATE"; fi
    exit 0
    ;;
  kill-session)
    target=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-t" ]; then target="\${2:-}"; shift 2; else shift; fi
    done
    if [ -n "$target" ] && [ -f "$TMUX_STATE" ]; then
      grep -Fxv "$target" "$TMUX_STATE" > "$TMUX_STATE.tmp" || true
      mv "$TMUX_STATE.tmp" "$TMUX_STATE"
    fi
    exit 0
    ;;
  list-panes)
    printf '%s\\n' $valid_panes
    exit 0
    ;;
  capture-pane)
    if [ -n "\${TMUX_CAPTURE_FILE:-}" ] && [ -f "\${TMUX_CAPTURE_FILE:-}" ]; then
      cat "\${TMUX_CAPTURE_FILE:-}"
    else
      printf '%s\\n' "\${TMUX_CAPTURE_TEXT:-› }"
    fi
    exit 0
    ;;
  load-buffer)
    file=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-b" ]; then shift 2; else file="$1"; shift; fi
    done
    if [ -n "\${TMUX_LOADED_BUFFER_CAPTURE:-}" ] && [ -f "$file" ]; then
      {
        printf '__BUFFER__\\n'
        cat "$file"
        printf '\\n__END_BUFFER__\\n'
      } >> "$TMUX_LOADED_BUFFER_CAPTURE"
    fi
    exit 0
    ;;
  send-keys)
    require_pane "$(target_from_args "$@")"
    literal="$(literal_from_args "$@")"
    if [ -n "\${TMUX_SEND_KEYS_LITERAL_MAX:-}" ] && [ -n "$literal" ] && [ "\${#literal}" -gt "\${TMUX_SEND_KEYS_LITERAL_MAX:-0}" ]; then
      printf 'tmux send-keys literal too long: %s > %s\\n' "\${#literal}" "$TMUX_SEND_KEYS_LITERAL_MAX" >&2
      exit 1
    fi
    for arg in "$@"; do
      if [ "$arg" = "Escape" ] && [ -n "\${TMUX_CAPTURE_AFTER_ESCAPE_FILE:-}" ] && [ -n "\${TMUX_CAPTURE_FILE:-}" ]; then
        cp "\${TMUX_CAPTURE_AFTER_ESCAPE_FILE:-}" "\${TMUX_CAPTURE_FILE:-}"
      fi
      if [ "$arg" = "BTab" ] && [ -n "\${TMUX_CAPTURE_AFTER_BTAB_FILE:-}" ] && [ -n "\${TMUX_CAPTURE_FILE:-}" ]; then
        cp "\${TMUX_CAPTURE_AFTER_BTAB_FILE:-}" "\${TMUX_CAPTURE_FILE:-}"
      fi
      if [ "$arg" = "C-m" ] && [ -n "\${TMUX_CAPTURE_AFTER_ENTER_FILE:-}" ] && [ -n "\${TMUX_CAPTURE_FILE:-}" ]; then
        cp "\${TMUX_CAPTURE_AFTER_ENTER_FILE:-}" "\${TMUX_CAPTURE_FILE:-}"
      fi
    done
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
    "utf8",
  );
  await fs.chmod(tmuxPath, 0o755);
  return { bin, log, state };
}

function restoreEnvValue(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

process.env.ORKESTR_CODEX_AUTH_PREFLIGHT ||= "0";

test("threads are the primary routable runtime object", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-threads-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({ id: "demo-thread", name: "Demo Thread", executorId: "noop" }, env);
  const input = await enqueueThreadInput("demo-thread", { text: "hello thread" }, env);
  const execution = await runNextThreadMessage("demo-thread", {}, env);
  const threads = await listThreads(env);
  const messages = await listThreadMessages("demo-thread", env);

  assert.equal(thread.id, "demo-thread");
  assert.equal(input.state, "queued");
  assert.equal(execution.state, "completed");
  assert.equal(threads[0].state, "ready");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].state, "completed");
  assert.equal(messages[1].role, "assistant");
});

test("thread creation reuses an existing visible agent name", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-name-dedupe-"));
  const env = { ORKESTR_HOME: home };

  const first = await createThread({ id: "test-old", name: "TEST", codexModel: "gpt-5.5" }, env);
  const second = await createThread({ id: "test-new", name: "TEST", cwd: "/workspace/test-path" }, env);
  const threads = await listThreads(env);

  assert.equal(second.id, first.id);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, "test-old");
  assert.equal(threads[0].codexModel, "gpt-5.5");
});

test("threads can be deleted with their workers and stored messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-delete-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "delete-parent", name: "Delete Parent" }, env);
  await createThread({ id: "delete-worker", name: "Delete Worker", parentThreadId: "delete-parent", rootThreadId: "delete-parent" }, env);
  await appendThreadMessage("delete-parent", { role: "assistant", text: "parent message" }, env);
  await appendThreadMessage("delete-worker", { role: "assistant", text: "worker message" }, env);

  await assert.rejects(() => deleteThread("delete-parent", {}, env), /thread_has_workers/);
  const result = await deleteThread("delete-parent", { deleteWorkers: true }, env);
  const threads = await listThreads(env);
  const parentMessages = await listThreadMessages("delete-parent", env);
  const workerMessages = await listThreadMessages("delete-worker", env);

  assert.equal(result.deletedCount, 2);
  assert.deepEqual(threads, []);
  assert.deepEqual(parentMessages, []);
  assert.deepEqual(workerMessages, []);
});

test("threads default to wake-on-message and sleep without a runtime lease", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-sleeping-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({ id: "sleeping-thread", name: "Sleeping Thread" }, env);
  const status = await runtimeStatus("sleeping-thread", env);

  assert.equal(thread.wakePolicy, "wake-on-message");
  assert.equal(status.state, "sleeping");
  assert.equal(status.promptReady, false);
  assert.equal(status.hibernated, true);
});

test("thread wake and sleep lifecycle updates runtime leases and status", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-wake-sleep-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
    };
    await createThread({ id: "cycle-thread", name: "Cycle Thread" }, env);

    const woken = await wakeThread("cycle-thread", { reason: "test_wake" }, env);
    let status = await runtimeStatus("cycle-thread", env);
    let leases = await listRuntimeLeases(env);

    assert.equal(woken.reused, false);
    assert.equal(woken.thread.state, "ready");
    assert.equal(status.state, "ready");
    assert.equal(status.runtimeState, "live");
    assert.equal(status.hibernated, false);
    assert.equal(leases.length, 1);
    assert.equal(leases[0].threadId, "cycle-thread");
    assert.equal(leases[0].reason, "test_wake");
    assert.equal(leases[0].endedAt, undefined);

    const slept = await sleepThread("cycle-thread", { reason: "test_sleep" }, env);
    status = await runtimeStatus("cycle-thread", env);
    leases = await listRuntimeLeases(env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(slept.slept, 1);
    assert.equal(slept.thread.state, "sleeping");
    assert.equal(slept.thread.activeRuntimeLeaseId, null);
    assert.equal(status.state, "sleeping");
    assert.equal(status.runtimeState, "none");
    assert.equal(status.hibernated, true);
    assert.equal(leases[0].endReason, "test_sleep");
    assert.ok(leases[0].endedAt);
    assert.match(log, /__CALL__\tkill-session\t-t\torkestr-cycle-thread/);

    const sleptAgain = await sleepThread("cycle-thread", { reason: "test_sleep_again" }, env);
    assert.equal(sleptAgain.slept, 0);
    assert.equal(sleptAgain.thread.state, "sleeping");
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
  }
});

test("relative thread workspaces resolve under the runtime workspace root", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-relative-workspace-"));
  const fakeTmux = await createFakeTmux(home);
  const workspaceRoot = path.join(home, "workspace-root");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      ORKESTR_RUNTIME_WORKSPACE_ROOT: workspaceRoot,
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
    };
    await createThread({ id: "relative-workspace-thread", name: "Relative Workspace Thread", cwd: "test" }, env);
    await fs.writeFile(fakeTmux.state, "orkestr-relative-workspace-thread\n", "utf8");
    await wakeThread("relative-workspace-thread", { reason: "test" }, env);
    const leases = await listRuntimeLeases(env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(leases[0].workspace, path.join(workspaceRoot, "test"));
    assert.match(log, /__CALL__\tkill-session\t-t\torkestr-relative-workspace-thread/);
    assert.match(log, /__CALL__\tnew-session\t-d\t-s\torkestr-relative-workspace-thread\t-c\t/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
  }
});

test("thread wake blocks Codex before the raw login menu opens", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-codex-auth-required-"));
  const fakeTmux = await createFakeTmux(home);
  await fs.writeFile(
    path.join(fakeTmux.bin, "codex"),
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo 'Not logged in'; exit 0; fi",
      "echo raw-codex-started >> \"$TMUX_LOG\"",
    ].join("\n"),
    { mode: 0o755 },
  );
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      ORKESTR_CODEX_AUTH_PREFLIGHT: "1",
    };
    await createThread({ id: "auth-required-thread", name: "Auth Required Thread" }, env);

    await assert.rejects(
      () => wakeThread("auth-required-thread", { reason: "test_wake" }, env),
      (error) => {
        assert.equal(error.code, "codex_auth_required");
        assert.equal(error.statusCode, 428);
        assert.match(error.message, /\/setup\/codex/);
        return true;
      },
    );
    const log = await fs.readFile(fakeTmux.log, "utf8").catch(() => "");
    const thread = (await listThreads(env)).find((item) => item.id === "auth-required-thread");
    assert.doesNotMatch(log, /new-session/);
    assert.doesNotMatch(log, /raw-codex-started/);
    assert.equal(thread.state, "sleeping");
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
  }
});

test("queued stop commands kill the active runtime and complete locally", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-stop-command-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
    };
    await createThread({ id: "stop-command-thread", name: "Stop Command Thread" }, env);
    await wakeThread("stop-command-thread", { reason: "test" }, env);
    const command = await enqueueThreadInput("stop-command-thread", { text: "/stop", source: "whatsapp_inbound" }, env);

    assert.deepEqual(await deliverPendingThreadInputs("stop-command-thread", env), [command.id]);
    const status = await runtimeStatus("stop-command-thread", env);
    const messages = await listThreadMessages("stop-command-thread", env);
    const stopped = messages.find((message) => message.id === command.id);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(status.state, "sleeping");
    assert.equal(stopped.state, "completed");
    assert.equal(stopped.deliveryState, "delivered");
    assert.equal(stopped.observedVia, "orkestr_stop_command");
    assert.match(log, /__CALL__\tkill-session\t-t\torkestr-stop-command-thread/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
  }
});

test("runtime sync auto-sleeps stable idle ready runtimes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-auto-sleep-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      ORKESTR_RUNTIME_IDLE_SLEEP_MS: "1",
    };
    await createThread({ id: "idle-thread", name: "Idle Thread" }, env);
    await wakeThread("idle-thread", { reason: "test_wake" }, env);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await syncRuntimeLeases(env);

    const status = await runtimeStatus("idle-thread", env);
    const leases = await listRuntimeLeases(env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(status.state, "sleeping");
    assert.equal(status.hibernated, true);
    assert.equal(leases[0].endReason, "idle_auto_sleep");
    assert.ok(Number(leases[0].idleMs || 0) >= 1);
    assert.match(log, /__CALL__\tkill-session\t-t\torkestr-idle-thread/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
  }
});

test("runtime sync confirms Codex resume directory prompts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-resume-dir-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorTmuxCaptureText = process.env.TMUX_CAPTURE_TEXT;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_TEXT = [
    "Choose working directory to resume this session",
    "",
    "› 1. Use session directory (/root)",
    "  2. Use current directory",
    "  Press enter to continue",
  ].join("\n");

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_TEXT: process.env.TMUX_CAPTURE_TEXT,
      ORKESTR_RUNTIME_IDLE_SLEEP_MS: "1",
    };
    await createThread({
      id: "resume-dir-thread",
      name: "Resume Dir Thread",
      executor: { type: "codex", codexThreadId: "codex-resume-thread" },
    }, env);
    await wakeThread("resume-dir-thread", { reason: "test_wake" }, env);

    let status = await runtimeStatus("resume-dir-thread", env);
    assert.equal(status.state, "waking");
    assert.equal(status.needsResumeDirectoryConfirmation, true);

    await syncRuntimeLeases(env);

    status = await runtimeStatus("resume-dir-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");
    assert.equal(status.state, "waking");
    assert.match(log, /resume -C .*resume-dir-thread'? '?codex-resume-thread'?/);
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\t2\tC-m/);
    assert.doesNotMatch(log, /__CALL__\tkill-session\t-t\torkestr-resume-dir-thread/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_TEXT", priorTmuxCaptureText);
  }
});

test("runtime sync skips Codex update prompts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-codex-update-prompt-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorTmuxCaptureText = process.env.TMUX_CAPTURE_TEXT;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_TEXT = [
    "✨ Update available! 0.130.0 -> 0.131.0",
    "",
    "› 1. Update now (runs `npm install -g @openai/codex`)",
    "  2. Skip",
    "  3. Skip until next version",
    "",
    "  Press enter to continue",
  ].join("\n");

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_TEXT: process.env.TMUX_CAPTURE_TEXT,
      ORKESTR_RUNTIME_IDLE_SLEEP_MS: "1",
    };
    await createThread({ id: "codex-update-thread", name: "Codex Update Thread" }, env);
    await wakeThread("codex-update-thread", { reason: "test_wake" }, env);

    let status = await runtimeStatus("codex-update-thread", env);
    assert.equal(status.state, "waking");
    assert.equal(status.needsCodexUpdatePromptSkip, true);

    await syncRuntimeLeases(env);

    status = await runtimeStatus("codex-update-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");
    assert.equal(status.state, "waking");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\t3\tC-m/);
    assert.doesNotMatch(log, /__CALL__\tkill-session\t-t\torkestr-codex-update-thread/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_TEXT", priorTmuxCaptureText);
  }
});

test("runtime status ignores stale Codex update prompts in scrollback", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-codex-update-scrollback-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorTmuxCaptureText = process.env.TMUX_CAPTURE_TEXT;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_TEXT = [
    "✨ Update available! 0.130.0 -> 0.131.0",
    "› 1. Update now (runs `npm install -g @openai/codex`)",
    "  2. Skip",
    "  3. Skip until next version",
    "  Press enter to continue",
    "",
    "╭─────────────────────────────────────────╮",
    "│ >_ OpenAI Codex (v0.130.0)              │",
    "╰─────────────────────────────────────────╯",
    "",
    "›",
    "",
    "  gpt-5.5 default · /workspace/test",
    "›",
  ].join("\n");

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_TEXT: process.env.TMUX_CAPTURE_TEXT,
    };
    await createThread({ id: "codex-update-scrollback-thread", name: "Codex Update Scrollback Thread" }, env);
    await wakeThread("codex-update-scrollback-thread", { reason: "test_wake" }, env);

    const status = await runtimeStatus("codex-update-scrollback-thread", env);

    assert.equal(status.needsCodexUpdatePromptSkip, false);
    assert.equal(status.promptReady, true);
    assert.equal(status.state, "ready");
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_TEXT", priorTmuxCaptureText);
  }
});

test("runtime status ignores stale Codex update prompt text above a live input prompt", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-codex-update-stale-near-prompt-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorTmuxCaptureText = process.env.TMUX_CAPTURE_TEXT;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_TEXT = [
    "✨ Update available! 0.130.0 -> 0.131.0",
    "  3. Skip until next version",
    "  Press enter to continue",
    "›",
    "  gpt-5.5 xhigh · /workspace/test",
  ].join("\n");

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_TEXT: process.env.TMUX_CAPTURE_TEXT,
    };
    await createThread({ id: "codex-update-stale-near-prompt-thread", name: "Codex Update Stale Near Prompt Thread" }, env);
    await wakeThread("codex-update-stale-near-prompt-thread", { reason: "test_wake" }, env);

    const status = await runtimeStatus("codex-update-stale-near-prompt-thread", env);

    assert.equal(status.needsCodexUpdatePromptSkip, false);
    assert.equal(status.promptReady, true);
    assert.equal(status.state, "ready");
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_TEXT", priorTmuxCaptureText);
  }
});

test("runtime sync does not auto-sleep pending or working runtimes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-auto-sleep-guards-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorTmuxCaptureText = process.env.TMUX_CAPTURE_TEXT;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      ORKESTR_RUNTIME_IDLE_SLEEP_MS: "1",
    };
    process.env.TMUX_CAPTURE_TEXT = "› ";
    await createThread({ id: "pending-thread", name: "Pending Thread" }, env);
    await wakeThread("pending-thread", { reason: "test_wake" }, env);
    await appendThreadMessage("pending-thread", { role: "user", text: "queued work", state: "queued" }, env);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await syncRuntimeLeases(env);

    let status = await runtimeStatus("pending-thread", env);
    let leases = await listRuntimeLeases(env);
    assert.notEqual(status.state, "sleeping");
    assert.equal(status.pendingCount, 1);
    assert.equal(leases.find((lease) => lease.threadId === "pending-thread")?.endedAt, undefined);

    process.env.TMUX_CAPTURE_TEXT = "• Working (1s)";
    await createThread({ id: "working-thread", name: "Working Thread" }, env);
    await wakeThread("working-thread", { reason: "test_wake" }, env);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await syncRuntimeLeases(env);

    status = await runtimeStatus("working-thread", env);
    leases = await listRuntimeLeases(env);
    assert.equal(status.state, "working");
    assert.equal(status.working, true);
    assert.equal(leases.find((lease) => lease.threadId === "working-thread")?.endedAt, undefined);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_TEXT", priorTmuxCaptureText);
  }
});

test("thread runtimes name the tmux window after the thread for byobu", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-tmux-title-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
    };
    await createThread({ id: "demo-thread", name: "Demo Thread With A Readable Name" }, env);

    const woken = await wakeThread("demo-thread", { reason: "test" }, env);
    await updateThread("demo-thread", { name: "Renamed Thread" }, env);
    const synced = await syncRuntimeWindowName("demo-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(woken.lease.windowName, "Demo Thread With A Readable Name");
    assert.equal(woken.status.windowName, "Demo Thread With A Readable Name");
    assert.deepEqual(synced, { sessionName: "orkestr-demo-thread", windowName: "Renamed Thread" });
    assert.match(log, /__CALL__\tset-window-option\t-t\torkestr-demo-thread\tautomatic-rename\toff/);
    assert.match(log, /__CALL__\tset-window-option\t-t\torkestr-demo-thread\tallow-rename\toff/);
    assert.match(log, /__CALL__\trename-window\t-t\torkestr-demo-thread\tDemo Thread With A Readable Name/);
    assert.match(log, /__CALL__\trename-window\t-t\torkestr-demo-thread\tRenamed Thread/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
  }
});

test("runtime status keeps delivered Codex input processing until prompt returns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-processing-status-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorTmuxCaptureText = process.env.TMUX_CAPTURE_TEXT;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
    };
    await createThread({ id: "processing-thread", name: "Processing Thread" }, env);
    await wakeThread("processing-thread", { reason: "test" }, env);
    process.env.TMUX_CAPTURE_TEXT = "Codex is still preparing a response";
    await updateThread("processing-thread", { state: "working" }, env);

    const busy = await runtimeStatus("processing-thread", env);

    assert.equal(busy.state, "working");
    assert.equal(busy.working, true);

    process.env.TMUX_CAPTURE_TEXT = "> ";
    const ready = await runtimeStatus("processing-thread", env);

    assert.equal(ready.state, "ready");
    assert.equal(ready.working, false);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_TEXT", priorTmuxCaptureText);
  }
});

test("thread runtime summary exposes lightweight pane progress", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-progress-summary-"));
  const fakeTmux = await createFakeTmux(home);
  const priorHome = process.env.ORKESTR_HOME;
  const priorRuntimeHome = process.env.HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorTmuxCaptureText = process.env.TMUX_CAPTURE_TEXT;
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.HOME = path.join(home, "runtime-home");
  process.env.CODEX_HOME = path.join(home, "codex-home");
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_TEXT = "◦ Working (2s • esc to interrupt)\n";

  try {
    await createThread({ id: "progress-summary-thread", name: "Progress Summary Thread" });
    const woken = await wakeThread("progress-summary-thread", { reason: "test" });
    const status = await runtimeStatus("progress-summary-thread");
    const summary = await threadRuntimeSummary(woken.thread, await listThreadMessages("progress-summary-thread"));

    assert.equal(status.progress.summary, "Working");
    assert.equal(status.progress.stateHint, "working");
    assert.equal(summary.progressSummary, "Working");
    assert.equal(summary.progressStateHint, "working");
    assert.deepEqual(summary.progressTailLines, ["◦ Working (2s • esc to interrupt)"]);
  } finally {
    restoreEnvValue("ORKESTR_HOME", priorHome);
    restoreEnvValue("HOME", priorRuntimeHome);
    restoreEnvValue("CODEX_HOME", priorCodexHome);
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_TEXT", priorTmuxCaptureText);
  }
});

test("runtime status ignores prose mentioning interrupt keys above a live prompt", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-prose-interrupt-key-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorTmuxCaptureText = process.env.TMUX_CAPTURE_TEXT;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_TEXT = [
    "The weak spot is that the visible \"Waiting for background terminal ... esc to interrupt\" marker can scroll out.",
    "",
    "› Improve documentation in @filename",
    "",
    "  gpt-5.5 xhigh · /workspace/test",
  ].join("\n");

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_TEXT: process.env.TMUX_CAPTURE_TEXT,
    };
    await createThread({ id: "prose-interrupt-key-thread", name: "Prose Interrupt Key Thread" }, env);
    await wakeThread("prose-interrupt-key-thread", { reason: "test" }, env);

    const status = await runtimeStatus("prose-interrupt-key-thread", env);

    assert.equal(status.working, false);
    assert.equal(status.promptReady, true);
    assert.equal(status.state, "ready");
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_TEXT", priorTmuxCaptureText);
  }
});

test("runtime status reports visible background terminal work instead of ready", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-background-terminal-work-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorTmuxCaptureText = process.env.TMUX_CAPTURE_TEXT;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_TEXT = [
    "◦ Waiting for background terminal (45s • esc to interrupt)",
    "› Implement {feature}",
    "",
    "  gpt-5.5 xhigh · /workspace/test",
  ].join("\n");

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_TEXT: process.env.TMUX_CAPTURE_TEXT,
    };
    await createThread({ id: "background-terminal-work-thread", name: "Background Terminal Work Thread" }, env);
    await wakeThread("background-terminal-work-thread", { reason: "test" }, env);

    const status = await runtimeStatus("background-terminal-work-thread", env);

    assert.equal(status.state, "working");
    assert.equal(status.working, true);
    assert.equal(status.backgroundWork, true);
    assert.equal(status.foregroundWorking, false);
    assert.equal(status.typingActive, false);
    assert.equal(status.promptReady, true);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_TEXT", priorTmuxCaptureText);
  }
});

test("thread input delivery waits for runtime acknowledgement before completing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-delivery-ack-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    await fs.writeFile(captureFile, "\u203a \n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
    };
    await createThread({ id: "delivery-thread", name: "Delivery Thread" }, env);
    const input = await enqueueThreadInput("delivery-thread", { text: "hello delivery" }, env);

    assert.deepEqual(await deliverPendingThreadInputs("delivery-thread", env), []);
    let messages = await listThreadMessages("delivery-thread", env);
    let status = await runtimeStatus("delivery-thread", env);
    assert.equal(messages[0].state, "awaiting_ack");
    assert.equal(messages[0].deliveryState, "awaiting_ack");
    assert.equal(messages[0].deliveryAttempt, 1);
    assert.equal(status.pendingCount, 1);
    assert.equal(status.awaitingAckCount, 1);

    await updateThreadMessage("delivery-thread", input.id, { deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString() }, env);
    assert.deepEqual(await deliverPendingThreadInputs("delivery-thread", env), []);
    messages = await listThreadMessages("delivery-thread", env);
    assert.equal(messages[0].state, "awaiting_ack");
    assert.equal(messages[0].deliveryAttempt, 1);
    assert.equal(messages[0].deliveryAckCheckCount, 2);
    assert.equal(messages[0].deliveryState, "awaiting_ack_unobserved");

    await fs.writeFile(captureFile, "\u2022 Working (1s)\n", "utf8");
    await drainAllPendingThreadInputs(env);
    messages = await listThreadMessages("delivery-thread", env);
    status = await runtimeStatus("delivery-thread", env);
    assert.equal(messages[0].state, "completed");
    assert.equal(messages[0].deliveryState, "delivered");
    assert.equal(messages[0].observedVia, "runtime_working");
    assert.equal(status.awaitingAckCount, 0);

    const log = await fs.readFile(fakeTmux.log, "utf8");
    const submitCount = log.split("\n").filter((line) => line.includes("__CALL__\tsend-keys\t-t\t%42\tC-m")).length;
    assert.equal(submitCount, 1);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread input delivery closes stale ack when history already has an assistant reply", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-history-ack-"));
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr-home"),
    HOME: path.join(home, "runtime-home"),
    CODEX_HOME: path.join(home, "codex-home"),
  };
  await createThread({ id: "history-ack-thread", name: "History Ack Thread" }, env);
  const input = await appendThreadMessage("history-ack-thread", {
    role: "user",
    source: "whatsapp",
    text: "message that was already handled",
    state: "awaiting_ack",
    deliveryState: "awaiting_ack",
    createdAt: "2026-05-20T04:11:30.704Z",
  }, env);
  await appendThreadMessage("history-ack-thread", {
    role: "assistant",
    text: "Handled that message.",
    state: "completed",
    createdAt: "2026-05-20T04:12:00.000Z",
  }, env);

  assert.deepEqual(await deliverPendingThreadInputs("history-ack-thread", env), [input.id]);
  const messages = await listThreadMessages("history-ack-thread", env);

  assert.equal(messages[0].state, "completed");
  assert.equal(messages[0].deliveryState, "delivered");
  assert.equal(messages[0].observedVia, "assistant_after_input");
});

test("thread input delivery recovers a stale ready awaiting-ack runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-stale-ack-recovery-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    await fs.writeFile(captureFile, "\u203a \n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
      ORKESTR_DELIVERY_STALE_ACK_RECOVERY_ATTEMPTS: "2",
    };
    await createThread({ id: "stale-ack-thread", name: "Stale Ack Thread" }, env);
    const input = await enqueueThreadInput("stale-ack-thread", { text: "hello stale ack" }, env);

    assert.deepEqual(await deliverPendingThreadInputs("stale-ack-thread", env), []);
    await updateThreadMessage("stale-ack-thread", input.id, { deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString() }, env);
    assert.deepEqual(await deliverPendingThreadInputs("stale-ack-thread", env), []);
    await updateThreadMessage("stale-ack-thread", input.id, { deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString() }, env);
    assert.deepEqual(await deliverPendingThreadInputs("stale-ack-thread", env), []);

    const messages = await listThreadMessages("stale-ack-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(messages[0].state, "awaiting_ack");
    assert.equal(messages[0].deliveryAttempt, 2);
    assert.equal(messages.some((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted"), true);
    assert.match(log, /__CALL__\tkill-session\t-t\torkestr-stale-ack-thread/);
    assert.match(log, /__CALL__\tnew-session/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread input delivery submits a stable exact unsent prompt", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-stuck-prompt-grace-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const afterEnterFile = path.join(home, "pane-after-enter.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorCaptureAfterEnterFile = process.env.TMUX_CAPTURE_AFTER_ENTER_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.TMUX_CAPTURE_AFTER_ENTER_FILE = afterEnterFile;

  try {
    const text = "fresh stuck prompt should not fail immediately";
    await fs.writeFile(captureFile, `› ${text}\n  gpt-5.5 xhigh · /workspace/demo\n`, "utf8");
    await fs.writeFile(afterEnterFile, "\u2022 Working (1s)\n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      TMUX_CAPTURE_AFTER_ENTER_FILE: afterEnterFile,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
      ORKESTR_STUCK_PROMPT_FAIL_AFTER_MS: "30000",
      ORKESTR_UNSENT_PROMPT_STABLE_MS: "1",
    };
    await createThread({ id: "stuck-prompt-grace-thread", name: "Stuck Prompt Grace Thread" }, env);
    await wakeThread("stuck-prompt-grace-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("stuck-prompt-grace-thread", {
      role: "user",
      text,
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      deliveryAttempt: 1,
      deliveryFirstAttemptAt: new Date().toISOString(),
      deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("stuck-prompt-grace-thread", env), [input.id]);
    const messages = await listThreadMessages("stuck-prompt-grace-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");
    const delivered = messages.find((message) => message.id === input.id);

    assert.equal(delivered.state, "completed");
    assert.equal(delivered.deliveryState, "delivered");
    assert.equal(delivered.observedVia, "runtime_working");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tC-m/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("TMUX_CAPTURE_AFTER_ENTER_FILE", priorCaptureAfterEnterFile);
  }
});

test("thread input delivery does not submit an unsent prompt that changes during the stability wait", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-stuck-prompt-changing-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    const text = "changing prompt should not be submitted";
    await fs.writeFile(captureFile, `› ${text}\n  gpt-5.5 xhigh · /workspace/demo\n`, "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
      ORKESTR_STUCK_PROMPT_FAIL_AFTER_MS: "30000",
      ORKESTR_UNSENT_PROMPT_STABLE_MS: "30",
    };
    await createThread({ id: "stuck-prompt-changing-thread", name: "Stuck Prompt Changing Thread" }, env);
    await wakeThread("stuck-prompt-changing-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("stuck-prompt-changing-thread", {
      role: "user",
      text,
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      deliveryAttempt: 1,
      deliveryFirstAttemptAt: new Date().toISOString(),
      deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    }, env);

    const delivered = deliverPendingThreadInputs("stuck-prompt-changing-thread", env);
    setTimeout(() => {
      fs.writeFile(captureFile, `› ${text} plus more typing\n  gpt-5.5 xhigh · /workspace/demo\n`, "utf8").catch(() => {});
    }, 5);

    assert.deepEqual(await delivered, []);
    const messages = await listThreadMessages("stuck-prompt-changing-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");
    const pending = messages.find((message) => message.id === input.id);

    assert.equal(pending.state, "awaiting_ack");
    assert.equal(pending.deliveryState, "awaiting_prompt_submission");
    assert.equal(Date.parse(pending.deliveryNextAttemptAt) > Date.now(), true);
    assert.doesNotMatch(log, /__CALL__\tsend-keys\t-t\t%42\tC-m/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread input delivery fails when pasted input stays stuck at the prompt past the grace period", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-stuck-prompt-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    const text = [
      "I don't like the --->",
      "",
      "Orkestr",
      "Can you start working on user documentation instead?",
    ].join("\n");
    const promptDraft = `${text.split("\n").map((line, index) => index === 0 ? `› ${line}` : `  ${line}`).join("\n")}\n  accidental extra prompt text`;
    await fs.writeFile(captureFile, `${promptDraft}\n  gpt-5.5 xhigh · /workspace/demo\n`, "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
      ORKESTR_STUCK_PROMPT_FAIL_AFTER_MS: "0",
    };
    await createThread({ id: "stuck-prompt-thread", name: "Stuck Prompt Thread" }, env);
    await wakeThread("stuck-prompt-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("stuck-prompt-thread", {
      role: "user",
      text,
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      deliveryAttempt: 1,
      deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("stuck-prompt-thread", env), []);
    const messages = await listThreadMessages("stuck-prompt-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");
    const failed = messages.find((message) => message.id === input.id);

    assert.equal(failed.state, "failed");
    assert.equal(failed.deliveryState, "failed");
    assert.equal(failed.observedVia, "input_stuck_at_prompt");
    assert.match(failed.error, /pasted into Codex but was not accepted/);
    assert.doesNotMatch(log, /__CALL__\tsend-keys\t-t\t%42\tC-m/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("failed WhatsApp-origin thread delivery raises a connector delivery signal", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-wa-failure-signal-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    consumeThreadConnectorDeliverySignalCount();
    const text = "WhatsApp prompt failure should notify";
    const promptText = [
      "› [WhatsApp: chat-wa-failure-signal]",
      "",
      `  ${text}`,
      "  extra prompt text",
      "  gpt-5.5 xhigh · /workspace/demo",
    ].join("\n");
    await fs.writeFile(captureFile, promptText, "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
      ORKESTR_STUCK_PROMPT_FAIL_AFTER_MS: "0",
    };
    await createThread({ id: "wa-failure-signal-thread", name: "WA Failure Signal Thread" }, env);
    await wakeThread("wa-failure-signal-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("wa-failure-signal-thread", {
      role: "user",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-wa-failure-signal",
      accountId: "account-1",
      text,
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      deliveryAttempt: 1,
      deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("wa-failure-signal-thread", env), []);
    const messages = await listThreadMessages("wa-failure-signal-thread", env);
    const failed = messages.find((message) => message.id === input.id);

    assert.equal(failed.state, "failed");
    assert.equal(failed.observedVia, "input_stuck_at_prompt");
    assert.equal(consumeThreadConnectorDeliverySignalCount(), 1);
    assert.equal(consumeThreadConnectorDeliverySignalCount(), 0);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread input delivery submits an existing pasted temp-file prompt without repasting", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-stuck-file-prompt-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    const text = `FILE-PROMPT-RETRY\n${"x".repeat(860)}`;
    const bytes = Buffer.byteLength(text, "utf8");
    const checksum = createHash("sha256").update(text).digest("hex");
    const filePath = path.join(home, "thread-input.txt");
    const wrapper = [
      "A full user message was written to a local temp file because it is too long for safe tmux inline delivery.",
      `Read the full message from this local UTF-8 file: ${filePath}`,
      `Bytes: ${bytes}`,
      `SHA-256: ${checksum}`,
      "",
      "Treat the file contents as the user's message and answer it directly. Do not summarize this wrapper message.",
    ].join("\n");
    const promptDraft = wrapper.split("\n").map((line, index) => index === 0 ? `› ${line}` : `  ${line}`).join("\n");
    await fs.writeFile(captureFile, `${promptDraft}\n  gpt-5.5 xhigh · /workspace/demo\n`, "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
      ORKESTR_UNSENT_PROMPT_STABLE_MS: "1",
    };
    await createThread({ id: "stuck-file-prompt-thread", name: "Stuck File Prompt Thread" }, env);
    await wakeThread("stuck-file-prompt-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("stuck-file-prompt-thread", {
      role: "user",
      text,
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    }, env);
    await updateThreadMessage("stuck-file-prompt-thread", input.id, {
      deliveryAttempt: 1,
      deliveryInputMode: "file",
      deliveryInputFile: filePath,
      deliveryInputBytes: bytes,
      deliveryPayloadHash: checksum,
      deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("stuck-file-prompt-thread", env), []);
    const messages = await listThreadMessages("stuck-file-prompt-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");
    const updated = messages.find((message) => message.id === input.id);

    assert.equal(updated.state, "awaiting_ack");
    assert.equal(updated.deliveryState, "awaiting_ack");
    assert.equal(updated.deliveryAttempt, 2);
    assert.equal(updated.observedVia, "tmux_submit_stable_unsent_prompt_pending_ack");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tC-m/);
    assert.doesNotMatch(log, /__CALL__\tload-buffer/);
    assert.doesNotMatch(log, /__CALL__\tpaste-buffer/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread input delivery treats rollout growth as agent activity, not stale ack", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-ack-rollout-growth-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const rolloutPath = path.join(home, "rollout.jsonl");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    await fs.writeFile(captureFile, "\u203a \n", "utf8");
    await fs.writeFile(rolloutPath, "before\n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
      ORKESTR_DELIVERY_STALE_ACK_RECOVERY_ATTEMPTS: "1",
    };
    await createThread({ id: "rollout-growth-ack-thread", name: "Rollout Growth Ack Thread" }, env);
    await updateThread("rollout-growth-ack-thread", { codexRolloutPath: rolloutPath }, env);
    const input = await enqueueThreadInput("rollout-growth-ack-thread", { text: "hello rollout growth" }, env);

    assert.deepEqual(await deliverPendingThreadInputs("rollout-growth-ack-thread", env), []);
    await fs.appendFile(rolloutPath, "after\n", "utf8");
    await updateThreadMessage("rollout-growth-ack-thread", input.id, { deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString() }, env);

    assert.deepEqual(await deliverPendingThreadInputs("rollout-growth-ack-thread", env), [input.id]);
    const messages = await listThreadMessages("rollout-growth-ack-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(messages[0].state, "completed");
    assert.equal(messages[0].deliveryState, "delivered");
    assert.equal(messages[0].observedVia, "codex_rollout_growth");
    assert.doesNotMatch(log, /__CALL__\tkill-session\t-t\torkestr-rollout-growth-ack-thread/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread input delivery treats visible work as active, not stale ack", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-ack-visible-work-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    await fs.writeFile(captureFile, "\u203a \n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
      ORKESTR_DELIVERY_STALE_ACK_RECOVERY_ATTEMPTS: "1",
    };
    await createThread({ id: "visible-work-ack-thread", name: "Visible Work Ack Thread" }, env);
    const input = await enqueueThreadInput("visible-work-ack-thread", { text: "hello visible work" }, env);

    assert.deepEqual(await deliverPendingThreadInputs("visible-work-ack-thread", env), []);
    await fs.writeFile(captureFile, "\u2022 Working (2s \u2022 esc to interrupt)\n", "utf8");
    await updateThreadMessage("visible-work-ack-thread", input.id, { deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString() }, env);

    assert.deepEqual(await deliverPendingThreadInputs("visible-work-ack-thread", env), [input.id]);
    const messages = await listThreadMessages("visible-work-ack-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(messages[0].state, "completed");
    assert.equal(messages[0].deliveryState, "delivered");
    assert.equal(messages[0].observedVia, "runtime_working");
    assert.doesNotMatch(log, /__CALL__\tkill-session\t-t\torkestr-visible-work-ack-thread/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("runtime status treats a prompt after stale working text as ready", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-stale-working-prompt-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    await fs.writeFile(
      captureFile,
      [
        "\u2022 Working (36m 53s \u2022 esc to interrupt)",
        "",
        "\u203a Find and fix a bug in @filename",
        "",
        "  gpt-5.5 xhigh \u00b7 ~",
      ].join("\n"),
      "utf8",
    );
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
    };
    await createThread({ id: "stale-working-prompt-thread", name: "Stale Working Prompt Thread" }, env);
    await wakeThread("stale-working-prompt-thread", { reason: "test_wake" }, env);

    const status = await runtimeStatus("stale-working-prompt-thread", env);
    assert.equal(status.state, "ready");
    assert.equal(status.promptReady, true);
    assert.equal(status.working, false);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread input delivery sends near-limit multiline messages through a temp file by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-delivery-near-limit-input-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const loadedBufferCapture = path.join(home, "loaded-buffers.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorLoadedBufferCapture = process.env.TMUX_LOADED_BUFFER_CAPTURE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.TMUX_LOADED_BUFFER_CAPTURE = loadedBufferCapture;

  try {
    await fs.writeFile(captureFile, "\u203a \n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      TMUX_LOADED_BUFFER_CAPTURE: loadedBufferCapture,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
    };
    const nearLimitText = `NEAR-LIMIT-MULTILINE\n${"x".repeat(880)}`;
    await createThread({ id: "near-limit-delivery-thread", name: "Near Limit Delivery Thread" }, env);
    await enqueueThreadInput("near-limit-delivery-thread", { text: nearLimitText }, env);

    assert.deepEqual(await deliverPendingThreadInputs("near-limit-delivery-thread", env), []);
    const messages = await listThreadMessages("near-limit-delivery-thread", env);
    const deliveredPrompt = await fs.readFile(loadedBufferCapture, "utf8");
    const storedInput = await fs.readFile(messages[0].deliveryInputFile, "utf8");

    assert.equal(nearLimitText.length, 901);
    assert.equal(messages[0].deliveryInputMode, "file");
    assert.equal(messages[0].deliveryInputBytes, Buffer.byteLength(nearLimitText, "utf8"));
    assert.equal(storedInput, nearLimitText);
    assert.match(deliveredPrompt, /Read the full message from this local UTF-8 file:/);
    assert.doesNotMatch(deliveredPrompt, /x{801}/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("TMUX_LOADED_BUFFER_CAPTURE", priorLoadedBufferCapture);
  }
});

test("thread input delivery sends oversized messages through a temp file", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-delivery-long-input-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const loadedBufferCapture = path.join(home, "loaded-buffers.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorLoadedBufferCapture = process.env.TMUX_LOADED_BUFFER_CAPTURE;
  const priorLiteralMax = process.env.TMUX_SEND_KEYS_LITERAL_MAX;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.TMUX_LOADED_BUFFER_CAPTURE = loadedBufferCapture;
  process.env.TMUX_SEND_KEYS_LITERAL_MAX = "1024";

  try {
    await fs.writeFile(captureFile, "\u203a \n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      TMUX_LOADED_BUFFER_CAPTURE: loadedBufferCapture,
      TMUX_SEND_KEYS_LITERAL_MAX: "1024",
      ORKESTR_TMUX_INLINE_CHAR_LIMIT: "1024",
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
    };
    const longText = `LONG-DELIVERY-REPRO\n${"x".repeat(1200)}`;
    await createThread({ id: "long-delivery-thread", name: "Long Delivery Thread" }, env);
    await enqueueThreadInput("long-delivery-thread", { text: longText }, env);

    assert.deepEqual(await deliverPendingThreadInputs("long-delivery-thread", env), []);
    const messages = await listThreadMessages("long-delivery-thread", env);
    const deliveredPrompt = await fs.readFile(loadedBufferCapture, "utf8");
    const storedLongMessage = await fs.readFile(messages[0].deliveryInputFile, "utf8");
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(messages[0].state, "awaiting_ack");
    assert.equal(messages[0].deliveryState, "awaiting_ack");
    assert.equal(messages[0].deliveryInputMode, "file");
    assert.ok(messages[0].deliveryInputFile.endsWith(".txt"));
    assert.equal(messages[0].deliveryInputBytes, Buffer.byteLength(longText, "utf8"));
    assert.equal(storedLongMessage, longText);
    assert.match(deliveredPrompt, /Read the full message from this local UTF-8 file:/);
    assert.match(deliveredPrompt, /Treat the file contents as the user's message/);
    assert.match(deliveredPrompt, new RegExp(messages[0].deliveryInputFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(deliveredPrompt.length < 1024);
    assert.doesNotMatch(deliveredPrompt, /x{1025}/);
    assert.match(log, /__CALL__\tpaste-buffer\t-b\torkestr-[0-9a-f]+\t-t\t%42/);
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tC-m/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("TMUX_LOADED_BUFFER_CAPTURE", priorLoadedBufferCapture);
    restoreEnvValue("TMUX_SEND_KEYS_LITERAL_MAX", priorLiteralMax);
  }
});

test("thread input delivery sends answers to pending Codex plan questions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-plan-answer-delivery-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const afterEscapeFile = path.join(home, "pane-after-escape.txt");
  const afterEnterFile = path.join(home, "pane-after-enter.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorCaptureAfterEscapeFile = process.env.TMUX_CAPTURE_AFTER_ESCAPE_FILE;
  const priorCaptureAfterEnterFile = process.env.TMUX_CAPTURE_AFTER_ENTER_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.TMUX_CAPTURE_AFTER_ESCAPE_FILE = afterEscapeFile;

  try {
    await fs.writeFile(captureFile, [
      "Question 1/2 (2 unanswered)",
      "Select one primary color for the plan.",
      "",
      "› 1. Blue (Recommended)  Calm, neutral, and broadly compatible.",
      "  2. Green               Fresh, constructive, and success-oriented.",
      "  3. Red                 Bold, urgent, and high-attention.",
      "",
      "tab to add notes | enter to submit answer | left/right to navigate questions",
      "esc to interrupt",
    ].join("\n"), "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      TMUX_CAPTURE_AFTER_ESCAPE_FILE: afterEscapeFile,
      ORKESTR_WAKE_READY_TIMEOUT_MS: "20",
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
      ORKESTR_NEED_INPUT_CANCEL_WAIT_MS: "0",
      ORKESTR_NEED_INPUT_CANCEL_READY_TIMEOUT_MS: "0",
    };
    await createThread({ id: "plan-answer-thread", name: "Plan Answer Thread" }, env);
    await wakeThread("plan-answer-thread", { reason: "test" }, env);
    await appendThreadMessage("plan-answer-thread", {
      role: "assistant",
      source: "codex-rollout",
      phase: "need_input",
      eventId: "need-input-color-size",
      text: [
        "Codex needs input to continue:",
        "",
        "1. Color: Select one primary color for the plan.",
        "   A. Blue (Recommended): Calm, neutral, and broadly compatible.",
        "   B. Green: Fresh, constructive, and success-oriented.",
        "   C. Red: Bold, urgent, and high-attention.",
        "",
        "2. Size: Select one target size for the plan.",
        "   A. Medium (Recommended): Balanced detail without becoming long.",
        "   B. Small: Compact and minimal.",
        "   C. Large: More detailed and expansive.",
        "",
        "Reply with your choices or a short free-form answer.",
      ].join("\n"),
    }, env);
    const answer = await enqueueThreadInput("plan-answer-thread", { text: "Color: blue, Size: medium" }, env);

    assert.deepEqual(await deliverPendingThreadInputs("plan-answer-thread", env), [answer.id]);
    const messages = await listThreadMessages("plan-answer-thread", env);
    const deliveredAnswer = messages.find((message) => message.id === answer.id);
    const log = await fs.readFile(fakeTmux.log, "utf8");
    const submitCount = log.split("\n").filter((line) => line.includes("__CALL__\tsend-keys\t-t\t%42\tC-m")).length;

    assert.equal(deliveredAnswer.state, "completed");
    assert.equal(deliveredAnswer.deliveryState, "delivered");
    assert.equal(deliveredAnswer.observedVia, "codex_request_user_input");
    assert.equal(deliveredAnswer.answeredInputEventId, "need-input-color-size");
    assert.equal(deliveredAnswer.error, null);
    assert.equal(submitCount, 2);

    await fs.writeFile(captureFile, [
      "Question 1/1 (1 unanswered)",
      "What should the current-workspace plan aim to do?",
      "",
      "› 1. Preserve Failure Repro (Recommended)  Keep the existing failing test and plan around verifying the failure path.",
      "  2. Clean Workspace                       Plan removal of repro/cache artifacts and return to a clean baseline.",
      "  3. Add Tiny Project                      Plan a minimal project scaffold that builds on the current workspace.",
      "",
      "tab to add notes | enter to submit answer | esc to interrupt",
    ].join("\n"), "utf8");
    await fs.writeFile(afterEscapeFile, "› \n\ngpt-5.5 xhigh · /workspace/demo            Plan mode\n", "utf8");
    await appendThreadMessage("plan-answer-thread", {
      role: "assistant",
      source: "codex-rollout",
      phase: "need_input",
      eventId: "need-input-outcome",
      text: [
        "Codex needs input to continue:",
        "",
        "1. Outcome: What should the current-workspace plan aim to do?",
        "   A. Preserve Failure Repro (Recommended): Keep the existing failing test and plan around verifying the failure path.",
        "   B. Clean Workspace: Plan removal of repro/cache artifacts and return to a clean baseline.",
        "   C. Add Tiny Project: Plan a minimal project scaffold that builds on the current workspace.",
        "",
        "Reply with your choices or a short free-form answer.",
      ].join("\n"),
    }, env);
    const defaultAnswer = await enqueueThreadInput("plan-answer-thread", { text: "default pls" }, env);
    await fs.writeFile(afterEnterFile, "• Working (1s • esc to interrupt)\n", "utf8");
    process.env.TMUX_CAPTURE_AFTER_ENTER_FILE = afterEnterFile;
    env.TMUX_CAPTURE_AFTER_ENTER_FILE = afterEnterFile;

    assert.deepEqual(await deliverPendingThreadInputs("plan-answer-thread", env), [defaultAnswer.id]);
    const messagesAfterDefault = await listThreadMessages("plan-answer-thread", env);
    const deliveredDefaultAnswer = messagesAfterDefault.find((message) => message.id === defaultAnswer.id);
    const logAfterDefault = await fs.readFile(fakeTmux.log, "utf8");
    const submitCountAfterDefault = logAfterDefault.split("\n").filter((line) => line.includes("__CALL__\tsend-keys\t-t\t%42\tC-m")).length;

    assert.equal(deliveredDefaultAnswer.state, "completed");
    assert.equal(deliveredDefaultAnswer.deliveryState, "delivered");
    assert.equal(deliveredDefaultAnswer.observedVia, "runtime_working");
    assert.equal(deliveredDefaultAnswer.canceledInputEventId, "need-input-outcome");
    assert.equal(deliveredDefaultAnswer.error, null);
    assert.equal(submitCountAfterDefault, 3);
    assert.match(logAfterDefault, /__CALL__\tsend-keys\t-t\t%42\tEscape/);
    assert.match(logAfterDefault, /__CALL__\tpaste-buffer\t-b\torkestr-[0-9a-f]+\t-t\t%42/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("TMUX_CAPTURE_AFTER_ESCAPE_FILE", priorCaptureAfterEscapeFile);
    restoreEnvValue("TMUX_CAPTURE_AFTER_ENTER_FILE", priorCaptureAfterEnterFile);
  }
});

test("thread runtime reset kills and wakes the same thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-reset-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
    };
    await createThread({ id: "reset-thread", name: "Reset Thread" }, env);
    await wakeThread("reset-thread", { reason: "test_wake" }, env);

    const reset = await resetThreadRuntime("reset-thread", { reason: "test_reset" }, env);
    const status = await runtimeStatus("reset-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(reset.ok, true);
    assert.equal(reset.reset, true);
    assert.equal(reset.slept, 1);
    assert.equal(status.state, "ready");
    assert.match(log, /__CALL__\tkill-session\t-t\torkestr-reset-thread/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
  }
});

test("thread hard reset falls back to a manual context checkpoint when compact is rejected", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-hard-reset-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
    };
    await fs.writeFile(captureFile, "Unrecognized command '/compact'\n› \n\ngpt-5.5 xhigh · /workspace/demo\n", "utf8");
    await createThread({ id: "hard-reset-thread", name: "Hard Reset Thread" }, env);
    await appendThreadMessage("hard-reset-thread", { role: "user", text: "Important active task", state: "completed" }, env);
    await appendThreadMessage("hard-reset-thread", { role: "assistant", phase: "final_answer", text: "Important result", state: "completed" }, env);
    await wakeThread("hard-reset-thread", { reason: "test_wake" }, env);

    const reset = await hardResetThreadRuntime("hard-reset-thread", { reason: "test_hard_reset" }, env);
    const checkpoint = await fs.readFile(reset.manualCheckpoint.path, "utf8");
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(reset.ok, true);
    assert.equal(reset.hardReset, true);
    assert.equal(reset.compaction.attempted, true);
    assert.equal(reset.compaction.compacted, false);
    assert.equal(reset.compaction.reason, "compact_command_rejected");
    assert.equal(reset.manualCheckpoint.method, "manual_checkpoint");
    assert.match(checkpoint, /Important active task/);
    assert.match(log, /__CALL__\tpaste-buffer/);
    assert.match(log, /__CALL__\tkill-session\t-t\torkestr-hard-reset-thread/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("codex mode endpoint toggles the attached Codex runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-codex-mode-live-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorHome = process.env.ORKESTR_HOME;
  const priorRuntimeHome = process.env.HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorRecoverOnStart = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.HOME = path.join(home, "runtime-home");
  process.env.CODEX_HOME = path.join(home, "codex-home");
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  let server;
  try {
    await fs.writeFile(captureFile, "› \n\ngpt-5.5 xhigh · /workspace/demo\n", "utf8");
    await createThread({ id: "codex-mode-thread", name: "Codex Mode Thread" });
    await wakeThread("codex-mode-thread", { reason: "test" });
    server = await startServer({ port: 0, host: "127.0.0.1" });
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/threads/codex-mode-thread/codex-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan" }),
    });
    const payload = await response.json();
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(response.status, 200);
    assert.equal(payload.mode, "plan");
    assert.equal(payload.applied, true);
    assert.equal(payload.runtimeMode.changed, true);
    assert.equal(payload.thread.codexMode, "code");
    assert.equal(payload.thread.codexModeLive, "code");
    assert.equal(payload.thread.desiredCodexMode, null);
    assert.equal(payload.thread.codexModeLiveApplied, true);
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tBTab/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    restoreEnvValue("ORKESTR_HOME", priorHome);
    restoreEnvValue("HOME", priorRuntimeHome);
    restoreEnvValue("CODEX_HOME", priorCodexHome);
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("ORKESTR_RECOVER_RUNNING_ON_START", priorRecoverOnStart);
  }
});

test("runtime sync restores persisted Codex plan mode after wake", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-codex-mode-restore-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const afterBtabFile = path.join(home, "pane-after-btab.txt");
  const priorHome = process.env.ORKESTR_HOME;
  const priorRuntimeHome = process.env.HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorAfterBtabFile = process.env.TMUX_CAPTURE_AFTER_BTAB_FILE;
  const priorIdleSleep = process.env.ORKESTR_RUNTIME_IDLE_SLEEP_MS;
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.HOME = path.join(home, "runtime-home");
  process.env.CODEX_HOME = path.join(home, "codex-home");
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.TMUX_CAPTURE_AFTER_BTAB_FILE = afterBtabFile;
  process.env.ORKESTR_RUNTIME_IDLE_SLEEP_MS = "0";

  try {
    await fs.writeFile(captureFile, "› \n\ngpt-5.5 xhigh · /workspace/demo\n", "utf8");
    await fs.writeFile(afterBtabFile, "› \n\ngpt-5.5 xhigh · /workspace/demo            Plan mode\n", "utf8");
    const env = {
      ORKESTR_HOME: process.env.ORKESTR_HOME,
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      TMUX_CAPTURE_AFTER_BTAB_FILE: afterBtabFile,
      ORKESTR_RUNTIME_IDLE_SLEEP_MS: "0",
    };
    await createThread({ id: "codex-mode-restore-thread", name: "Codex Mode Restore Thread", codexMode: "plan" }, env);
    await wakeThread("codex-mode-restore-thread", { reason: "test" }, env);
    let thread = await getThread("codex-mode-restore-thread", env);
    let status = await runtimeStatus("codex-mode-restore-thread", env);

    assert.equal(thread.desiredCodexMode, "plan");
    assert.equal(status.codexMode, "code");

    await syncRuntimeLeases(env);
    thread = await getThread("codex-mode-restore-thread", env);
    status = await runtimeStatus("codex-mode-restore-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(thread.codexMode, "plan");
    assert.equal(thread.desiredCodexMode, null);
    assert.equal(thread.codexModeSource, "orkestr-wake-restore");
    assert.equal(status.codexMode, "plan");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tBTab/);
  } finally {
    restoreEnvValue("ORKESTR_HOME", priorHome);
    restoreEnvValue("HOME", priorRuntimeHome);
    restoreEnvValue("CODEX_HOME", priorCodexHome);
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("TMUX_CAPTURE_AFTER_BTAB_FILE", priorAfterBtabFile);
    restoreEnvValue("ORKESTR_RUNTIME_IDLE_SLEEP_MS", priorIdleSleep);
  }
});

test("thread /plan command persists Codex mode for future wakes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-codex-mode-command-persist-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const afterBtabFile = path.join(home, "pane-after-btab.txt");
  const priorHome = process.env.ORKESTR_HOME;
  const priorRuntimeHome = process.env.HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorAfterBtabFile = process.env.TMUX_CAPTURE_AFTER_BTAB_FILE;
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.HOME = path.join(home, "runtime-home");
  process.env.CODEX_HOME = path.join(home, "codex-home");
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.TMUX_CAPTURE_AFTER_BTAB_FILE = afterBtabFile;

  try {
    await fs.writeFile(captureFile, "› \n\ngpt-5.5 xhigh · /workspace/demo\n", "utf8");
    await fs.writeFile(afterBtabFile, "› \n\ngpt-5.5 xhigh · /workspace/demo            Plan mode\n", "utf8");
    const env = {
      ORKESTR_HOME: process.env.ORKESTR_HOME,
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      TMUX_CAPTURE_AFTER_BTAB_FILE: afterBtabFile,
    };
    await createThread({ id: "codex-mode-command-persist-thread", name: "Codex Mode Command Persist Thread" }, env);
    await wakeThread("codex-mode-command-persist-thread", { reason: "test" }, env);
    await appendThreadMessage("codex-mode-command-persist-thread", {
      role: "user",
      source: "cli",
      text: "/plan",
      state: "queued",
    }, env);

    const delivered = await deliverPendingThreadInputs("codex-mode-command-persist-thread", env);
    const thread = await getThread("codex-mode-command-persist-thread", env);
    const messages = await listThreadMessages("codex-mode-command-persist-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(delivered.length, 1);
    assert.equal(thread.codexMode, "plan");
    assert.equal(thread.desiredCodexMode, null);
    assert.equal(thread.codexModeSource, "orkestr-command");
    assert.equal(messages.find((message) => message.text === "/plan").state, "completed");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tBTab/);
  } finally {
    restoreEnvValue("ORKESTR_HOME", priorHome);
    restoreEnvValue("HOME", priorRuntimeHome);
    restoreEnvValue("CODEX_HOME", priorCodexHome);
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("TMUX_CAPTURE_AFTER_BTAB_FILE", priorAfterBtabFile);
  }
});

test("codex mode switch to code closes a visible plan implementation prompt", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-codex-mode-implement-menu-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const afterEscapeFile = path.join(home, "pane-after-escape.txt");
  const priorHome = process.env.ORKESTR_HOME;
  const priorRuntimeHome = process.env.HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorCaptureAfterEscapeFile = process.env.TMUX_CAPTURE_AFTER_ESCAPE_FILE;
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.HOME = path.join(home, "runtime-home");
  process.env.CODEX_HOME = path.join(home, "codex-home");
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.TMUX_CAPTURE_AFTER_ESCAPE_FILE = afterEscapeFile;

  try {
    await fs.writeFile(captureFile, [
      "Implement this plan?",
      "› 1. Yes, implement this plan",
      "  2. Yes, clear context and implement",
      "  3. No, stay in Plan mode",
      "",
      "Press enter to confirm or esc to go back",
      "gpt-5.5 xhigh · /workspace/demo            Plan mode",
    ].join("\n"), "utf8");
    await fs.writeFile(afterEscapeFile, "› \n\ngpt-5.5 xhigh · /workspace/demo            Plan mode\n", "utf8");
    await createThread({ id: "codex-mode-implementation-menu-thread", name: "Codex Mode Implementation Menu Thread" });
    await wakeThread("codex-mode-implementation-menu-thread", { reason: "test" });
    const result = await applyRuntimeCodexMode("codex-mode-implementation-menu-thread", "code");
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(result.applied, true);
    assert.equal(result.changed, true);
    assert.equal(result.reason, "closed_plan_implementation_prompt");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tEscape/);
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tBTab/);
  } finally {
    restoreEnvValue("ORKESTR_HOME", priorHome);
    restoreEnvValue("HOME", priorRuntimeHome);
    restoreEnvValue("CODEX_HOME", priorCodexHome);
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("TMUX_CAPTURE_AFTER_ESCAPE_FILE", priorCaptureAfterEscapeFile);
  }
});

test("thread input /plan closes a visible Codex plan implementation prompt without switching mode", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-plan-mode-implement-menu-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const afterEscapeFile = path.join(home, "pane-after-escape.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorCaptureAfterEscapeFile = process.env.TMUX_CAPTURE_AFTER_ESCAPE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.TMUX_CAPTURE_AFTER_ESCAPE_FILE = afterEscapeFile;

  try {
    await fs.writeFile(captureFile, [
      "Implement this plan?",
      "› 1. Yes, implement this plan",
      "  2. Yes, clear context and implement",
      "  3. No, stay in Plan mode",
      "",
      "Press enter to confirm or esc to go back",
      "gpt-5.5 xhigh · /workspace/demo            Plan mode",
    ].join("\n"), "utf8");
    await fs.writeFile(afterEscapeFile, "› \n\ngpt-5.5 xhigh · /workspace/demo            Plan mode\n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      TMUX_CAPTURE_AFTER_ESCAPE_FILE: afterEscapeFile,
    };
    await createThread({ id: "plan-mode-implementation-menu-thread", name: "Plan Mode Implementation Menu Thread" }, env);
    await wakeThread("plan-mode-implementation-menu-thread", { reason: "test" }, env);
    const command = await appendThreadMessage("plan-mode-implementation-menu-thread", {
      role: "user",
      source: "whatsapp",
      text: "/plan",
      state: "queued",
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("plan-mode-implementation-menu-thread", env), [command.id]);
    const messages = await listThreadMessages("plan-mode-implementation-menu-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(messages.at(-1)?.state, "completed");
    assert.equal(messages.at(-1)?.deliveryState, "delivered");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tEscape/);
    assert.doesNotMatch(log, /__CALL__\tsend-keys\t-t\t%42\tBTab/);
    assert.doesNotMatch(log, /__CALL__\tpaste-buffer/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("TMUX_CAPTURE_AFTER_ESCAPE_FILE", priorCaptureAfterEscapeFile);
  }
});

test("thread input /implement confirms a visible Codex plan implementation prompt", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-implement-plan-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorHome = process.env.ORKESTR_HOME;
  const priorRuntimeHome = process.env.HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorRecoverOnStart = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.HOME = path.join(home, "runtime-home");
  process.env.CODEX_HOME = path.join(home, "codex-home");
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  let server;
  try {
    await fs.writeFile(captureFile, [
      "Implement this plan?",
      "",
      "› 1. Yes, implement this plan",
      "  2. No, keep planning",
      "",
      "gpt-5.5 xhigh · /workspace/demo            Plan mode",
    ].join("\n"), "utf8");
    await createThread({ id: "implement-plan-thread", name: "Implement Plan Thread" });
    await wakeThread("implement-plan-thread", { reason: "test" });
    server = await startServer({ port: 0, host: "127.0.0.1" });
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/threads/implement-plan-thread/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "/implement", parseCommands: true, controlAllowed: true }),
    });
    const payload = await response.json();
    const log = await fs.readFile(fakeTmux.log, "utf8");
    const messages = await listThreadMessages("implement-plan-thread");

    assert.equal(response.status, 202);
    assert.equal(payload.ok, true);
    assert.equal(payload.implemented, true);
    assert.equal(payload.reason, "confirmed");
    assert.equal(payload.message.state, "completed");
    assert.equal(payload.message.deliveryState, "delivered");
    assert.equal(payload.message.observedVia, "codex_plan_implementation_confirmed");
    assert.equal(messages.at(-1)?.text, "/implement");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tC-m/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    restoreEnvValue("ORKESTR_HOME", priorHome);
    restoreEnvValue("HOME", priorRuntimeHome);
    restoreEnvValue("CODEX_HOME", priorCodexHome);
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("ORKESTR_RECOVER_RUNNING_ON_START", priorRecoverOnStart);
  }
});

test("thread input delivery confirms visible Codex plan implementation prompt from natural intent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-natural-implement-plan-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    await fs.writeFile(captureFile, [
      "Implement this plan?",
      "",
      "› 1. Yes, implement this plan",
      "  2. No, keep planning",
      "",
      "gpt-5.5 xhigh · /workspace/demo            Plan mode",
    ].join("\n"), "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
    };
    await createThread({ id: "natural-implement-plan-thread", name: "Natural Implement Plan Thread" }, env);
    await wakeThread("natural-implement-plan-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("natural-implement-plan-thread", {
      role: "user",
      source: "whatsapp",
      text: "Implement this please.",
      state: "queued",
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("natural-implement-plan-thread", env), [input.id]);
    const messages = await listThreadMessages("natural-implement-plan-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(messages.at(-1)?.state, "completed");
    assert.equal(messages.at(-1)?.deliveryState, "delivered");
    assert.equal(messages.at(-1)?.observedVia, "codex_plan_implementation_confirmed");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tC-m/);
    assert.doesNotMatch(log, /Implement this please/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread input delivery answers Codex plan implementation prompt with numeric choice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-plan-choice-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    await fs.writeFile(captureFile, [
      "Implement this plan?",
      "",
      "› 1. Yes, implement this plan",
      "  2. Yes, clear context and implement",
      "  3. No, stay in Plan mode",
      "",
      "Press enter to confirm or esc to go back",
      "gpt-5.5 xhigh · /workspace/demo            Plan mode",
    ].join("\n"), "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
    };
    await createThread({ id: "plan-choice-thread", name: "Plan Choice Thread" }, env);
    await wakeThread("plan-choice-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("plan-choice-thread", {
      role: "user",
      source: "whatsapp",
      text: "3",
      state: "queued",
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("plan-choice-thread", env), [input.id]);
    const messages = await listThreadMessages("plan-choice-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(messages.at(-1)?.state, "completed");
    assert.equal(messages.at(-1)?.deliveryState, "delivered");
    assert.equal(messages.at(-1)?.observedVia, "codex_plan_implementation_choice_stay_plan");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tDown/);
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tC-m/);
    assert.doesNotMatch(log, /__CALL__\tpaste-buffer/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread input delivery dismisses Codex plan implementation prompt before normal text", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-plan-menu-normal-input-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const afterEscapeFile = path.join(home, "pane-after-escape.txt");
  const bufferCapture = path.join(home, "buffers.log");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorCaptureAfterEscapeFile = process.env.TMUX_CAPTURE_AFTER_ESCAPE_FILE;
  const priorLoadedBufferCapture = process.env.TMUX_LOADED_BUFFER_CAPTURE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.TMUX_CAPTURE_AFTER_ESCAPE_FILE = afterEscapeFile;
  process.env.TMUX_LOADED_BUFFER_CAPTURE = bufferCapture;

  try {
    await fs.writeFile(captureFile, [
      "Implement this plan?",
      "",
      "› 1. Yes, implement this plan",
      "  2. Yes, clear context and implement",
      "  3. No, stay in Plan mode",
      "",
      "Press enter to confirm or esc to go back",
      "gpt-5.5 xhigh · /workspace/demo            Plan mode",
    ].join("\n"), "utf8");
    await fs.writeFile(afterEscapeFile, "› \n\ngpt-5.5 xhigh · /workspace/demo            Plan mode\n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      TMUX_CAPTURE_AFTER_ESCAPE_FILE: afterEscapeFile,
      TMUX_LOADED_BUFFER_CAPTURE: bufferCapture,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_RUNTIME_SUBMIT_DELAY_MS: "0",
      ORKESTR_PLAN_IMPLEMENTATION_DISMISS_WAIT_MS: "0",
      ORKESTR_PLAN_IMPLEMENTATION_DISMISS_READY_TIMEOUT_MS: "0",
    };
    await createThread({ id: "plan-menu-normal-input-thread", name: "Plan Menu Normal Input Thread" }, env);
    await wakeThread("plan-menu-normal-input-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("plan-menu-normal-input-thread", {
      role: "user",
      source: "whatsapp",
      text: "ACK isolation",
      state: "queued",
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("plan-menu-normal-input-thread", env), []);
    const messages = await listThreadMessages("plan-menu-normal-input-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");
    const bufferLog = await fs.readFile(bufferCapture, "utf8");
    const lines = log.trim().split("\n");
    const escapeIndex = lines.findIndex((line) => line.includes("\tsend-keys\t-t\t%42\tEscape"));
    const pasteIndex = lines.findIndex((line) => line.includes("\tpaste-buffer"));
    const enterIndex = lines.findIndex((line) => line.includes("\tsend-keys\t-t\t%42\tC-m"));

    assert.equal(messages.find((message) => message.id === input.id)?.state, "awaiting_ack");
    assert.match(bufferLog, /ACK isolation/);
    assert.ok(escapeIndex >= 0, "Escape should close the implementation prompt");
    assert.ok(pasteIndex > escapeIndex, "normal input should be pasted only after Escape");
    assert.ok(enterIndex > pasteIndex, "Enter should submit normal input, not the implementation menu");
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("TMUX_CAPTURE_AFTER_ESCAPE_FILE", priorCaptureAfterEscapeFile);
    restoreEnvValue("TMUX_LOADED_BUFFER_CAPTURE", priorLoadedBufferCapture);
  }
});

test("thread summary reports live Codex plan mode from the runtime pane", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-codex-mode-summary-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorHome = process.env.ORKESTR_HOME;
  const priorRuntimeHome = process.env.HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorRecoverOnStart = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.HOME = path.join(home, "runtime-home");
  process.env.CODEX_HOME = path.join(home, "codex-home");
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  try {
    await fs.writeFile(captureFile, [
      "Question 1/1 (1 unanswered)",
      "Pick an implementation path.",
      "",
      "› 1. Default (Recommended)",
      "",
      "gpt-5.5 xhigh · /workspace/demo            Plan mode",
    ].join("\n"), "utf8");
    await createThread({
      id: "codex-mode-summary-thread",
      name: "Codex Mode Summary Thread",
      codexMode: "code",
      desiredCodexMode: "code",
    });
    const woken = await wakeThread("codex-mode-summary-thread", { reason: "test" });
    const summary = await threadRuntimeSummary(woken.thread, await listThreadMessages("codex-mode-summary-thread"));

    assert.equal(summary.codexMode, "plan");
    assert.equal(summary.codexModeLive, "plan");
    assert.equal(summary.codexModeSource, "runtime-pane");
    assert.equal(summary.desiredCodexMode, null);
  } finally {
    restoreEnvValue("ORKESTR_HOME", priorHome);
    restoreEnvValue("HOME", priorRuntimeHome);
    restoreEnvValue("CODEX_HOME", priorCodexHome);
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("ORKESTR_RECOVER_RUNNING_ON_START", priorRecoverOnStart);
  }
});

test("thread summary exposes visible Codex plan implementation prompt as a pending question", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-plan-implementation-question-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorHome = process.env.ORKESTR_HOME;
  const priorRuntimeHome = process.env.HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorRecoverOnStart = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.HOME = path.join(home, "runtime-home");
  process.env.CODEX_HOME = path.join(home, "codex-home");
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  try {
    await fs.writeFile(captureFile, [
      "Implement this plan?",
      "",
      "› 1. Yes, implement this plan",
      "  2. Yes, clear context and implement",
      "  3. No, stay in Plan mode",
      "",
      "Press enter to confirm or esc to go back",
      "gpt-5.5 xhigh · /workspace/demo            Plan mode",
    ].join("\n"), "utf8");
    await createThread({ id: "plan-implementation-question-thread", name: "Plan Implementation Question Thread" });
    const woken = await wakeThread("plan-implementation-question-thread", { reason: "test" });
    const summary = await threadRuntimeSummary(woken.thread, await listThreadMessages("plan-implementation-question-thread"));

    assert.equal(summary.awaitingInput, true);
    assert.equal(summary.pendingQuestion?.phase, "implementation_choice");
    assert.match(summary.pendingQuestion?.text || "", /1\. Implement this plan/);
    assert.match(summary.pendingQuestion?.text || "", /2\. Clear context and implement/);
    assert.match(summary.pendingQuestion?.text || "", /3\. Stay in Plan mode/);
  } finally {
    restoreEnvValue("ORKESTR_HOME", priorHome);
    restoreEnvValue("HOME", priorRuntimeHome);
    restoreEnvValue("CODEX_HOME", priorCodexHome);
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("ORKESTR_RECOVER_RUNNING_ON_START", priorRecoverOnStart);
  }
});

test("thread summary ignores stale Plan mode text without a live Codex status line", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-codex-mode-stale-plan-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorHome = process.env.ORKESTR_HOME;
  const priorRuntimeHome = process.env.HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorRecoverOnStart = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.HOME = path.join(home, "runtime-home");
  process.env.CODEX_HOME = path.join(home, "codex-home");
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  try {
    await fs.writeFile(captureFile, [
      "Implement this plan?",
      "",
      "› 1. Yes, implement this plan",
      "  2. Yes, clear context and implement",
      "  3. No, stay in Plan mode",
      "",
      "Press enter to continue",
    ].join("\n"), "utf8");
    await createThread({
      id: "codex-mode-stale-plan-thread",
      name: "Codex Mode Stale Plan Thread",
      codexMode: "code",
      desiredCodexMode: "code",
    });
    const woken = await wakeThread("codex-mode-stale-plan-thread", { reason: "test" });
    const status = await runtimeStatus("codex-mode-stale-plan-thread");
    const summary = await threadRuntimeSummary(woken.thread, await listThreadMessages("codex-mode-stale-plan-thread"));

    assert.equal(status.codexMode, null);
    assert.equal(status.codexModeSource, null);
    assert.equal(summary.codexMode, "code");
    assert.equal(summary.codexModeLive, null);
    assert.equal(summary.desiredCodexMode, null);
  } finally {
    restoreEnvValue("ORKESTR_HOME", priorHome);
    restoreEnvValue("HOME", priorRuntimeHome);
    restoreEnvValue("CODEX_HOME", priorCodexHome);
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("ORKESTR_RECOVER_RUNNING_ON_START", priorRecoverOnStart);
  }
});

test("thread input delivery fails when Codex rejects a literal /now command", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-delivery-rejected-command-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    await fs.writeFile(captureFile, "Unrecognized command '/now'. Type \"/\" for a list of supported commands.\n\u203a \n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
    };
    await createThread({ id: "rejected-command-thread", name: "Rejected Command Thread" }, env);
    await enqueueThreadInput("rejected-command-thread", { text: "/now \nrun this immediately" }, env);

    assert.deepEqual(await deliverPendingThreadInputs("rejected-command-thread", env), []);
    const messages = await listThreadMessages("rejected-command-thread", env);

    assert.equal(messages[0].state, "failed");
    assert.equal(messages[0].deliveryState, "failed");
    assert.match(messages[0].error, /Unrecognized command '\/now'/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread input delivery refreshes stale tmux pane ids before submitting", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-delivery-stale-pane-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  const priorValidPanes = process.env.TMUX_VALID_PANES;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.TMUX_VALID_PANES = "%42";

  try {
    await fs.writeFile(captureFile, "\u203a \n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
      TMUX_VALID_PANES: "%42",
      ORKESTR_DELIVERY_ACK_WAIT_MS: "0",
      ORKESTR_DELIVERY_ACK_BACKOFF_MS: "10000",
    };
    await createThread({ id: "stale-pane-thread", name: "Stale Pane Thread" }, env);
    await wakeThread("stale-pane-thread", { reason: "test" }, env);

    const paths = await ensureDataDirs(env);
    const leases = await listRuntimeLeases(env);
    await fs.writeFile(
      paths.runtimeLeases,
      JSON.stringify(leases.map((lease) => lease.threadId === "stale-pane-thread" ? { ...lease, paneId: "%580" } : lease), null, 2),
      "utf8",
    );
    await enqueueThreadInput("stale-pane-thread", { text: "hello after pane replacement" }, env);

    assert.deepEqual(await deliverPendingThreadInputs("stale-pane-thread", env), []);
    const messages = await listThreadMessages("stale-pane-thread", env);
    const refreshedLeases = await listRuntimeLeases(env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(messages[0].state, "awaiting_ack");
    assert.equal(messages[0].deliveryState, "awaiting_ack");
    assert.equal(messages[0].deliveryPaneId, "%42");
    assert.equal(messages[0].error, null);
    assert.equal(refreshedLeases.find((lease) => lease.threadId === "stale-pane-thread")?.paneId, "%42");
    assert.match(log, /__CALL__\tsend-keys\t-t\t%42\tC-m/);
    assert.doesNotMatch(log, /__CALL__\tsend-keys\t-t\t%580\tC-m/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
    restoreEnvValue("TMUX_VALID_PANES", priorValidPanes);
  }
});

test("runtime monitor fails awaiting inputs when Codex rejects a literal slash command", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-monitor-rejected-command-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    await fs.writeFile(captureFile, "Unrecognized command '/now'. Type \"/\" for a list of supported commands.\n\u203a \n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
    };
    await createThread({ id: "monitor-rejected-command-thread", name: "Monitor Rejected Command Thread" }, env);
    await wakeThread("monitor-rejected-command-thread", { reason: "test" }, env);
    const input = await enqueueThreadInput("monitor-rejected-command-thread", { text: "/now \nrun this immediately" }, env);
    await updateThreadMessage("monitor-rejected-command-thread", input.id, {
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      deliveryAttempt: 1,
      deliveryPaneId: "%42",
    }, env);

    await syncRuntimeLeases(env);
    const messages = await listThreadMessages("monitor-rejected-command-thread", env);

    assert.equal(messages[0].state, "failed");
    assert.equal(messages[0].deliveryState, "failed");
    assert.equal(messages[0].observedVia, "codex_unrecognized_command");
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("runtime monitor fails awaiting inputs when Codex rejects a punctuated slash command", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-monitor-rejected-punctuation-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorCaptureFile = process.env.TMUX_CAPTURE_FILE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;

  try {
    await fs.writeFile(captureFile, "Unrecognized command '/now?'. Type \"/\" for a list of supported commands.\n\u203a \n", "utf8");
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      TMUX_CAPTURE_FILE: captureFile,
    };
    await createThread({ id: "monitor-rejected-punctuation-thread", name: "Monitor Rejected Punctuation Thread" }, env);
    await wakeThread("monitor-rejected-punctuation-thread", { reason: "test" }, env);
    const input = await enqueueThreadInput("monitor-rejected-punctuation-thread", { text: "/now?" }, env);
    await updateThreadMessage("monitor-rejected-punctuation-thread", input.id, {
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      deliveryAttempt: 1,
      deliveryPaneId: "%42",
    }, env);

    await syncRuntimeLeases(env);
    const messages = await listThreadMessages("monitor-rejected-punctuation-thread", env);

    assert.equal(messages[0].state, "failed");
    assert.equal(messages[0].deliveryState, "failed");
    assert.match(messages[0].error, /Unrecognized command '\/now\?'/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_FILE", priorCaptureFile);
  }
});

test("thread workers create a git worktree-backed child thread without resuming the parent Codex thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-home-"));
  const repo = await createTempGitRepo();
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({
    id: "parent-thread",
    name: "Parent Thread",
    cwd: repo,
    executor: { type: "codex", codexThreadId: "parent-codex-id", metadata: { codexModel: "gpt-test" } },
  }, env);

  const result = await createThreadWorker(parent.id, {
    label: "Worker A",
    task: "Investigate the feature on a parallel branch.",
    autoRun: false,
  }, env);
  const workers = await listThreadWorkers(parent.id, env);
  const messages = await listThreadMessages(result.worker.id, env);

  assert.equal(result.worker.parentThreadId, parent.id);
  assert.equal(result.worker.rootThreadId, parent.id);
  assert.equal(result.worker.workerLabel, "Worker A");
  assert.match(result.worker.branchName, /^orkestr\/Parent-Thread\//);
  assert.equal(result.worker.remoteBranch, `origin/${result.worker.branchName}`);
  assert.equal(result.worker.gitAhead, 0);
  assert.equal(result.worker.gitBehind, 0);
  assert.equal(result.worker.gitParentAhead, 0);
  assert.equal(result.worker.gitParentBehind, 0);
  assert.equal(result.worker.gitRemoteAhead, null);
  assert.equal(result.worker.gitRemoteBehind, null);
  assert.equal(result.worker.executor.codexThreadId, "");
  assert.equal(result.worker.executor.metadata.forkedFromCodexThreadId, "parent-codex-id");
  assert.match(result.worker.handoffPrompt, /Role: worker thread\. You are not the parent\/root Orkestr thread/);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].id, result.worker.id);
  assert.equal(await fs.stat(result.worker.worktreePath).then((stats) => stats.isDirectory()), true);
  assert.match(messages[0].text, /Role: worker thread\. You are not the parent\/root Orkestr thread/);
  assert.match(messages[0].text, /Work only inside this worker worktree and branch/);
  assert.match(messages[0].text, /Do not merge into, push to, or otherwise mutate main from this worker thread/);
  assert.match(messages[0].text, /parent\/root Orkestr thread owns integration, merge-to-main, push-to-main, tags, and release actions/);
  assert.match(messages[0].text, new RegExp(result.worker.branchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("thread worker creation requires a git repository path", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-missing-repo-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "no-repo-thread", name: "No Repo Thread", cwd: home }, env);
  await assert.rejects(
    () => createThreadWorker("no-repo-thread", { task: "try to fork" }, env),
    /thread_repo_not_found/,
  );
});

test("thread worker git state reports live branch and base deviation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-git-state-home-"));
  const repo = await createTempGitRepo("orkestr-thread-worker-git-state-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "git-state-parent", name: "Git State Parent", cwd: repo }, env);
  const result = await createThreadWorker(parent.id, { label: "Git State Worker", autoRun: false }, env);
  const committedPath = path.join(result.worker.worktreePath, "committed.txt");
  const dirtyPath = path.join(result.worker.worktreePath, "dirty.txt");

  await fs.writeFile(committedPath, "committed worker change\n", "utf8");
  await execFileAsync("git", ["add", "committed.txt"], { cwd: result.worker.worktreePath });
  await execFileAsync("git", ["commit", "-m", "worker change"], { cwd: result.worker.worktreePath });
  await fs.writeFile(dirtyPath, "dirty worker change\n", "utf8");

  const state = await detectThreadGitState(result.worker, env);

  assert.equal(state.branchName, result.worker.branchName);
  assert.equal(state.gitComparisonLabel, "parent");
  assert.equal(state.gitAhead, 1);
  assert.equal(state.gitBehind, 0);
  assert.equal(state.gitParentAhead, 1);
  assert.equal(state.gitParentBehind, 0);
  assert.equal(state.gitBaseAhead, 1);
  assert.equal(state.gitChangedFiles, 1);
  assert.equal(state.gitParentChangedFiles, 1);
  assert.equal(state.gitDirtyFiles, 1);
  assert.equal(state.gitRemoteMissing, true);
});

test("thread worker git state reports parent commits as behind", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-git-behind-home-"));
  const repo = await createTempGitRepo("orkestr-thread-worker-git-behind-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "git-behind-parent", name: "Git Behind Parent", cwd: repo }, env);
  const result = await createThreadWorker(parent.id, { label: "Git Behind Worker", autoRun: false }, env);

  await fs.writeFile(path.join(repo, "parent.txt"), "parent branch change\n", "utf8");
  await execFileAsync("git", ["add", "parent.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "parent change"], { cwd: repo });

  const state = await detectThreadGitState(result.worker, env);

  assert.equal(state.gitComparisonLabel, "parent");
  assert.equal(state.gitAhead, 0);
  assert.equal(state.gitBehind, 1);
  assert.equal(state.gitParentAhead, 0);
  assert.equal(state.gitParentBehind, 1);
  assert.equal(state.gitParentChangedFiles, 1);
  assert.equal(state.gitDirtyFiles, 0);
});

test("thread worker direct sync fast-forwards a clean stale worker", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-sync-home-"));
  const repo = await createTempGitRepo("orkestr-thread-worker-sync-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "git-sync-parent", name: "Git Sync Parent", cwd: repo }, env);
  const result = await createThreadWorker(parent.id, { label: "Git Sync Worker", autoRun: false }, env);

  await fs.writeFile(path.join(repo, "sync-parent.txt"), "parent sync change\n", "utf8");
  await execFileAsync("git", ["add", "sync-parent.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "parent sync change"], { cwd: repo });

  const before = await detectThreadGitState(result.worker, env);
  assert.equal(before.gitParentAhead, 0);
  assert.equal(before.gitParentBehind, 1);

  const synced = await syncThreadWorkerWithParent(result.worker.id, env);
  const after = await detectThreadGitState(synced.thread, env);
  const workerHead = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: result.worker.worktreePath }).then((result) => String(result.stdout).trim());
  const parentHead = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo }).then((result) => String(result.stdout).trim());

  assert.equal(synced.synced, true);
  assert.equal(workerHead, parentHead);
  assert.equal(after.gitParentAhead, 0);
  assert.equal(after.gitParentBehind, 0);
});

test("thread worker direct sync rejects local worker changes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-sync-reject-home-"));
  const repo = await createTempGitRepo("orkestr-thread-worker-sync-reject-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "git-sync-reject-parent", name: "Git Sync Reject Parent", cwd: repo }, env);
  const result = await createThreadWorker(parent.id, { label: "Git Sync Reject Worker", autoRun: false }, env);

  await fs.writeFile(path.join(result.worker.worktreePath, "worker.txt"), "worker change\n", "utf8");
  await execFileAsync("git", ["add", "worker.txt"], { cwd: result.worker.worktreePath });
  await execFileAsync("git", ["commit", "-m", "worker change"], { cwd: result.worker.worktreePath });

  await assert.rejects(
    () => syncThreadWorkerWithParent(result.worker.id, env),
    /worker_has_unmerged_commits/,
  );
});

test("thread worker git state uses parent checkout when stored base commit is stale", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-git-fallback-home-"));
  const repo = await createTempGitRepo("orkestr-thread-worker-git-fallback-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "git-fallback-parent", name: "Git Fallback Parent", cwd: repo }, env);
  const result = await createThreadWorker(parent.id, { label: "Git Fallback Worker", autoRun: false }, env);
  await fs.writeFile(path.join(result.worker.worktreePath, "fallback.txt"), "worker branch change\n", "utf8");
  await execFileAsync("git", ["add", "fallback.txt"], { cwd: result.worker.worktreePath });
  await execFileAsync("git", ["commit", "-m", "worker fallback change"], { cwd: result.worker.worktreePath });
  const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: result.worker.worktreePath }).then((result) => String(result.stdout).trim());

  const state = await detectThreadGitState({ ...result.worker, baseCommit: head }, env);

  assert.equal(state.gitComparisonLabel, "parent");
  assert.equal(state.gitParentAhead, 1);
  assert.equal(state.gitParentBehind, 0);
  assert.equal(state.gitBaseAhead, 1);
  assert.equal(state.gitChangedFiles, 1);
});

test("thread worker git state clears base deviation after branch is merged", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-git-merged-home-"));
  const repo = await createTempGitRepo("orkestr-thread-worker-git-merged-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "git-merged-parent", name: "Git Merged Parent", cwd: repo }, env);
  const result = await createThreadWorker(parent.id, { label: "Git Merged Worker", autoRun: false }, env);
  await fs.writeFile(path.join(result.worker.worktreePath, "merged.txt"), "worker branch change\n", "utf8");
  await execFileAsync("git", ["add", "merged.txt"], { cwd: result.worker.worktreePath });
  await execFileAsync("git", ["commit", "-m", "worker merged change"], { cwd: result.worker.worktreePath });
  await execFileAsync("git", ["merge", "--no-ff", result.worker.branchName, "-m", "merge worker"], { cwd: repo });

  const state = await detectThreadGitState({ ...result.worker, baseBranch: result.worker.branchName }, env);

  assert.equal(state.gitComparisonLabel, "parent");
  assert.equal(state.gitAhead, 0);
  assert.equal(state.gitBehind, 1);
  assert.equal(state.gitParentAhead, 0);
  assert.equal(state.gitParentBehind, 1);
  assert.equal(state.gitBaseAhead, 0);
  assert.equal(state.gitChangedFiles, 0);
  assert.equal(state.gitDirtyFiles, 0);
});

test("root thread git state ignores stale base commit when on its base branch", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-root-git-base-home-"));
  const repo = await createTempGitRepo("orkestr-thread-root-git-base-repo-");
  const env = { ORKESTR_HOME: home };
  const baseCommit = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo }).then((result) => String(result.stdout).trim());
  await fs.writeFile(path.join(repo, "root.txt"), "root thread change\n", "utf8");
  await execFileAsync("git", ["add", "root.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "root change"], { cwd: repo });
  const thread = await createThread({
    id: "root-git-state-parent",
    name: "Root Git State Parent",
    cwd: repo,
    baseBranch: "main",
    baseCommit,
  }, env);

  const state = await detectThreadGitState(thread, env);

  assert.equal(state.branchName, "main");
  assert.equal(state.gitComparisonLabel, null);
  assert.equal(state.gitBaseAhead, null);
  assert.equal(state.gitChangedFiles, null);
});

test("thread summary cache refreshes git state when HEAD changes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-summary-git-home-"));
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-summary-git-remote-"));
  const repo = await createTempGitRepo("orkestr-thread-summary-git-repo-");
  await execFileAsync("git", ["init", "--bare"], { cwd: remote });
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: repo });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: repo });
  await createThread({ id: "summary-git-thread", name: "Summary Git Thread", repoPath: repo }, { ORKESTR_HOME: home });

  const priorHome = process.env.ORKESTR_HOME;
  const priorSummaryCacheTtl = process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS;
  const priorPayloadCacheTtl = process.env.ORKESTR_THREAD_SUMMARY_PAYLOAD_CACHE_TTL_MS;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS = "120000";
  process.env.ORKESTR_THREAD_SUMMARY_PAYLOAD_CACHE_TTL_MS = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const firstPayload = await fetch(`${baseUrl}/api/threads/summary`).then((response) => response.json());
    const firstSummary = firstPayload.threads.find((thread) => thread.id === "summary-git-thread");
    assert.equal(firstSummary.gitAhead, 0);
    assert.equal(firstSummary.gitBehind, 0);
    assert.equal(firstSummary.gitRemoteAhead, 0);
    assert.equal(firstSummary.gitRemoteBehind, 0);

    await fs.writeFile(path.join(repo, "local.txt"), "local change\n", "utf8");
    await execFileAsync("git", ["add", "local.txt"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "local change"], { cwd: repo });

    const secondPayload = await fetch(`${baseUrl}/api/threads/summary`).then((response) => response.json());
    const secondSummary = secondPayload.threads.find((thread) => thread.id === "summary-git-thread");
    assert.equal(secondSummary.gitAhead, 1);
    assert.equal(secondSummary.gitBehind, 0);
    assert.equal(secondSummary.gitRemoteAhead, 1);
    assert.equal(secondSummary.gitRemoteBehind, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorSummaryCacheTtl === undefined) delete process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS;
    else process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS = priorSummaryCacheTtl;
    if (priorPayloadCacheTtl === undefined) delete process.env.ORKESTR_THREAD_SUMMARY_PAYLOAD_CACHE_TTL_MS;
    else process.env.ORKESTR_THREAD_SUMMARY_PAYLOAD_CACHE_TTL_MS = priorPayloadCacheTtl;
  }
});

test("thread summary cache refreshes worker parent comparison when parent HEAD changes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-summary-worker-git-home-"));
  const repo = await createTempGitRepo("orkestr-thread-summary-worker-git-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "summary-worker-parent", name: "Summary Worker Parent", cwd: repo }, env);
  const result = await createThreadWorker(parent.id, { label: "Summary Worker", autoRun: false }, env);

  const priorHome = process.env.ORKESTR_HOME;
  const priorSummaryCacheTtl = process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS;
  const priorPayloadCacheTtl = process.env.ORKESTR_THREAD_SUMMARY_PAYLOAD_CACHE_TTL_MS;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS = "120000";
  process.env.ORKESTR_THREAD_SUMMARY_PAYLOAD_CACHE_TTL_MS = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const firstPayload = await fetch(`${baseUrl}/api/threads/summary`).then((response) => response.json());
    const firstSummary = firstPayload.threads.find((thread) => thread.id === result.worker.id);
    assert.equal(firstSummary.gitParentAhead, 0);
    assert.equal(firstSummary.gitParentBehind, 0);

    await fs.writeFile(path.join(repo, "parent-cache.txt"), "parent cache change\n", "utf8");
    await execFileAsync("git", ["add", "parent-cache.txt"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "parent cache change"], { cwd: repo });

    const secondPayload = await fetch(`${baseUrl}/api/threads/summary`).then((response) => response.json());
    const secondSummary = secondPayload.threads.find((thread) => thread.id === result.worker.id);
    assert.equal(secondSummary.gitParentAhead, 0);
    assert.equal(secondSummary.gitParentBehind, 1);
    assert.equal(secondSummary.gitAhead, 0);
    assert.equal(secondSummary.gitBehind, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorSummaryCacheTtl === undefined) delete process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS;
    else process.env.ORKESTR_THREAD_SUMMARY_CACHE_TTL_MS = priorSummaryCacheTtl;
    if (priorPayloadCacheTtl === undefined) delete process.env.ORKESTR_THREAD_SUMMARY_PAYLOAD_CACHE_TTL_MS;
    else process.env.ORKESTR_THREAD_SUMMARY_PAYLOAD_CACHE_TTL_MS = priorPayloadCacheTtl;
  }
});

test("thread workers can be created as blank parallel chats", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-blank-home-"));
  const repo = await createTempGitRepo("orkestr-thread-worker-blank-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "blank-worker-parent", name: "Blank Worker Parent", cwd: repo }, env);

  const result = await createThreadWorker(parent.id, { label: "Blank Worker", autoRun: false }, env);
  const messages = await listThreadMessages(result.worker.id, env);

  assert.equal(result.worker.parentThreadId, parent.id);
  assert.equal(result.worker.workerLabel, "Blank Worker");
  assert.equal(result.worker.workerStatus, "created");
  assert.equal(result.worker.remoteBranch, `origin/${result.worker.branchName}`);
  assert.equal(result.worker.gitAhead, 0);
  assert.equal(result.worker.gitBehind, 0);
  assert.equal(result.worker.gitParentAhead, 0);
  assert.equal(result.worker.gitParentBehind, 0);
  assert.equal(result.worker.gitRemoteAhead, null);
  assert.equal(result.worker.gitRemoteBehind, null);
  assert.match(result.worker.handoffPrompt, /Role: worker thread\. You are not the parent\/root Orkestr thread/);
  assert.match(result.worker.handoffPrompt, /No task was supplied\. Wait for parent\/root instructions before making changes/);
  assert.equal(result.message, null);
  assert.equal(messages.length, 0);
});

test("thread repo metadata can be saved as first-class thread state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-repo-meta-"));
  const repo = await createTempGitRepo("orkestr-thread-repo-meta-repo-");
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:otcan/orkestr.git"], { cwd: repo });
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "repo-thread", name: "Repo Thread" }, env);

  const result = await updateThreadRepo("repo-thread", { repoPath: repo, branchName: "main" }, env);

  assert.equal(result.thread.repoPath, repo);
  assert.equal(result.thread.repoRemoteUrl, "git@github.com:otcan/orkestr.git");
  assert.equal(result.thread.remoteBranch, "origin/main");
  assert.equal(result.thread.branchName, "main");
  assert.equal(result.repo.repoRemoteUrl, "git@github.com:otcan/orkestr.git");
  assert.equal(result.repo.remoteBranch, "origin/main");
  assert.equal(result.repo.branchName, "main");
  assert.match(result.thread.baseCommit, /^[0-9a-f]{40}$/);
});

test("thread summary exposes latest delivery failure details", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-summary-failure-home-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({ id: "summary-failure-thread", name: "Summary Failure Thread" }, env);
  await appendThreadMessage("summary-failure-thread", {
    role: "user",
    text: "/now failed",
    state: "failed",
    deliveryState: "failed",
    error: "Codex rejected /now.",
  }, env);

  const summary = await threadRuntimeSummary(thread, await listThreadMessages(thread.id, env));

  assert.equal(summary.lastMessageState, "failed");
  assert.equal(summary.lastMessageDeliveryState, "failed");
  assert.equal(summary.lastMessageError, "Codex rejected /now.");
});

test("thread summary treats proposed plan tags as plan messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-summary-proposed-plan-home-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({ id: "summary-proposed-plan-thread", name: "Summary Proposed Plan Thread" }, env);
  await appendThreadMessage("summary-proposed-plan-thread", {
    role: "assistant",
    phase: "final_answer",
    text: [
      "<proposed plan>",
      "Next should be **real-world launch validation**, not more feature work.",
      "",
      "1. Pair the first browser",
      "</proposed plan>",
    ].join("\n"),
  }, env);

  const summary = await threadRuntimeSummary(thread, await listThreadMessages(thread.id, env));

  assert.equal(summary.lastMessagePhase, "plan");
  assert.equal(summary.planAvailable, true);
});

test("thread summary keeps inline proposed plan mentions as final answers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-summary-inline-proposed-plan-home-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({ id: "summary-inline-proposed-plan-thread", name: "Summary Inline Proposed Plan Thread" }, env);
  await appendThreadMessage("summary-inline-proposed-plan-thread", {
    role: "assistant",
    phase: "final_answer",
    text: "Mentioning `<proposed_plan>` inline should not make this message a plan.",
  }, env);

  const summary = await threadRuntimeSummary(thread, await listThreadMessages(thread.id, env));

  assert.equal(summary.lastMessagePhase, "final_answer");
  assert.equal(summary.planAvailable, false);
});

test("thread input commands strip /now before runtime delivery", () => {
  assert.deepEqual(parseThreadInputCommand({ text: "/now run this immediately" }), {
    command: "interrupt",
    rawCommand: "now",
    text: "run this immediately",
  });
  assert.deepEqual(parseThreadInputCommand({ text: "/now \nI want this handled immediately" }), {
    command: "interrupt",
    rawCommand: "now",
    text: "I want this handled immediately",
  });
  assert.deepEqual(parseThreadInputCommand({ text: "/implement" }), {
    command: "implement",
    rawCommand: "implement",
    text: "",
  });
  assert.deepEqual(parseThreadInputCommand({ text: "/stop" }), {
    command: "stop",
    rawCommand: "stop",
    text: "",
  });
  assert.deepEqual(parseThreadInputCommand({ text: "/reset" }), {
    command: "reset",
    rawCommand: "reset",
    text: "",
  });
  assert.deepEqual(parseThreadInputCommand({ text: "/restart" }), {
    command: "reset",
    rawCommand: "restart",
    text: "",
  });
  assert.deepEqual(parseThreadInputCommand({ text: "/hard_reset" }), {
    command: "hard_reset",
    rawCommand: "hard_reset",
    text: "",
  });
  assert.deepEqual(parseThreadInputCommand({ text: "/hard-reset" }), {
    command: "hard_reset",
    rawCommand: "hard-reset",
    text: "",
  });
  assert.deepEqual(parseThreadInputCommand({ text: "/plan write tests" }), {
    command: "plan",
    rawCommand: "plan",
    text: "write tests",
  });
  assert.deepEqual(parseThreadInputCommand({ text: "/code" }), {
    command: "code",
    rawCommand: "code",
    text: "",
  });
  assert.equal(parseThreadInputCommand({ text: "normal message" }).command, null);
});

test("thread runtime summary reads Codex model and limits from live metadata", async (t) => {
  try {
    await execFileAsync("sqlite3", ["--version"]);
  } catch {
    t.skip("sqlite3 unavailable");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-metadata-api-"));
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-workspace-"));
  const codexThreadId = "11111111-1111-4111-8111-111111111111";
  const rolloutPath = path.join(codexHome, "sessions", "rollout-metadata.jsonl");
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.writeFile(rolloutPath, `${JSON.stringify({
    timestamp: "2026-05-16T10:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 120,
          cached_input_tokens: 40,
          output_tokens: 30,
          reasoning_output_tokens: 10,
          total_tokens: 150,
        },
        last_token_usage: {
          input_tokens: 70,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 80,
        },
        model_context_window: 258400,
      },
      rate_limits: {
        primary: { used_percent: 12, window_minutes: 300, resets_at: 1770000000 },
        secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1770500000 },
        plan_type: "pro",
      },
    },
  })}\n`, "utf8");
  const nowMs = Date.now();
  await execFileAsync("sqlite3", [path.join(codexHome, "state_5.sqlite"), [
    "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, archived integer not null default 0, model text, reasoning_effort text, created_at_ms integer, updated_at_ms integer);",
    `insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, archived, model, reasoning_effort, created_at_ms, updated_at_ms) values (${sqlQuote(codexThreadId)}, ${sqlQuote(rolloutPath)}, ${Math.floor(nowMs / 1000)}, ${Math.floor(nowMs / 1000)}, 'codex', 'openai', ${sqlQuote(workspace)}, 'Metadata Thread', 'workspace-write', 'never', 99, 0, 'gpt-test-codex', 'high', ${nowMs}, ${nowMs});`,
  ].join("\n")]);

  const priorHome = process.env.ORKESTR_HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.ORKESTR_HOME = home;
  process.env.CODEX_HOME = codexHome;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await createThread({ id: "metadata-api-thread", name: "Metadata API Thread", cwd: workspace }, { ORKESTR_HOME: home });
    const response = await fetch(`${baseUrl}/api/threads/metadata-api-thread/runtime-lite`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.codexThreadId, codexThreadId);
    assert.equal(payload.threadId, codexThreadId);
    assert.equal(payload.codexModel, "gpt-test-codex");
    assert.equal(payload.codexReasoningEffort, "high");
    assert.equal(payload.codexContextWindow, 258400);
    assert.equal(payload.codexTokenUsage.total_tokens, 80);
    assert.equal(payload.codexTotalTokenUsage.total_tokens, 150);
    assert.equal(payload.codexRateLimits.primary.used_percent, 12);
    assert.equal(payload.codexRateLimits.secondary.used_percent, 34);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
  }
});

test("thread runtime sync surfaces Codex plan questions as pending input", async (t) => {
  try {
    await execFileAsync("sqlite3", ["--version"]);
  } catch {
    t.skip("sqlite3 unavailable");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-plan-question-"));
  const fakeTmux = await createFakeTmux(home);
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-plan-question-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-plan-workspace-"));
  const codexThreadId = "22222222-2222-4222-8222-222222222222";
  const rolloutPath = path.join(codexHome, "sessions", "rollout-plan-question.jsonl");
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.writeFile(rolloutPath, "", "utf8");
  const nowMs = Date.now();
  await execFileAsync("sqlite3", [path.join(codexHome, "state_5.sqlite"), [
    "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, archived integer not null default 0, model text, reasoning_effort text, created_at_ms integer, updated_at_ms integer);",
    `insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, archived, model, reasoning_effort, created_at_ms, updated_at_ms) values (${sqlQuote(codexThreadId)}, ${sqlQuote(rolloutPath)}, ${Math.floor(nowMs / 1000)}, ${Math.floor(nowMs / 1000)}, 'codex', 'openai', ${sqlQuote(workspace)}, 'Plan Question Thread', 'workspace-write', 'never', 0, 0, 'gpt-test-codex', 'medium', ${nowMs}, ${nowMs});`,
  ].join("\n")]);

  const priorHome = process.env.ORKESTR_HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.CODEX_HOME = codexHome;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  let server = null;

  try {
    const env = {
      ORKESTR_HOME: process.env.ORKESTR_HOME,
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: codexHome,
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
    };
    await createThread({
      id: "plan-question-thread",
      name: "Plan Question Thread",
      cwd: workspace,
      executor: { type: "codex", codexThreadId },
    }, env);
    await wakeThread("plan-question-thread", { reason: "test" }, env);
    await fs.appendFile(rolloutPath, `${JSON.stringify({
      timestamp: "2026-05-16T21:23:24.316Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_plan_questions",
        arguments: JSON.stringify({
          questions: [
            {
              header: "First Step",
              id: "first_step",
              question: "What should a brand-new user accomplish first?",
              options: [
                { label: "Connect accounts", description: "Prioritize connector setup before timers." },
                { label: "Create timer", description: "Prioritize scheduling the first workflow." },
              ],
            },
          ],
        }),
      },
    })}\n`, "utf8");

    await syncRuntimeLeases(env);
    const messages = await listThreadMessages("plan-question-thread", env);
    const planQuestion = messages.find((message) => message.phase === "need_input");

    assert.ok(planQuestion);
    assert.equal(planQuestion.role, "assistant");
    assert.match(planQuestion.text, /Codex needs input to continue/);
    assert.match(planQuestion.text, /What should a brand-new user accomplish first\?/);
    assert.match(planQuestion.text, /A\. Connect accounts: Prioritize connector setup before timers\./);

    server = await startServer({ port: 0, host: "127.0.0.1" });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const response = await fetch(`${baseUrl}/api/threads/plan-question-thread/messages`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.awaitingInput, true);
    assert.equal(payload.awaitingInputEventId, planQuestion.eventId);
    assert.equal(payload.pendingQuestion.text, planQuestion.text);

    await appendThreadMessage("plan-question-thread", {
      role: "user",
      source: "whatsapp_inbound",
      text: "Connect accounts",
      createdAt: "2026-05-16T21:24:00.000Z",
    }, env);
    const answeredResponse = await fetch(`${baseUrl}/api/threads/plan-question-thread/messages`);
    const answeredPayload = await answeredResponse.json();

    assert.equal(answeredResponse.status, 200);
    assert.equal(answeredPayload.awaitingInput, false);
    assert.equal(answeredPayload.pendingQuestion, null);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    restoreEnvValue("ORKESTR_HOME", priorHome);
    restoreEnvValue("CODEX_HOME", priorCodexHome);
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
  }
});

test("thread runtime sync catches recent rollout replies that predate wake cursor", async (t) => {
  try {
    await execFileAsync("sqlite3", ["--version"]);
  } catch {
    t.skip("sqlite3 unavailable");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-rollout-lookback-"));
  const fakeTmux = await createFakeTmux(home);
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-rollout-lookback-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-lookback-workspace-"));
  const codexThreadId = "33333333-3333-4333-8333-333333333333";
  const rolloutPath = path.join(codexHome, "sessions", "rollout-lookback.jsonl");
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  const replyText = "Yes, I tried it live on TEST, and this approach works.";
  await fs.writeFile(rolloutPath, [
    JSON.stringify({
      timestamp: "2026-05-18T06:53:36.976Z",
      type: "event_msg",
      payload: { type: "agent_message", message: replyText, phase: "final_answer" },
    }),
    JSON.stringify({
      timestamp: "2026-05-18T06:53:36.977Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: replyText }],
        phase: "final_answer",
      },
    }),
    "",
  ].join("\n"), "utf8");
  const nowMs = Date.now();
  await execFileAsync("sqlite3", [path.join(codexHome, "state_5.sqlite"), [
    "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, archived integer not null default 0, model text, reasoning_effort text, created_at_ms integer, updated_at_ms integer);",
    `insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, archived, model, reasoning_effort, created_at_ms, updated_at_ms) values (${sqlQuote(codexThreadId)}, ${sqlQuote(rolloutPath)}, ${Math.floor(nowMs / 1000)}, ${Math.floor(nowMs / 1000)}, 'codex', 'openai', ${sqlQuote(workspace)}, 'Lookback Thread', 'workspace-write', 'never', 0, 0, 'gpt-test-codex', 'medium', ${nowMs}, ${nowMs});`,
  ].join("\n")]);

  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: codexHome,
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
      ORKESTR_ROLLOUT_SYNC_LOOKBACK_BYTES: "8192",
    };
    await createThread({
      id: "rollout-lookback-thread",
      name: "Rollout Lookback Thread",
      cwd: workspace,
      executor: { type: "codex", codexThreadId },
    }, env);
    const inbound = await appendThreadMessage("rollout-lookback-thread", {
      role: "user",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "120000000000000000@g.us",
      accountId: "account-1",
      text: "stop. Can you try this?",
      createdAt: "2026-05-18T06:52:05.972Z",
    }, env);
    await appendThreadMessage("rollout-lookback-thread", {
      role: "assistant",
      source: "codex-rollout",
      phase: "commentary",
      text: "Newer visible progress.",
      createdAt: "2026-05-18T07:00:00.000Z",
    }, env);

    await wakeThread("rollout-lookback-thread", { reason: "test" }, env);
    await syncRuntimeLeases(env);
    await syncRuntimeLeases(env);
    const messages = await listThreadMessages("rollout-lookback-thread", env);
    const replies = messages.filter((message) => message.role === "assistant" && message.text === replyText);
    const thread = (await listThreads(env)).find((item) => item.id === "rollout-lookback-thread");
    const summary = await threadRuntimeSummary(thread, messages);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].createdAt, "2026-05-18T06:53:36.977Z");
    assert.equal(replies[0].parentMessageId, inbound.id);
    assert.equal(replies[0].connector, "whatsapp");
    assert.equal(replies[0].chatId, "120000000000000000@g.us");
    assert.equal(summary.lastMessageAt, "2026-05-18T07:00:00.000Z");
    assert.equal(summary.lastMessagePhase, "commentary");
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
  }
});

test("thread APIs create, queue, run, and list messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "api-thread", name: "API Thread", executorId: "noop" }),
    });
    const input = await fetch(`${baseUrl}/api/threads/api-thread/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "run this", autoRun: false }),
    });
    const run = await fetch(`${baseUrl}/api/threads/api-thread/run-next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const listed = await fetch(`${baseUrl}/api/threads/api-thread/messages`);
    const summarized = await fetch(`${baseUrl}/api/threads`);

    assert.equal(created.status, 201);
    assert.equal(input.status, 202);
    assert.equal(run.status, 200);
    const payload = await listed.json();
    assert.equal(payload.thread.id, "api-thread");
    assert.equal(payload.messages.length, 2);
    const summaryPayload = await summarized.json();
    const summary = summaryPayload.threads.find((thread) => thread.id === "api-thread");
    assert.equal(summary.lastMessageRole, "assistant");
    assert.equal(summary.lastMessagePhase, "final_answer");
    assert.ok(summary.lastMessageAt);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});

test("thread message API hides adjacent duplicate rollout assistant records", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-duplicate-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await createThread({ id: "duplicate-api-thread", name: "Duplicate API Thread" }, { ORKESTR_HOME: home });
    await appendThreadMessage("duplicate-api-thread", {
      role: "assistant",
      source: "codex-rollout",
      phase: "final_answer",
      text: "same final answer",
      createdAt: "2026-05-16T10:00:00.000Z",
    }, { ORKESTR_HOME: home });
    await appendThreadMessage("duplicate-api-thread", {
      role: "assistant",
      source: "codex-rollout",
      phase: "final_answer",
      text: "same final answer",
      createdAt: "2026-05-16T10:00:00.500Z",
    }, { ORKESTR_HOME: home });

    const listed = await fetch(`${baseUrl}/api/threads/duplicate-api-thread/messages`);
    const payload = await listed.json();

    assert.equal(listed.status, 200);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].text, "same final answer");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});

test("thread API creates worker threads", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-api-"));
  const repo = await createTempGitRepo("orkestr-worker-api-repo-");
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "worker-api-parent", name: "Worker API Parent", cwd: repo }),
    });
    const created = await fetch(`${baseUrl}/api/threads/worker-api-parent/workers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Worker API", task: "Build this in a worker.", autoRun: false, wake: false }),
    });
    const payload = await created.json();
    const listed = await fetch(`${baseUrl}/api/threads/worker-api-parent/workers`);
    const listPayload = await listed.json();
    const repoUpdate = await fetch(`${baseUrl}/api/threads/worker-api-parent/repo`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: repo, branchName: "main" }),
    });
    const repoPayload = await repoUpdate.json();

    assert.equal(created.status, 201);
    assert.equal(payload.worker.parentThreadId, "worker-api-parent");
    assert.match(payload.worker.branchName, /^orkestr\/Worker-API-Parent\//);
    assert.equal(listPayload.workers.length, 1);
    assert.equal(repoUpdate.status, 200);
    assert.equal(repoPayload.thread.repoPath, repo);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});
