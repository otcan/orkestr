import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oxrmRoot = process.env.OXRM_REPO_ROOT || "/opt/orkestr/workspace/orkestr-crm";
const width = Number(process.env.ORKESTR_DEMO_RECORD_WIDTH || 1600);
const height = Number(process.env.ORKESTR_DEMO_RECORD_HEIGHT || 900);
const fps = Number(process.env.ORKESTR_DEMO_RECORD_FPS || 30);
const duration = Number(process.env.ORKESTR_DEMO_RECORD_SECONDS || 82);
const orkestrPort = Number(process.env.ORKESTR_DEMO_RECORD_PORT || 19816);
const outputPath = path.resolve(
  process.env.ORKESTR_DEMO_RECORD_OUTPUT ||
    path.join(repoRoot, "docs", "assets", "orkestr-oxrm-live-demo.mp4"),
);
const posterPath = outputPath.replace(/\.mp4$/i, ".poster.png");

const disabledConnectorEnv = {
  ORKESTR_AUTH_REQUIRED: "0",
  ORKESTR_BROWSER_LAUNCH_DISABLED: "1",
  ORKESTR_RECOVER_RUNNING_ON_START: "0",
  ORKESTR_STARTUP_RECOVERY: "0",
  ORKESTR_WHATSAPP_AUTOSTART: "0",
  ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS: "",
  ORKESTR_WHATSAPP_ACCOUNT_IDS: "",
  ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS: "",
  ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS: "",
  ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID: "",
  ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "0",
  WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "0",
  WHATSAPP_BRIDGE_MODE: "local",
  WHATSAPP_BRIDGE_URL: "",
  WHATSAPP_BRIDGE_TOKEN: "",
  WA_HTTP_TOKEN: "",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripAnsi(value = "") {
  return String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function commandPath(command) {
  const { stdout } = await execFileAsync("bash", ["-lc", `command -v ${command}`]);
  return stdout.trim();
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    timeout: options.timeout || 120_000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function waitFor(url, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Retry while services start.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    detached: false,
  });
  if (options.prefix) {
    child.stdout?.on("data", (chunk) => process.stdout.write(`[${options.prefix}] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[${options.prefix}] ${chunk}`));
  }
  return child;
}

async function stopProcess(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill(signal);
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function findDisplay() {
  for (let display = 91; display < 130; display += 1) {
    try {
      await fs.access(`/tmp/.X${display}-lock`);
    } catch {
      return `:${display}`;
    }
  }
  throw new Error("No free X display found in :91-:129");
}

async function writeHtml(filePath, html) {
  await fs.writeFile(filePath, html, "utf8");
  return `file://${filePath}`;
}

function renderIntroHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Orkestr + oXRM Demo</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: #0b0d10;
      color: #f6f7f8;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      height: 100vh;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 28px;
      align-items: center;
      padding: 64px;
    }
    h1 {
      margin: 0 0 22px;
      font-size: 72px;
      line-height: 0.94;
      letter-spacing: 0;
      max-width: 780px;
    }
    .sub {
      color: #c5cbd3;
      font-size: 24px;
      line-height: 1.35;
      max-width: 720px;
    }
    .grid {
      display: grid;
      gap: 18px;
    }
    .panel {
      border: 1px solid #303842;
      background: #141820;
      border-radius: 8px;
      padding: 26px;
      min-height: 185px;
    }
    .label {
      color: #84d5ff;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h2 { margin: 12px 0 10px; font-size: 34px; letter-spacing: 0; }
    p { margin: 0; color: #d6dbe2; font-size: 18px; line-height: 1.4; }
    .footer {
      position: fixed;
      left: 64px;
      right: 64px;
      bottom: 34px;
      display: flex;
      justify-content: space-between;
      color: #96a0ac;
      font-size: 15px;
    }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Local-first agents with structured workflow memory.</h1>
      <p class="sub">Orkestr is the workstation for persistent coding and operations agents. oXRM is the first MCP-first relationship workspace built for those agents.</p>
    </section>
    <section class="grid">
      <div class="panel">
        <div class="label">Orkestr</div>
        <h2>Agent workstation</h2>
        <p>Setup, threads, status, virtual desktops, timers, and supervised local agent execution.</p>
      </div>
      <div class="panel">
        <div class="label">oXRM</div>
        <h2>Relationship workspace</h2>
        <p>Synthetic demo data, follow-up queues, saved views, API endpoints, and MCP tools/resources.</p>
      </div>
    </section>
  </main>
  <div class="footer">
    <span>Public-safe demo. No real accounts, tokens, chats, or private overlays.</span>
    <span>Recorded from a disposable desktop session.</span>
  </div>
</body>
</html>`;
}

function renderTerminalHtml(transcript) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Demo Commands</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #090b0f;
      color: #d9f7df;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      height: 100vh;
      overflow: hidden;
    }
    .bar {
      height: 44px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 18px;
      background: #171b22;
      border-bottom: 1px solid #2d3440;
      color: #c9d1d9;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }
    .dot { width: 12px; height: 12px; border-radius: 50%; background: #ff5f57; }
    .dot:nth-child(2) { background: #ffbd2e; }
    .dot:nth-child(3) { background: #28c840; }
    .title { margin-left: 8px; font-weight: 700; }
    pre {
      margin: 0;
      padding: 28px 34px;
      height: calc(100vh - 44px);
      overflow: hidden;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 20px;
      line-height: 1.35;
    }
    .accent { color: #8ee88e; }
  </style>
</head>
<body>
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="title">public-demo@disposable-desktop</span></div>
  <pre>${escapeHtml(transcript)}</pre>
</body>
</html>`;
}

async function prepareOrkestrDemoServer(home) {
  const baseUrl = `http://127.0.0.1:${orkestrPort}`;
  const env = {
    ...process.env,
    ...disabledConnectorEnv,
    ORKESTR_HOME: home,
    ORKESTR_PORT: String(orkestrPort),
    ORKESTR_HOST: "127.0.0.1",
    ORKESTR_OVERLAY_DIR: path.join(home, "empty-overlay"),
  };
  await fs.mkdir(env.ORKESTR_OVERLAY_DIR, { recursive: true });
  const server = spawnManaged(process.execPath, ["apps/server/src/server.js"], {
    env,
    prefix: "orkestr-demo",
  });
  let serverExit = null;
  server.once("exit", (code, signal) => {
    serverExit = { code, signal };
  });
  await waitFor(`${baseUrl}/api/health`);
  if (serverExit) throw new Error(`Disposable Orkestr server exited during startup: ${JSON.stringify(serverExit)}`);
  await request(baseUrl, "/api/connectors/openai/config", {
    method: "POST",
    body: JSON.stringify({ openaiApiKey: "public-demo-placeholder" }),
  });
  await request(baseUrl, "/api/threads", {
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
  }).catch(() => {});
  await request(baseUrl, "/api/threads/demo-coding-agent/input", {
    method: "POST",
    body: JSON.stringify({
      text: "Inspect this repository and list the top three public-launch blockers. Do not edit files.",
      autoRun: false,
    }),
  }).catch(() => {});
  return { server, baseUrl };
}

async function buildTranscript() {
  const codingDemo = stripAnsi(await run("npm", ["run", "demo:coding-agent"], { cwd: repoRoot }));
  const queue = stripAnsi(await run("./oxrm", ["cli", "mcp:read", "crm://queue/today"], { cwd: oxrmRoot }));
  const search = stripAnsi(await run("./oxrm", ["cli", "mcp:call", "crm.search_leads", "--input", "{\"query\":\"Alex\"}"], { cwd: oxrmRoot }));
  return [
    "$ npm run demo:coding-agent",
    codingDemo.trim(),
    "",
    "$ ./oxrm cli mcp:read crm://queue/today",
    queue.trim().slice(0, 2200),
    "",
    "$ ./oxrm cli mcp:call crm.search_leads --input '{\"query\":\"Alex\"}'",
    search.trim().slice(0, 1800),
  ].join("\n");
}

async function capturePoster() {
  await run("ffmpeg", [
    "-y",
    "-ss",
    "00:00:04",
    "-i",
    outputPath,
    "-frames:v",
    "1",
    posterPath,
  ], { cwd: repoRoot, timeout: 60_000 });
}

async function main() {
  await commandPath("Xvfb");
  await commandPath("openbox");
  const chrome = await commandPath("google-chrome");
  await commandPath("xdotool");
  await commandPath("ffmpeg");

  await waitFor("http://127.0.0.1:18290/");
  await waitFor("http://127.0.0.1:18291/api/health");

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-oxrm-record-"));
  const orkestrHome = path.join(workDir, "orkestr-home");
  await fs.mkdir(orkestrHome, { recursive: true });
  const transcript = await buildTranscript();
  const introUrl = await writeHtml(path.join(workDir, "intro.html"), renderIntroHtml());
  const terminalUrl = await writeHtml(path.join(workDir, "terminal.html"), renderTerminalHtml(transcript));
  const { server, baseUrl } = await prepareOrkestrDemoServer(orkestrHome);
  const display = await findDisplay();
  const env = { ...process.env, DISPLAY: display };
  let xvfb;
  let openbox;
  let chromeProcess;
  let ffmpeg;

  try {
    xvfb = spawnManaged("Xvfb", [display, "-screen", "0", `${width}x${height}x24`, "-ac"], {
      env,
      prefix: "xvfb",
    });
    await sleep(1000);
    openbox = spawnManaged("openbox", [], { env, prefix: "openbox" });
    await sleep(1000);

    const chromeProfile = path.join(workDir, "chrome-profile");
    await fs.mkdir(chromeProfile, { recursive: true });
    await fs.writeFile(path.join(chromeProfile, "First Run"), "", "utf8");
    chromeProcess = spawnManaged(chrome, [
      "--no-sandbox",
      "--test-type",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--disable-default-apps",
      "--disable-extensions",
      "--password-store=basic",
      "--use-mock-keychain",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--user-data-dir=${chromeProfile}`,
      `--window-size=${width},${height}`,
      "--start-maximized",
      "--new-window",
      introUrl,
      `${baseUrl}/setup`,
      `${baseUrl}/thread/demo-coding-agent`,
      "http://127.0.0.1:18290",
      terminalUrl,
    ], { env, prefix: "chrome" });
    await sleep(5000);
    await run("xdotool", ["key", "Return"], { env, timeout: 10_000 }).catch(() => {});
    await sleep(1000);
    await run("xdotool", ["search", "--onlyvisible", "--class", "google-chrome", "windowactivate", "%1", "key", "F11"], {
      env,
      timeout: 10_000,
    }).catch(() => {});
    await sleep(1000);

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    ffmpeg = spawnManaged("ffmpeg", [
      "-y",
      "-video_size",
      `${width}x${height}`,
      "-framerate",
      String(fps),
      "-f",
      "x11grab",
      "-i",
      `${display}.0`,
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ], { env, prefix: "ffmpeg" });

    const tabSteps = [
      [9000, "Ctrl+Tab"],
      [14000, "Ctrl+Tab"],
      [14000, "Ctrl+Tab"],
      [17000, "Ctrl+Tab"],
      [12000, "Page_Down"],
      [9000, "Home"],
    ];
    for (const [delay, key] of tabSteps) {
      await sleep(delay);
      await run("xdotool", ["key", key], { env, timeout: 10_000 }).catch(() => {});
    }

    await new Promise((resolve, reject) => {
      ffmpeg.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    await capturePoster();
    await fs.chmod(outputPath, 0o644).catch(() => {});
    await fs.chmod(posterPath, 0o644).catch(() => {});
    const stat = await fs.stat(outputPath);
    console.log(JSON.stringify({
      ok: true,
      outputPath,
      posterPath,
      bytes: stat.size,
      seconds: duration,
      orkestrUrl: baseUrl,
      oxrmUrl: "http://127.0.0.1:18290",
    }, null, 2));
  } finally {
    await stopProcess(ffmpeg, "SIGINT").catch(() => {});
    await stopProcess(chromeProcess).catch(() => {});
    await stopProcess(openbox).catch(() => {});
    await stopProcess(xvfb).catch(() => {});
    await stopProcess(server).catch(() => {});
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
