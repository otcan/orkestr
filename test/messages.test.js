import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enqueueAgentMessage, listAgentMessages } from "../packages/core/src/messages.js";

test("agent messages are queued and persisted", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-messages-"));
  const env = { ORKESTR_HOME: home };
  const message = await enqueueAgentMessage("coding-agent", { text: "Check repo" }, env);
  const messages = await listAgentMessages("coding-agent", env);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, message.id);
  assert.equal(messages[0].state, "queued");
});
