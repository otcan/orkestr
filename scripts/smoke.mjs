import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitFor(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Retry while the server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function start(home, port) {
  const child = spawn(process.execPath, ["apps/server/src/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ORKESTR_HOME: home,
      PORT: String(port),
      ORKESTR_PORT: String(port),
      ORKESTR_AUTH_REQUIRED: process.env.ORKESTR_SMOKE_AUTH_REQUIRED || "0",
      ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED: "1",
      ORKESTR_PUBLIC_URL: "",
      ORKESTR_PUBLIC_APP_URL: "",
      ORKESTR_PUBLIC_AUTH_URL: "",
      ORKESTR_APP_URL: "",
      ORKESTR_PUBLIC_HTTPS_URL: "",
      ORKESTR_HTTPS_URL: "",
      ORKESTR_TAILSCALE_HTTPS_NAME: "",
      ORKESTR_CONNECT_PUBLIC_URL: "",
      ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
      ORKESTR_WHATSAPP_AUTOSTART: "0",
      ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS: "",
      ORKESTR_WHATSAPP_ACCOUNT_IDS: "",
      ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS: "",
      ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS: "",
      ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID: "",
      ORKESTR_WHATSAPP_REPLY_PREFIX: "",
      ORKESTR_WHATSAPP_CHAT_NAME_PREFIX: "",
      ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "0",
      WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "0",
      WHATSAPP_BRIDGE_MODE: "local",
      WHATSAPP_BRIDGE_URL: "",
      WHATSAPP_BRIDGE_TOKEN: "",
      WA_HTTP_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("Could not allocate a smoke-test port"))));
    });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-smoke-"));
const port = process.env.ORKESTR_SMOKE_PORT ? Number(process.env.ORKESTR_SMOKE_PORT) : await findOpenPort();
const baseUrl = `http://127.0.0.1:${port}`;
let server = null;

try {
  server = start(home, port);
  await waitFor(`${baseUrl}/api/health`);
  await request(baseUrl, "/api/ready");
  await request(baseUrl, "/api/connectors/openai/config", {
    method: "POST",
    body: JSON.stringify({ openaiApiKey: "sk-smoke-test" }),
  });
  await request(baseUrl, "/api/agents/templates/coding-agent", { method: "POST" });
  const timer = await request(baseUrl, "/api/timers", {
    method: "POST",
    body: JSON.stringify({
      label: "Smoke timer",
      target: "coding-agent",
      cadence: "daily",
      time: "09:00",
      prompt: "Run smoke task",
    }),
  });
  await request(baseUrl, `/api/timers/${timer.timer.id}/run`, { method: "POST" });
  await request(baseUrl, "/api/agents/coding-agent/run-next", {
    method: "POST",
    body: JSON.stringify({ executorId: "noop" }),
  });
  await stop(server);

  server = start(home, port);
  await waitFor(`${baseUrl}/api/health`);
  const timers = await request(baseUrl, "/api/timers");
  const messages = await request(baseUrl, "/api/agents/coding-agent/messages");
  const events = await request(baseUrl, "/api/events?limit=20");

  if (timers.timers.length !== 1) throw new Error("timer did not persist after restart");
  if (messages.messages.length !== 2) throw new Error("timer and assistant messages did not persist after restart");
  if (messages.messages[0].state !== "completed") throw new Error("noop executor did not complete message");
  if (messages.messages[1].role !== "assistant") throw new Error("assistant output was not persisted");
  if (!events.events.some((event) => event.type === "timer_manual_run")) {
    throw new Error("timer_manual_run event missing after restart");
  }
  console.log("Smoke test passed");
} finally {
  await stop(server);
  await fs.rm(home, { recursive: true, force: true });
}
