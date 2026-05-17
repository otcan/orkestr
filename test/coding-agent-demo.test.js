import assert from "node:assert/strict";
import test from "node:test";
import { runCodingAgentDemo } from "../scripts/coding-agent-demo.mjs";

test("coding-agent demo creates a thread, prepares desktop, and queues work", async () => {
  const result = await runCodingAgentDemo({ port: 19816, log: false });

  assert.equal(result.thread.id, "demo-coding-agent");
  assert.equal(result.thread.executor.id, "codex");
  assert.equal(result.desktop.slug, "desktop");
  assert.equal(result.desktop.status, "prepared");
  assert.equal(result.queued, true);
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].text, /public-launch blockers/);
});
