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

test("gmail client secrets are stored outside public config", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-secret-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", { clientId: "client-id", clientSecret: "super-secret", redirectUri: "http://localhost/callback" }, env);

  const publicRaw = JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8"));
  const secretRaw = JSON.parse(await fs.readFile(path.join(home, "secrets", "gmail.json"), "utf8"));
  const config = await publicConfig(env);

  assert.equal(publicRaw.gmail.clientSecret, undefined);
  assert.equal(secretRaw.clientSecret, "super-secret");
  assert.equal(config.gmail.clientSecret, "supe...cret");
});
