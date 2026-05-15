import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoOverlayDir = path.join(repoRoot, "examples", "job-search-demo");

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitFor(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry while the server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startMockWhatsAppBridge() {
  const sent = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ready: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/send-text") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      sent.push({
        authorization: req.headers.authorization || "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ids: [`demo-${sent.length}`] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function startOrkestr(home, port, bridgeUrl) {
  const child = spawn(process.execPath, ["apps/server/src/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ORKESTR_HOME: home,
      ORKESTR_OVERLAY_DIR: demoOverlayDir,
      ORKESTR_PORT: String(port),
      ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
      WHATSAPP_BRIDGE_URL: bridgeUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-job-demo-"));
const port = Number(process.env.ORKESTR_JOB_DEMO_PORT || 19814);
const baseUrl = `http://127.0.0.1:${port}`;
const bridge = await startMockWhatsAppBridge();
let server = null;

try {
  server = startOrkestr(home, port, bridge.url);
  await waitFor(`${baseUrl}/api/health`);
  await request(baseUrl, "/api/agents/templates/job-search-assistant", { method: "POST" });
  await request(baseUrl, "/api/connectors/whatsapp/config", {
    method: "POST",
    body: JSON.stringify({
      bridgeUrl: bridge.url,
      apiToken: "demo-token",
      routes: { "demo-chat@g.us": "job-search-assistant" },
    }),
  });
  await request(baseUrl, "/api/connectors/whatsapp/inbound", {
    method: "POST",
    body: JSON.stringify({
      eventId: "demo-wa-1",
      chatId: "demo-chat@g.us",
      from: "demo-user",
      text: "Any recruiting messages worth answering today?",
    }),
  });
  const run = await request(baseUrl, "/api/agents/job-search-assistant/run-next", { method: "POST" });
  const messages = await request(baseUrl, "/api/agents/job-search-assistant/messages");

  if (run.execution.executorId !== "job-search-demo") throw new Error("demo executor was not selected");
  if (messages.messages.length !== 2) throw new Error("expected one user message and one assistant reply");
  if (bridge.sent.length !== 1) throw new Error(`expected one WhatsApp mirror, got ${bridge.sent.length}`);
  if (bridge.sent[0].authorization !== "Bearer demo-token") throw new Error("WhatsApp bridge token was not sent");
  if (bridge.sent[0].body.to !== "demo-chat@g.us") throw new Error("WhatsApp reply was sent to the wrong chat");
  if (!bridge.sent[0].body.text.includes("Recruiting lead")) throw new Error("demo reply did not include recruiting summary");

  console.log("Job-search demo passed");
} finally {
  await stop(server);
  await bridge.close();
  await fs.rm(home, { recursive: true, force: true });
}
