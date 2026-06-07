import assert from "node:assert/strict";
import test from "node:test";
import { threadNeedsCodexAppServerMigration, threadUsesCodexAppServer } from "../packages/core/src/codex-app-server-common.js";
import {
  rawTerminalModePatch,
  rawTerminalSessionName,
  rawTerminalTtlMs,
  threadUsesRawTerminalMode,
} from "../packages/core/src/raw-terminal-mode.js";

test("raw terminal mode uses canonical thread tmux names and bypasses app-server migration guard", () => {
  const thread = {
    id: "abc 123",
    executor: {
      id: "codex",
      type: "codex",
      codexThreadId: "019ea1a1-ff15-74a2-a9d1-0eecc7c3cb94",
      transport: "app-server",
      metadata: {
        transport: "app-server",
        runtimeKind: "codex-app-server",
      },
    },
    runtime: {
      runtimeKind: "codex-app-server",
    },
  };

  assert.equal(rawTerminalSessionName(thread), "orkestr-thread-abc_123");
  assert.equal(threadUsesCodexAppServer(thread), true);

  const patched = { ...thread, ...rawTerminalModePatch(thread) };
  assert.equal(threadUsesRawTerminalMode(patched), true);
  assert.equal(threadUsesCodexAppServer(patched), false);
  assert.equal(threadNeedsCodexAppServerMigration(patched), false);
  assert.equal(patched.executor.transport, "raw-terminal");
  assert.equal(patched.runtime.runtimeKind, "raw-terminal");
});

test("raw terminal ttl defaults to fifteen minutes and can be disabled explicitly", () => {
  assert.equal(rawTerminalTtlMs({}), 15 * 60_000);
  assert.equal(rawTerminalTtlMs({ ORKESTR_RAW_TERMINAL_TTL_MS: "1000" }), 1000);
  assert.equal(rawTerminalTtlMs({ ORKESTR_RAW_TERMINAL_TTL_MS: "off" }), 0);
});
