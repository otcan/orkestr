import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverPendingThreadInputs, setThreadInputDeliveryFailureHandler, sleepThread, wakeThread } from "../packages/core/src/runtime-leases.js";
import {
  appendThreadMessage,
  createThread,
  listThreadMessages,
  updateThreadMessage,
} from "../packages/core/src/threads.js";

process.env.ORKESTR_CODEX_AUTH_PREFLIGHT ||= "0";

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
  send-keys|set-window-option|rename-window)
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

async function withFakeRuntime(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-control-delivery-"));
  const fakeTmux = await createFakeTmux(home);
  const captureFile = path.join(home, "pane.txt");
  const prior = {
    PATH: process.env.PATH,
    TMUX_LOG: process.env.TMUX_LOG,
    TMUX_STATE: process.env.TMUX_STATE,
    TMUX_CAPTURE_FILE: process.env.TMUX_CAPTURE_FILE,
  };
  process.env.PATH = `${fakeTmux.bin}:${prior.PATH || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;
  process.env.TMUX_CAPTURE_FILE = captureFile;
  await fs.writeFile(captureFile, "› \n", "utf8");
  try {
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
      ORKESTR_DELIVERY_STALE_ACK_RECOVERY_MAX: "1",
    };
    await fn(env, fakeTmux);
  } finally {
    restoreEnvValue("PATH", prior.PATH);
    restoreEnvValue("TMUX_LOG", prior.TMUX_LOG);
    restoreEnvValue("TMUX_STATE", prior.TMUX_STATE);
    restoreEnvValue("TMUX_CAPTURE_FILE", prior.TMUX_CAPTURE_FILE);
  }
}

test("thread control reset preempts a stale awaiting ack", async () => {
  await withFakeRuntime(async (env, fakeTmux) => {
    await createThread({ id: "control-preempt-thread", name: "Control Preempt" }, env);
    await wakeThread("control-preempt-thread", { reason: "test" }, env);
    const blocked = await appendThreadMessage("control-preempt-thread", {
      role: "user",
      text: "old blocked input",
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      createdAt: "2026-05-20T10:00:00.000Z",
    }, env);
    await updateThreadMessage("control-preempt-thread", blocked.id, {
      deliveryAttempt: 1,
      deliveryNextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    }, env);
    const reset = await appendThreadMessage("control-preempt-thread", {
      role: "user",
      text: "/restart",
      state: "queued",
      createdAt: "2026-05-20T10:01:00.000Z",
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("control-preempt-thread", env), [reset.id]);
    const messages = await listThreadMessages("control-preempt-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(messages[0].state, "failed");
    assert.equal(messages[0].deliveryState, "superseded");
    assert.equal(messages[0].observedVia, "thread_control_command_superseded_ack");
    assert.equal(messages[1].state, "completed");
    assert.equal(messages[1].observedVia, "orkestr_reset_command");
    assert.match(log, /__CALL__\tkill-session\t-t\torkestr-control-preempt-thread/);
  });
});

test("sleeping an active runtime appends a pane interruption notice", async () => {
  await withFakeRuntime(async (env) => {
    await createThread({ id: "sleep-notice-thread", name: "Sleep Notice" }, env);
    await wakeThread("sleep-notice-thread", { reason: "test" }, env);

    await sleepThread("sleep-notice-thread", { reason: "ui_stop", kill: true }, env);
    const messages = await listThreadMessages("sleep-notice-thread", env);
    const notice = messages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.ok(notice);
    assert.equal(notice.role, "assistant");
    assert.match(notice.text, /Codex pane interrupted/);
    assert.match(notice.text, /stopped from the UI/);
  });
});

test("awaiting ack checks do not paste duplicate input into the same ready pane", async () => {
  await withFakeRuntime(async (env, fakeTmux) => {
    env.ORKESTR_DELIVERY_STALE_ACK_RECOVERY_ATTEMPTS = "3";
    await createThread({ id: "ack-no-duplicate-thread", name: "Ack No Duplicate" }, env);
    await wakeThread("ack-no-duplicate-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("ack-no-duplicate-thread", {
      role: "user",
      text: "do not stack this",
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
    }, env);
    await updateThreadMessage("ack-no-duplicate-thread", input.id, {
      deliveryAttempt: 1,
      deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("ack-no-duplicate-thread", env), []);
    const messages = await listThreadMessages("ack-no-duplicate-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");
    const updated = messages.find((message) => message.id === input.id);

    assert.equal(updated.state, "awaiting_ack");
    assert.equal(updated.deliveryAttempt, 1);
    assert.equal(updated.deliveryAckCheckCount, 2);
    assert.equal(updated.deliveryState, "awaiting_ack_unobserved");
    assert.doesNotMatch(log, /__CALL__\tload-buffer/);
    assert.doesNotMatch(log, /__CALL__\tpaste-buffer/);
  });
});

test("stale ack recovery appends a WhatsApp-visible pane interruption notice", async () => {
  await withFakeRuntime(async (env) => {
    await createThread({ id: "stale-ack-wa-notice-thread", name: "Stale Ack WA Notice" }, env);
    await wakeThread("stale-ack-wa-notice-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("stale-ack-wa-notice-thread", {
      role: "user",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-wa-notice",
      accountId: "account-1",
      text: "old invisible WhatsApp input",
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      createdAt: "2026-05-20T10:00:00.000Z",
    }, env);
    await updateThreadMessage("stale-ack-wa-notice-thread", input.id, {
      deliveryAttempt: 2,
      deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("stale-ack-wa-notice-thread", env), []);
    const messages = await listThreadMessages("stale-ack-wa-notice-thread", env);
    const notice = messages.find((message) => message.source === "orkestr_runtime" && message.phase === "runtime_interrupted");

    assert.ok(notice);
    assert.equal(notice.parentMessageId, input.id);
    assert.equal(notice.connector, "whatsapp");
    assert.equal(notice.chatId, "chat-wa-notice");
    assert.match(notice.text, /could not confirm that the previous input reached Codex/);
  });
});

test("failed WhatsApp-origin delivery notifies the delivery failure hook", async () => {
  await withFakeRuntime(async (env) => {
    await fs.writeFile(env.TMUX_CAPTURE_FILE, "› [WhatsApp: chat-wa] hi\n", "utf8");
    await createThread({ id: "wa-stuck-prompt-thread", name: "WA Stuck Prompt" }, env);
    await wakeThread("wa-stuck-prompt-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("wa-stuck-prompt-thread", {
      role: "user",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-wa",
      accountId: "main",
      text: "hi",
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      createdAt: "2026-05-20T10:00:00.000Z",
    }, env);
    await updateThreadMessage("wa-stuck-prompt-thread", input.id, {
      deliveryAttempt: 1,
      deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    }, env);

    let failure = null;
    const clear = setThreadInputDeliveryFailureHandler((payload) => {
      failure = payload;
    });
    try {
      assert.deepEqual(await deliverPendingThreadInputs("wa-stuck-prompt-thread", env), []);
    } finally {
      clear();
    }

    const messages = await listThreadMessages("wa-stuck-prompt-thread", env);
    assert.equal(messages.find((message) => message.id === input.id)?.state, "failed");
    assert.equal(failure?.threadId, "wa-stuck-prompt-thread");
    assert.equal(failure?.messageId, input.id);
    assert.equal(failure?.connector, "whatsapp");
    assert.equal(failure?.chatId, "chat-wa");
    assert.match(failure?.reason || "", /pasted into Codex but was not accepted/);
  });
});

test("thread input delivery fails stale ack after recovery is exhausted", async () => {
  await withFakeRuntime(async (env, fakeTmux) => {
    await createThread({ id: "stale-ack-exhaust-thread", name: "Stale Ack Exhaust" }, env);
    await wakeThread("stale-ack-exhaust-thread", { reason: "test" }, env);
    const input = await appendThreadMessage("stale-ack-exhaust-thread", {
      role: "user",
      text: "old invisible input",
      state: "awaiting_ack",
      deliveryState: "awaiting_ack",
      createdAt: "2026-05-20T10:00:00.000Z",
    }, env);
    await updateThreadMessage("stale-ack-exhaust-thread", input.id, {
      deliveryAttempt: 4,
      deliveryStaleRecoveryCount: 1,
      deliveryNextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    }, env);

    assert.deepEqual(await deliverPendingThreadInputs("stale-ack-exhaust-thread", env), []);
    const messages = await listThreadMessages("stale-ack-exhaust-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(messages.find((message) => message.id === input.id)?.state, "failed");
    assert.equal(messages.find((message) => message.id === input.id)?.observedVia, "stale_ack_recovery_exhausted");
    assert.doesNotMatch(log, /__CALL__\tkill-session\t-t\torkestr-stale-ack-exhaust-thread/);
  });
});
