import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer } from "../apps/server/src/server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitFor(url, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry while the local server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function restoreEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function commandOk(command, args = ["--version"], options = {}) {
  try {
    await execFileAsync(command, args, { timeout: 5000, ...options });
    return true;
  } catch {
    return false;
  }
}

export async function runCodingAgentDemo({ port = Number(process.env.ORKESTR_CODING_DEMO_PORT || 19815), log = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-coding-demo-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const priorEnv = {
    ORKESTR_HOME: process.env.ORKESTR_HOME,
    ORKESTR_PORT: process.env.ORKESTR_PORT,
    ORKESTR_HOST: process.env.ORKESTR_HOST,
    ORKESTR_BROWSER_LAUNCH_DISABLED: process.env.ORKESTR_BROWSER_LAUNCH_DISABLED,
    ORKESTR_BROWSER_DESKTOP_MODE: process.env.ORKESTR_BROWSER_DESKTOP_MODE,
    ORKESTR_RECOVER_RUNNING_ON_START: process.env.ORKESTR_RECOVER_RUNNING_ON_START,
  };
  let server = null;

  try {
    process.env.ORKESTR_HOME = home;
    process.env.ORKESTR_PORT = String(port);
    process.env.ORKESTR_HOST = "127.0.0.1";
    process.env.ORKESTR_BROWSER_LAUNCH_DISABLED = "1";
    process.env.ORKESTR_BROWSER_DESKTOP_MODE = "profiles";
    process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

    server = await startServer({ port, host: "127.0.0.1" });
    await waitFor(`${baseUrl}/api/health`);

    const thread = await request(baseUrl, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        id: "demo-coding-agent",
        name: "Demo Coding Agent",
        title: "Demo Coding Agent",
        cwd: repoRoot,
        workspace: repoRoot,
        executorId: "codex",
        wakePolicy: "wake-on-message",
      }),
    });
    const desktop = await request(baseUrl, "/api/browser-sessions/desktop/prepare", { method: "POST" });
    const input = await request(baseUrl, "/api/threads/demo-coding-agent/input", {
      method: "POST",
      body: JSON.stringify({
        text: "Inspect this repository and list the top three public-launch blockers. Do not edit files.",
        autoRun: false,
      }),
    });
    const messages = await request(baseUrl, "/api/threads/demo-coding-agent/messages");

    const result = {
      baseUrl,
      thread: thread.thread,
      desktop: desktop.browser,
      queued: input.queued === true,
      messages: messages.messages,
      home,
    };

    if (result.thread.id !== "demo-coding-agent") throw new Error("coding demo thread was not created");
    if (result.desktop.slug !== "desktop") throw new Error("desktop browser profile was not prepared");
    if (!result.queued) throw new Error("coding demo input was not queued");
    if (result.messages.length !== 1) throw new Error(`expected one queued message, got ${result.messages.length}`);

    if (log) {
      console.log("Coding-agent demo passed");
      console.log(`Server: ${baseUrl}`);
      console.log(`Thread: ${result.thread.id} (${result.thread.name})`);
      console.log(`Virtual desktop profile: ${result.desktop.profileDir}`);
      console.log(`Queued task: ${result.messages[0].text}`);
      console.log("Next real-agent step: open /setup, complete Codex sign-in, then wake demo-coding-agent.");
    }
    return result;
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    restoreEnv(priorEnv);
    await fs.rm(home, { recursive: true, force: true });
  }
}

export async function runRealCodexDemo({ port = Number(process.env.ORKESTR_REAL_CODEX_DEMO_PORT || 19817), repo = process.cwd(), log = true } = {}) {
  const workspace = path.resolve(repo);
  if (!(await commandOk("codex"))) throw new Error("codex command not found. Use the Docker image or install Codex in the Orkestr runtime before running --real-codex.");
  if (!(await commandOk("tmux", ["-V"]))) throw new Error("tmux command not found. Install tmux before running --real-codex.");
  if (!(await commandOk("git", ["-C", workspace, "rev-parse", "--show-toplevel"]))) {
    throw new Error(`--repo must point to a git repository: ${workspace}`);
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-real-codex-demo-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const priorEnv = {
    ORKESTR_HOME: process.env.ORKESTR_HOME,
    ORKESTR_PORT: process.env.ORKESTR_PORT,
    ORKESTR_HOST: process.env.ORKESTR_HOST,
    ORKESTR_RECOVER_RUNNING_ON_START: process.env.ORKESTR_RECOVER_RUNNING_ON_START,
  };
  let server = null;

  try {
    process.env.ORKESTR_HOME = home;
    process.env.ORKESTR_PORT = String(port);
    process.env.ORKESTR_HOST = "127.0.0.1";
    process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

    server = await startServer({ port, host: "127.0.0.1" });
    await waitFor(`${baseUrl}/api/health`);

    await request(baseUrl, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        id: "real-codex-demo",
        name: "Real Codex Demo",
        title: "Real Codex Demo",
        cwd: workspace,
        workspace,
        executorId: "codex",
        wakePolicy: "wake-on-message",
      }),
    });
    await request(baseUrl, "/api/browser-sessions/desktop/prepare", { method: "POST" });
    const wake = await request(baseUrl, "/api/threads/real-codex-demo/wake", { method: "POST" });
    const input = await request(baseUrl, "/api/threads/real-codex-demo/input", {
      method: "POST",
      body: JSON.stringify({
        text: "Inspect this repository and list the top three public-launch blockers. Do not edit files.",
        autoRun: false,
      }),
    });
    const logDir = path.join(home, "demo-logs");
    await fs.mkdir(logDir, { recursive: true });
    const sanitized = [
      "Real Codex demo prepared.",
      `Thread: real-codex-demo`,
      `Workspace: <repo>`,
      `Session: ${wake.status?.sessionName || wake.lease?.sessionName || "orkestr-real-codex-demo"}`,
      `Queued: ${input.queued === true}`,
      "Attach: npx orkestr-oss attach real-codex-demo",
    ].join("\n");
    await fs.writeFile(path.join(logDir, "real-codex-demo.txt"), `${sanitized}\n`, "utf8");
    if (log) console.log(sanitized);
    return { home, baseUrl, queued: input.queued === true, wake };
  } finally {
    restoreEnv(priorEnv);
    if (server) {
      console.log(`Real Codex demo server is still needed only while inspecting ${baseUrl}; shutting down scripted run.`);
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--real-codex")) {
    const repoFlag = args.indexOf("--repo");
    const repo = repoFlag >= 0 ? args[repoFlag + 1] : process.cwd();
    await runRealCodexDemo({ repo });
  } else {
    await runCodingAgentDemo();
  }
}
