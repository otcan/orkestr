// Gap 4 (docs/spec/conformance.md): Claude Code progress reaches callers of
// every origin through onProgress; only WhatsApp-origin inputs are persisted
// as thread commentary.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeCodeProgressReporter } from "../packages/core/src/claude-code-progress.js";

const toolEvent = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo example-secret-value" } }] } };

test("non-WhatsApp inputs get progress through onProgress without thread commentary", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-progress-"));
  const env = { ORKESTR_HOME: home, ORKESTR_CLAUDE_PROGRESS_LABEL_FALLBACK_MS: "0", ORKESTR_CLAUDE_PROGRESS_MIN_INTERVAL_MS: "0" };
  const seen = [];
  const reporter = createClaudeCodeProgressReporter({
    thread: { id: "thread-example" },
    parentMessage: { id: "message-example", source: "api" },
    attemptId: "attempt-example",
    onProgress: (event) => seen.push(event),
  }, env);
  await reporter.start();
  reporter.observe(toolEvent);
  await reporter.heartbeat(65_000);
  await reporter.flush();
  assert.deepEqual(seen.map((event) => event.kind), ["progress", "progress", "heartbeat"]);
  assert.match(seen[0].text, /started working/);
  assert.match(seen[1].text, /running a repository command/);
  assert.ok(!JSON.stringify(seen).includes("example-secret-value"), "tool input never reaches progress");
  assert.deepEqual(await fs.readdir(home), [], "nothing is persisted for a non-connector input");
});

test("without onProgress a non-WhatsApp input stays silent", async () => {
  const reporter = createClaudeCodeProgressReporter({ thread: { id: "t" }, parentMessage: { id: "m", source: "api" } }, {});
  await reporter.start();
  await reporter.heartbeat(1_000);
});
