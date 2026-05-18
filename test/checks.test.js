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
  assert.deepEqual(ids, ["openai", "codex", "gmail", "outlook", "linkedin", "whatsapp", "browsers", "timers"]);
});

test("OpenAI reports connected when OPENAI_API_KEY exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-openai-"));
  const status = await getSetupStatus({ env: { ORKESTR_HOME: home, OPENAI_API_KEY: "test" }, home });
  const openai = status.connectors.find((connector) => connector.id === "openai");
  assert.equal(openai.state, "connected");
});

test("Codex reports connected when the runtime OpenAI key is provided", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-key-"));
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "#!/bin/sh\necho codex-cli test\n");
  await fs.chmod(path.join(bin, "codex"), 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${priorPath || ""}`;

  try {
    const status = await getSetupStatus({ env: { ORKESTR_HOME: home, OPENAI_API_KEY: "test", ORKESTR_DOCKER: "1" }, home });
    const codex = status.connectors.find((connector) => connector.id === "codex");
    assert.equal(codex.state, "connected");
    assert.equal(codex.details.authMode, "api_key");
    assert.match(codex.summary, /OPENAI_API_KEY/);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
});

test("private overlay can provide host-native connector status", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-overlay-status-"));
  const overlayDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-overlay-status-config-"));
  const hostPath = path.join(overlayDir, "gmail-runtime");
  await fs.mkdir(hostPath);
  await fs.writeFile(
    path.join(overlayDir, "overlay.json"),
    JSON.stringify(
      {
        connectors: {
          gmail: {
            state: "connected",
            summary: "Host Gmail runtime is available.",
            requiredPaths: [hostPath],
            details: { kind: "host-native" },
          },
          linkedin: {
            state: "connected",
            summary: "Host LinkedIn runtime is available.",
            requiredPaths: [path.join(overlayDir, "missing-linkedin")],
          },
        },
      },
      null,
      2,
    ),
  );

  const status = await getSetupStatus({ env: { ORKESTR_HOME: home, ORKESTR_OVERLAY_DIR: overlayDir }, home });
  const gmail = status.connectors.find((connector) => connector.id === "gmail");
  const linkedin = status.connectors.find((connector) => connector.id === "linkedin");
  assert.equal(gmail.state, "connected");
  assert.equal(gmail.details.overlay, true);
  assert.equal(gmail.details.kind, "host-native");
  assert.equal(linkedin.state, "partial");
  assert.equal(linkedin.details.missingPaths.length, 1);
});
