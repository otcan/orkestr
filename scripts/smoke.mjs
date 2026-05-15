import fs from "node:fs/promises";
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
      ORKESTR_PORT: String(port),
      ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
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

const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-smoke-"));
const port = Number(process.env.ORKESTR_SMOKE_PORT || 19813);
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
  await request(baseUrl, "/api/agents/templates/job-search-assistant", { method: "POST" });
  const timer = await request(baseUrl, "/api/timers", {
    method: "POST",
    body: JSON.stringify({
      label: "Smoke timer",
      target: "job-search-assistant",
      cadence: "daily",
      time: "09:00",
      prompt: "Run smoke task",
    }),
  });
  await request(baseUrl, `/api/timers/${timer.timer.id}/run`, { method: "POST" });
  await stop(server);

  server = start(home, port);
  await waitFor(`${baseUrl}/api/health`);
  const timers = await request(baseUrl, "/api/timers");
  const messages = await request(baseUrl, "/api/agents/job-search-assistant/messages");
  const events = await request(baseUrl, "/api/events?limit=20");

  if (timers.timers.length !== 1) throw new Error("timer did not persist after restart");
  if (messages.messages.length !== 1) throw new Error("queued timer message did not persist after restart");
  if (!events.events.some((event) => event.type === "timer_manual_run")) {
    throw new Error("timer_manual_run event missing after restart");
  }
  console.log("Smoke test passed");
} finally {
  await stop(server);
  await fs.rm(home, { recursive: true, force: true });
}
