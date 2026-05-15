import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSetupStatus } from "../packages/core/src/setup.js";

test("setup status includes the V1 connector set", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-checks-"));
  const status = await getSetupStatus({ env: { ORKESTR_HOME: home }, home });
  const ids = status.connectors.map((connector) => connector.id);
  assert.deepEqual(ids, ["openai", "codex", "gmail", "linkedin", "whatsapp", "browsers", "timers"]);
});

test("OpenAI reports connected when OPENAI_API_KEY exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-openai-"));
  const status = await getSetupStatus({ env: { ORKESTR_HOME: home, OPENAI_API_KEY: "test" }, home });
  const openai = status.connectors.find((connector) => connector.id === "openai");
  assert.equal(openai.state, "connected");
});
