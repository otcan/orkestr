import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  compactLabel,
  tmuxInlineCharLimit,
  tmuxWindowNameForLabel,
} from "../packages/core/src/tmux-runtime.js";

test("tmux runtime labels are compact and bounded", () => {
  assert.equal(compactLabel("  Worker\tOne\nBranch  "), "Worker One Branch");
  assert.equal(tmuxWindowNameForLabel(""), "Orkestr");
  assert.equal(tmuxWindowNameForLabel("x".repeat(80)), "x".repeat(48));
});

test("tmux inline character limit is configurable with safe fallback", () => {
  assert.equal(tmuxInlineCharLimit({ ORKESTR_TMUX_INLINE_CHAR_LIMIT: "1200" }), 1200);
  assert.equal(tmuxInlineCharLimit({ ORKESTR_TMUX_INLINE_CHAR_LIMIT: "0" }), 800);
  assert.equal(tmuxInlineCharLimit({ ORKESTR_TMUX_INLINE_CHAR_LIMIT: "not-a-number" }), 800);
});

test("Codex app-server module stays independent from tmux helpers", async () => {
  const source = await fs.readFile(new URL("../packages/core/src/codex-app-server.js", import.meta.url), "utf8");
  assert.equal(source.includes("tmux-runtime"), false);
  assert.equal(source.includes("\"tmux\""), false);
});
