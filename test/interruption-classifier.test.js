import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeInterruptionHistory,
  classifyInterruptionMessage,
} from "../packages/core/src/interruption-classifier.js";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("interruption classifier detects visible classes and hides superseded runtime notices by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-interruption-classifier-"));
  const env = { ...process.env, ORKESTR_HOME: home };
  await writeJson(path.join(home, "threads.json"), [
    { id: "thread-a", name: "Alpha" },
    { id: "thread-b", name: "Beta" },
  ]);
  await writeJson(path.join(home, "thread-messages", "thread-a.json"), [
    {
      id: "user-1",
      role: "user",
      state: "completed",
      deliveryState: "delivered",
      codexTurnId: "turn-1",
      createdAt: "2026-05-30T08:00:00.000Z",
      text: "ship it",
    },
    {
      id: "notice-1",
      role: "assistant",
      source: "orkestr_runtime",
      phase: "runtime_interrupted",
      state: "completed",
      codexTurnId: "turn-1",
      createdAt: "2026-05-30T08:01:00.000Z",
      text: "Orkestr restarted before Codex finished\n\nThis notice was later superseded.",
    },
    {
      id: "final-1",
      role: "assistant",
      source: "codex-app-server",
      phase: "final_answer",
      state: "completed",
      codexTurnId: "turn-1",
      createdAt: "2026-05-30T08:02:00.000Z",
      text: "done",
    },
    {
      id: "user-2",
      role: "user",
      state: "failed",
      deliveryState: "failed",
      createdAt: "2026-05-30T08:03:00.000Z",
      text: "go",
    },
  ]);
  await writeJson(path.join(home, "thread-messages", "thread-b.json"), [
    {
      id: "notice-2",
      role: "assistant",
      source: "orkestr_runtime",
      phase: "runtime_interrupted",
      state: "completed",
      createdAt: "2026-05-30T08:04:00.000Z",
      text: "Codex stopped before final answer\n\nOrkestr found progress updates for this turn.",
    },
  ]);

  const report = await analyzeInterruptionHistory(env);
  assert.equal(report.summary.total, 2);
  assert.deepEqual(report.summary.byCategory, {
    input_delivery_failed: 1,
    codex_idle_before_final: 1,
  });
  assert.deepEqual(report.summary.byThread, { Alpha: 1, Beta: 1 });

  const withSuperseded = await analyzeInterruptionHistory(env, { includeSuperseded: true });
  assert.equal(withSuperseded.summary.total, 3);
  assert.equal(withSuperseded.summary.byCategory.deploy_or_service_restart, 1);
  assert.equal(withSuperseded.records.find((record) => record.messageId === "notice-1").superseded, true);
});

test("interruption classifier recognizes Codex-reported turn interruption text", () => {
  const classification = classifyInterruptionMessage({
    role: "assistant",
    source: "orkestr_runtime",
    phase: "runtime_interrupted",
    state: "completed",
    text: "Codex conversation interrupted\n\nCodex reported that the active turn was interrupted.",
  }, []);
  assert.equal(classification.category, "codex_turn_interrupted");
  assert.equal(classification.severity, "error");
});
