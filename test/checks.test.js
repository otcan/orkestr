import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { WebSocketServer } from "ws";
import { recordCodexRuntimeAuthInvalidSignal } from "../packages/core/src/codex-auth-health.js";
import { getSetupStatus } from "../packages/core/src/setup.js";

async function writeFakeCodex(home, lines) {
  const command = path.join(home, "codex");
  await fs.writeFile(command, lines.join("\n"), { mode: 0o755 });
  return command;
}

async function createFakeCodexWebSocketServer(socketPath) {
  await fs.rm(socketPath, { force: true }).catch(() => {});
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw || ""));
      if (message.method === "initialize") {
        ws.send(JSON.stringify({ id: message.id, result: { serverInfo: { name: "fake-codex-websocket" } } }));
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    async close() {
      for (const client of wss.clients) client.close();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(socketPath, { force: true }).catch(() => {});
    },
  };
}

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

test("Codex reports partial when the runtime key exists but Codex is not logged in", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-key-"));
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    path.join(bin, "codex"),
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo 'Not logged in'; exit 0; fi",
      "echo codex-cli test",
    ].join("\n"),
  );
  await fs.chmod(path.join(bin, "codex"), 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${priorPath || ""}`;

  try {
    const status = await getSetupStatus({ env: { ORKESTR_HOME: home, OPENAI_API_KEY: "test" }, home });
    const codex = status.connectors.find((connector) => connector.id === "codex");
    assert.equal(codex.state, "partial");
    assert.equal(codex.details.authMode, null);
    assert.equal(codex.details.openaiKeyConfigured, true);
    assert.match(codex.summary, /not signed in yet/);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
});

test("Codex reports connected when the CLI login status succeeds", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-status-"));
  const fakeCodex = await writeFakeCodex(home, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli test'; exit 0; fi",
    "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo 'Logged in using API key'; exit 0; fi",
    "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--help\" ]; then echo 'app-server help'; exit 0; fi",
    "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--listen\" ]; then",
    "  read line",
    "  echo '{\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"fake-codex\"}}}'",
    "  sleep 1",
    "  exit 0",
    "fi",
    "echo unexpected \"$@\" >&2",
    "exit 2",
  ]);

  const status = await getSetupStatus({
    env: { ORKESTR_HOME: home, CODEX_HOME: path.join(home, "codex-home"), ORKESTR_CODEX_BIN: fakeCodex },
    home,
  });
  const codex = status.connectors.find((connector) => connector.id === "codex");
  assert.equal(codex.state, "connected");
  assert.equal(codex.details.authMode, "api_key");
  assert.match(codex.summary, /signed in/);
});

test("Codex status can probe an external app-server websocket socket", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-proxy-status-"));
  const fakeCodex = await writeFakeCodex(home, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli proxy-test'; exit 0; fi",
    "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo 'Logged in using API key'; exit 0; fi",
    "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--help\" ]; then echo 'app-server help'; exit 0; fi",
    "echo unexpected \"$@\" >&2",
    "exit 2",
  ]);
  const socket = path.join(home, "run", "codex.sock");
  const server = await createFakeCodexWebSocketServer(socket);

  try {
    const status = await getSetupStatus({
      env: {
        ORKESTR_HOME: home,
        CODEX_HOME: path.join(home, "codex-home"),
        ORKESTR_CODEX_BIN: fakeCodex,
        ORKESTR_CODEX_APP_SERVER_MODE: "external",
        ORKESTR_CODEX_APP_SERVER_SOCKET: socket,
      },
      home,
    });
    const codex = status.connectors.find((connector) => connector.id === "codex");
    assert.equal(codex.state, "connected");
    assert.equal(codex.details.appServerProbe.transport, "websocket");
    assert.match(codex.summary, /signed in/);
  } finally {
    await server.close();
  }
});

test("Codex invalidates a stale auth file when CLI login status no longer works", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-stale-auth-"));
  const codexHome = path.join(home, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ token: "stale" }));
  const fakeCodex = await writeFakeCodex(home, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli test'; exit 0; fi",
    "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo 'Not logged in: refresh token expired'; exit 1; fi",
    "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--help\" ]; then echo 'app-server help'; exit 0; fi",
    "echo unexpected \"$@\" >&2",
    "exit 2",
  ]);

  const status = await getSetupStatus({
    env: { ORKESTR_HOME: home, CODEX_HOME: codexHome, ORKESTR_CODEX_BIN: fakeCodex },
    home,
  });
  const codex = status.connectors.find((connector) => connector.id === "codex");

  assert.equal(codex.state, "broken");
  assert.equal(codex.details.reason, "codex_auth_invalid");
  assert.match(codex.summary, /reconnect|sign in again/i);
});

test("Codex invalidates connected setup when app-server cannot start after an update", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-app-server-invalid-"));
  const codexHome = path.join(home, "codex-home");
  const fakeCodex = await writeFakeCodex(home, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli updated-test'; exit 0; fi",
    "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo 'Logged in using ChatGPT'; exit 0; fi",
    "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--help\" ]; then echo 'app-server help'; exit 0; fi",
    "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--listen\" ]; then echo 'Authentication failed. Run codex login again.' >&2; exit 1; fi",
    "echo unexpected \"$@\" >&2",
    "exit 2",
  ]);

  const status = await getSetupStatus({
    env: { ORKESTR_HOME: home, CODEX_HOME: codexHome, ORKESTR_CODEX_BIN: fakeCodex },
    home,
  });
  const codex = status.connectors.find((connector) => connector.id === "codex");

  assert.equal(codex.state, "broken");
  assert.equal(codex.details.reason, "codex_app_server_auth_invalid");
  assert.match(codex.summary, /codex login|sign in again|reconnect/i);
});

test("Codex invalidates connected setup when a live runtime reports token invalidated", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-runtime-invalid-"));
  const codexHome = path.join(home, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ token: "old" }));
  await recordCodexRuntimeAuthInvalidSignal({
    thread: { id: "thread-test", name: "Test" },
    progress: {
      codexAuthInvalid: true,
      codexAuthInvalidReason: "codex_token_invalidated",
      codexAuthInvalidMessage: "Codex reported an invalidated auth token.",
      summary: "Codex sign-in expired",
      tailHash: "hash-test",
    },
  }, { ORKESTR_HOME: home });
  const fakeCodex = await writeFakeCodex(home, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli runtime-invalid-test'; exit 0; fi",
    "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo 'Logged in using ChatGPT'; exit 0; fi",
    "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--help\" ]; then echo 'app-server help'; exit 0; fi",
    "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--listen\" ]; then",
    "  read line",
    "  echo '{\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"fake-codex\"}}}'",
    "  sleep 1",
    "  exit 0",
    "fi",
    "echo unexpected \"$@\" >&2",
    "exit 2",
  ]);

  const status = await getSetupStatus({
    env: { ORKESTR_HOME: home, CODEX_HOME: codexHome, ORKESTR_CODEX_BIN: fakeCodex },
    home,
  });
  const codex = status.connectors.find((connector) => connector.id === "codex");

  assert.equal(codex.state, "broken");
  assert.equal(codex.details.reason, "codex_token_invalidated");
  assert.equal(codex.details.threadId, "thread-test");
  assert.match(codex.summary, /live Codex session|login status succeeds/i);
});

test("Codex ignores runtime auth-invalid markers after auth is refreshed", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-runtime-refreshed-"));
  const codexHome = path.join(home, "codex-home");
  const authPath = path.join(codexHome, "auth.json");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(authPath, JSON.stringify({ token: "old" }));
  await recordCodexRuntimeAuthInvalidSignal({
    thread: { id: "thread-test", name: "Test" },
    progress: {
      codexAuthInvalid: true,
      codexAuthInvalidReason: "codex_token_invalidated",
      summary: "Codex sign-in expired",
      tailHash: "hash-test",
    },
  }, { ORKESTR_HOME: home });
  await sleep(20);
  await fs.writeFile(authPath, JSON.stringify({ token: "new" }));
  const fakeCodex = await writeFakeCodex(home, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli runtime-refreshed-test'; exit 0; fi",
    "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo 'Logged in using ChatGPT'; exit 0; fi",
    "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--help\" ]; then echo 'app-server help'; exit 0; fi",
    "if [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--listen\" ]; then",
    "  read line",
    "  echo '{\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"fake-codex\"}}}'",
    "  sleep 1",
    "  exit 0",
    "fi",
    "echo unexpected \"$@\" >&2",
    "exit 2",
  ]);

  const status = await getSetupStatus({
    env: { ORKESTR_HOME: home, CODEX_HOME: codexHome, ORKESTR_CODEX_BIN: fakeCodex },
    home,
  });
  const codex = status.connectors.find((connector) => connector.id === "codex");

  assert.equal(codex.state, "connected");
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
