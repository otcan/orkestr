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
  assert.equal(messages.length, 2);
  assert.equal(messages[0].state, "completed");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].parentMessageId, messages[0].id);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].assistantMessageId, messages[1].id);
});

test("overlay executor modules can provide the default executor", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-overlay-executor-home-"));
  const overlayDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-overlay-executor-"));
  await fs.mkdir(path.join(overlayDir, "executors"));
  await fs.writeFile(
    path.join(overlayDir, "overlay.json"),
    JSON.stringify({ executors: { default: "test-private", modules: ["./executors/test-private.js"] } }, null, 2),
  );
  await fs.writeFile(
    path.join(overlayDir, "executors", "test-private.js"),
    `export const executorAdapter = {
      id: "test-private",
      label: "Test Private",
      async run({ message }) {
        return { output: "private:" + message.text };
      }
    };\n`,
  );
  const env = { ORKESTR_HOME: home, ORKESTR_OVERLAY_DIR: overlayDir };
  await enqueueAgentMessage("demo", { text: "hello" }, env);

  const execution = await runNextAgentMessage("demo", {}, env);
  const messages = await listAgentMessages("demo", env);

  assert.equal(execution.executorId, "test-private");
  assert.equal(messages[1].text, "private:hello");
});
