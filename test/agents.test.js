import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentFromTemplate, listAgents } from "../packages/core/src/agents.js";

test("agent templates create stable local agent records", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-agents-"));
  const env = { ORKESTR_HOME: home };

  const first = await createAgentFromTemplate("coding-agent", env);
  const second = await createAgentFromTemplate("coding-agent", env);
  const agents = await listAgents(env);

  assert.equal(first.id, "coding-agent");
  assert.equal(first.id, second.id);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "Coding Agent");
  assert.deepEqual(agents[0].connectors, ["codex", "whatsapp", "browsers", "timers"]);
});
