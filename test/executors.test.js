import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listExecutions, listExecutorAdapters, runNextAgentMessage } from "../packages/core/src/executors.js";
import { enqueueAgentMessage, listAgentMessages } from "../packages/core/src/messages.js";

test("noop executor completes the next queued agent message", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-executors-"));
  const env = { ORKESTR_HOME: home };
  await enqueueAgentMessage("job-search-assistant", { text: "hello executor" }, env);

  const adapters = listExecutorAdapters();
  const execution = await runNextAgentMessage("job-search-assistant", { executorId: "noop" }, env);
  const messages = await listAgentMessages("job-search-assistant", env);
  const executions = await listExecutions(env);

  assert.ok(adapters.some((adapter) => adapter.id === "noop"));
  assert.equal(execution.state, "completed");
  assert.equal(messages[0].state, "completed");
  assert.equal(executions.length, 1);
});

