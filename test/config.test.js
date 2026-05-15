import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSetupStatus } from "../packages/core/src/setup.js";
import { publicConfig, writeConnectorConfig } from "../packages/storage/src/config.js";

test("connector config is persisted and redacts OpenAI secrets", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-config-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("openai", { openaiApiKey: "sk-test-secret-value" }, env);

  const config = await publicConfig(env);
  assert.equal(config.openai.openaiApiKey, "sk-t...alue");

  const status = await getSetupStatus({ env, home });
  const openai = status.connectors.find((connector) => connector.id === "openai");
  assert.equal(openai.state, "connected");
});
