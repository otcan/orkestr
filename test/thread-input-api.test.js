import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { runtimeStatus, wakeThread } from "../packages/core/src/runtime-leases.js";
import { createThread } from "../packages/core/src/threads.js";

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
    printf '%%42\\n'
    exit 0
    ;;
  capture-pane)
    if [ -n "\${TMUX_CAPTURE_FILE:-}" ] && [ -f "\${TMUX_CAPTURE_FILE:-}" ]; then
      cat "\${TMUX_CAPTURE_FILE:-}"
    else
      printf '› \\n'
    fi
    exit 0
    ;;
  set-window-option|rename-window|load-buffer|paste-buffer|delete-buffer|send-keys)
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

test("thread input API returns queued message without synchronous runtime delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-input-api-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  await fs.writeFile(captureFile, "› \n", "utf8");

  const envKeys = [
    "ORKESTR_HOME",
    "HOME",
    "CODEX_HOME",
    "PATH",
    "TMUX_LOG",
    "TMUX_STATE",
    "TMUX_CAPTURE_FILE",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_CODEX_AUTH_PREFLIGHT",
    "ORKESTR_DELIVERY_ACK_WAIT_MS",
    "ORKESTR_DELIVERY_ACK_BACKOFF_MS",
  ];
  const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.ORKESTR_HOME = path.join(home, "orkestr-home");
  process.env.HOME = path.join(home, "runtime-home");
  process.env.CODEX_HOME = path.join(home, "codex-home");
  process.env.PATH = `${fakeTmux.bin}:${priorEnv.PATH || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  process.env.ORKESTR_AUTH_REQUIRED = "0";
  process.env.ORKESTR_CODEX_AUTH_PREFLIGHT = "0";
  process.env.ORKESTR_DELIVERY_ACK_WAIT_MS = "0";
  process.env.ORKESTR_DELIVERY_ACK_BACKOFF_MS = "10000";

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    await createThread({ id: "enqueue-only-thread", name: "Enqueue Only Thread" });
    await wakeThread("enqueue-only-thread", { reason: "test_ready_runtime" });
    const status = await runtimeStatus("enqueue-only-thread");
    assert.equal(status.state, "ready");
    assert.equal(status.promptReady, true);

    const response = await fetch(`http://127.0.0.1:${port}/api/threads/enqueue-only-thread/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "browser",
        clientMessageId: "browser-http-send-1",
        text: "hello enqueue-only",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 202);
    assert.equal(payload.ok, true);
    assert.equal(payload.queued, true);
    assert.equal(payload.queueItemId, payload.message.id);
    assert.deepEqual(payload.delivered, []);
    assert.equal(payload.deliveryState, "queued");
    assert.equal(payload.reason, "pending_delivery");
    assert.equal(payload.message.state, "queued");
    assert.equal(payload.message.clientMessageId, "browser-http-send-1");
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const key of envKeys) restoreEnvValue(key, priorEnv[key]);
  }
});
