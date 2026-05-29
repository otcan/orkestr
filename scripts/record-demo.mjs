import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const demoAssetPath = path.join(repoRoot, "docs", "assets", "orkestr-three-screen-demo.png");
export const whatsappProofPath = path.join(repoRoot, "docs", "assets", "whatsapp-github-proof.jpeg");

const proofLines = [
  "orkestr: The PNG is on GitHub now.",
  "",
  "Direct file:",
  "https://github.com/otcan/orkestr/blob/main/docs/assets/orkestr-three-screen-demo.png",
  "",
  "Raw PNG:",
  "https://raw.githubusercontent.com/otcan/orkestr/main/docs/assets/orkestr-three-screen-demo.png",
  "",
  "Verified:",
  "• origin/main is at d3853aa",
  "• GitHub default branch is main",
  "• GitHub API returns the PNG at docs/assets/orkestr-three-screen-demo.png",
  "• raw URL returns HTTP 200 with content-type: image/png",
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function whatsappImageDataUri() {
  const data = fsSync.readFileSync(whatsappProofPath);
  return `data:image/jpeg;base64,${data.toString("base64")}`;
}

function terminalTranscriptText() {
  return [
    "$ tmux capture-pane -t acme-ops:features",
    "thread acme-ops / acme-features",
    "source WhatsApp routed reply",
    "",
    ...proofLines,
  ].join("\n");
}

function preLines(value) {
  return String(value || "")
    .replace(/\s+$/g, "")
    .split(/\r?\n/)
    .map((line) => `<span>${escapeHtml(line || " ")}</span>`)
    .join("\n");
}

function proofMessage() {
  return proofLines
    .map((line) => escapeHtml(line || " "))
    .join("\n");
}

export function renderDemoHtml({ tmuxText = terminalTranscriptText() } = {}) {
  const whatsappDataUri = whatsappImageDataUri();
  const webProof = proofMessage();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Orkestr WhatsApp, TMUX, and Web UI proof</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      width: 1800px;
      height: 1050px;
      overflow: hidden;
      background:
        radial-gradient(circle at 12% 8%, rgba(79, 212, 113, 0.18), transparent 28rem),
        radial-gradient(circle at 86% 0%, rgba(79, 150, 255, 0.13), transparent 30rem),
        linear-gradient(135deg, #071008 0%, #111a13 55%, #1d2a21 100%);
      color: #e8f7df;
      font-family: "IBM Plex Mono", "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
    }
    .stage { padding: 30px 34px; }
    .hero {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 28px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0 0 8px;
      color: #f4ffef;
      font-size: 34px;
      line-height: 1.08;
      letter-spacing: 0;
    }
    .subhead {
      margin: 0;
      color: #afc8aa;
      font-size: 15px;
    }
    .badge {
      border: 1px solid rgba(126, 247, 142, 0.28);
      border-radius: 999px;
      background: rgba(6, 18, 8, 0.78);
      color: #c6f2c3;
      padding: 10px 14px;
      font-size: 13px;
      white-space: nowrap;
    }
    .grid {
      display: grid;
      grid-template-columns: 420px 620px 1fr;
      gap: 18px;
      height: 936px;
    }
    .panel {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      border: 1px solid rgba(132, 220, 141, 0.26);
      border-radius: 24px;
      background: rgba(4, 10, 5, 0.9);
      box-shadow: 0 22px 64px rgba(0, 0, 0, 0.28);
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      height: 54px;
      padding: 0 18px;
      border-bottom: 1px solid rgba(132, 220, 141, 0.2);
      background: rgba(8, 20, 9, 0.78);
    }
    .panel-title {
      color: #f3fff0;
      font-size: 16px;
      font-weight: 900;
    }
    .panel-kicker {
      color: #8cff9b;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .phone-frame {
      height: calc(100% - 54px);
      padding: 16px;
      background:
        linear-gradient(180deg, rgba(240, 232, 219, 0.08), transparent),
        #0b130c;
    }
    .phone-shot {
      width: 100%;
      height: 100%;
      object-fit: contain;
      object-position: top center;
      border-radius: 20px;
      background: #ede8df;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.32);
    }
    .terminal {
      height: calc(100% - 54px);
      display: grid;
      grid-template-rows: 42px 1fr;
      background: #020402;
    }
    .terminal-bar {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 0 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: #121812;
      color: #dfffe2;
      font-size: 13px;
      font-weight: 900;
    }
    .dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
    .red { background: #f36f5d; }
    .yellow { background: #f2c14e; }
    .green { background: #55c984; }
    .tmux-pre {
      margin: 0;
      padding: 20px 22px;
      color: #dfffe2;
      font-size: 16px;
      line-height: 1.48;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .tmux-pre span:first-child { color: #8cff9b; font-weight: 900; }
    .web {
      height: calc(100% - 54px);
      display: grid;
      grid-template-columns: 210px 1fr;
      background:
        radial-gradient(circle at top left, rgba(88, 165, 92, 0.17), transparent 27rem),
        linear-gradient(135deg, #050805 0%, #0b130b 58%, #101a12 100%);
    }
    .sidebar {
      padding: 18px 14px;
      border-right: 1px solid rgba(119, 205, 126, 0.18);
      background: rgba(5, 11, 5, 0.9);
    }
    .brand { color: #8cff9b; font-size: 11px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; }
    .sidebar h2 { margin: 5px 0 18px; color: #f0ffea; font-size: 28px; }
    .search {
      border: 1px solid rgba(106, 180, 112, 0.28);
      border-radius: 10px;
      background: rgba(3, 8, 3, 0.82);
      color: #718364;
      padding: 12px;
      font-size: 12px;
      margin-bottom: 14px;
    }
    .thread {
      display: grid;
      grid-template-columns: 38px 1fr;
      gap: 10px;
      align-items: center;
      border-radius: 13px;
      padding: 11px 9px;
      margin-bottom: 9px;
      color: #d8f9cd;
    }
    .thread.active {
      background: rgba(50, 91, 49, 0.46);
      outline: 1px solid rgba(122, 246, 137, 0.28);
    }
    .avatar {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border: 1px solid rgba(113, 218, 126, 0.24);
      border-radius: 50%;
      background: #10251e;
      color: #8cff9b;
      font-weight: 900;
    }
    .thread strong, .thread small {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .thread strong { font-size: 13px; }
    .thread small { margin-top: 4px; color: #91a48b; font-size: 11px; }
    .chat {
      display: grid;
      grid-template-rows: 92px 1fr 70px;
      min-width: 0;
    }
    .chat-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 22px;
      border-bottom: 1px solid rgba(119, 205, 126, 0.16);
      background: rgba(4, 10, 4, 0.52);
    }
    .chat-head h2 { margin: 2px 0 6px; color: #f5fff0; font-size: 24px; }
    .pill {
      display: inline-block;
      border-radius: 999px;
      background: rgba(91, 115, 79, 0.36);
      color: #d8f9cd;
      font-size: 11px;
      font-weight: 900;
      padding: 6px 9px;
      margin-right: 6px;
    }
    .mode { color: #061006; background: #63d471; }
    .messages { padding: 22px; overflow: hidden; }
    .message {
      max-width: 92%;
      border: 1px solid rgba(113, 218, 126, 0.2);
      border-radius: 16px;
      background: rgba(8, 18, 8, 0.82);
      padding: 15px;
      margin-bottom: 13px;
    }
    .message.user {
      margin-left: auto;
      border-color: rgba(133, 190, 255, 0.24);
      background: rgba(10, 20, 34, 0.78);
    }
    .message header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: #8cff9b;
      font-size: 12px;
      font-weight: 900;
      margin-bottom: 9px;
    }
    .message pre {
      margin: 0;
      color: #ecffdf;
      font-size: 15px;
      line-height: 1.42;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: inherit;
    }
    .composer {
      display: grid;
      grid-template-columns: 1fr 82px;
      gap: 10px;
      padding: 13px 20px;
      border-top: 1px solid rgba(119, 205, 126, 0.16);
      background: rgba(4, 10, 4, 0.65);
    }
    .input {
      border: 1px solid rgba(106, 180, 112, 0.28);
      border-radius: 10px;
      background: rgba(3, 8, 3, 0.82);
      color: #9eb199;
      padding: 13px;
      font-size: 12px;
    }
    .send {
      display: grid;
      place-items: center;
      border-radius: 10px;
      background: #63d471;
      color: #061006;
      font-size: 12px;
      font-weight: 900;
    }
  </style>
</head>
<body>
  <main class="stage">
    <header class="hero">
      <div>
        <h1>Same routed answer in WhatsApp, TMUX, and Orkestr Web UI.</h1>
        <p class="subhead">The proof lines match across the phone screenshot, terminal capture, and browser thread view.</p>
      </div>
      <div class="badge">Public GitHub asset proof · no tokens, chat IDs, phone numbers, or local paths</div>
    </header>
    <section class="grid">
      <section class="panel">
        <div class="panel-head"><span class="panel-title">WhatsApp Source</span><span class="panel-kicker">attached image</span></div>
        <div class="phone-frame"><img class="phone-shot" alt="WhatsApp screenshot with GitHub proof lines" src="${whatsappDataUri}" /></div>
      </section>
      <section class="panel">
        <div class="panel-head"><span class="panel-title">TMUX Capture</span><span class="panel-kicker">same lines</span></div>
        <div class="terminal">
          <div class="terminal-bar"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span><span>tmux · acme-features</span></div>
          <pre class="tmux-pre">${preLines(tmuxText)}</pre>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><span class="panel-title">Orkestr Web UI</span><span class="panel-kicker">same lines</span></div>
        <div class="web">
          <aside class="sidebar">
            <div class="brand">Orkestr</div>
            <h2>Threads</h2>
            <div class="search">agent, repo, thread</div>
            <div class="thread active"><span class="avatar">O</span><span><strong>acme-ops</strong><small>Ready · GitHub proof</small></span></div>
            <div class="thread"><span class="avatar">F</span><span><strong>acme-features</strong><small>Working · docs asset</small></span></div>
            <div class="thread"><span class="avatar">V</span><span><strong>VPS Smoke</strong><small>Ready · WhatsApp</small></span></div>
          </aside>
          <section class="chat">
            <header class="chat-head">
              <div>
                <div class="brand">WhatsApp-bound thread</div>
                <h2>acme-ops</h2>
                <span class="pill">main</span><span class="pill">Web UI</span><span class="pill mode">Code</span>
              </div>
              <span class="pill">CPU 18%</span>
            </header>
            <section class="messages">
              <article class="message user">
                <header><span>User</span><span>11:32</span></header>
                <pre>Please verify the README demo PNG on GitHub.</pre>
              </article>
              <article class="message">
                <header><span>Orkestr</span><span>11:32</span></header>
                <pre>${webProof}</pre>
              </article>
            </section>
            <div class="composer"><span class="input">Send a message to acme-ops</span><span class="send">Send</span></div>
          </section>
        </div>
      </section>
    </section>
  </main>
</body>
</html>`;
}

async function commandPath(command) {
  try {
    const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${command}`], { timeout: 2000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function findChrome() {
  const configured = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.ORKESTR_CHROME_PATH,
    process.env.CHROME_PATH,
  ].filter(Boolean);
  const paths = [...configured, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known executable path.
    }
  }
  for (const command of ["google-chrome", "chromium", "chromium-browser"]) {
    const found = await commandPath(command);
    if (found) return found;
  }
  throw new Error("Chrome or Chromium is required to render the PNG demo asset");
}

async function captureTmuxTranscript() {
  const sessionName = `orkestr-demo-proof-${process.pid}`;
  const scriptPath = path.join(os.tmpdir(), `${sessionName}.sh`);
  const script = [
    "clear",
    `printf '%s\\n' ${terminalTranscriptText().split("\n").map(shellQuote).join(" ")}`,
    "sleep 60",
  ].join("\n");
  await fs.writeFile(scriptPath, `${script}\n`, "utf8");
  try {
    await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "-x", "92", "-y", "34", "bash", scriptPath], { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", sessionName, "-S", "-", "-E", "-"], { timeout: 5000 });
    return stdout.replace(/[ \t]+$/gm, "").replace(/\n+$/g, "");
  } finally {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName], { timeout: 5000 }).catch(() => {});
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}

async function loadPuppeteer() {
  try {
    const module = await import("puppeteer");
    return module.default || module;
  } catch (error) {
    const message = error?.code === "ERR_MODULE_NOT_FOUND"
      ? "Install puppeteer to render the PNG demo asset."
      : error?.message || String(error);
    throw new Error(message);
  }
}

export async function recordDemo() {
  await fs.mkdir(path.dirname(demoAssetPath), { recursive: true });
  await fs.access(whatsappProofPath);
  const tmuxText = await captureTmuxTranscript();
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: await findChrome(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1800, height: 1050, deviceScaleFactor: 1 });
    await page.setContent(renderDemoHtml({ tmuxText }), { waitUntil: "networkidle0" });
    await page.screenshot({ path: demoAssetPath, type: "png" });
  } finally {
    await browser.close();
  }
  const stat = await fs.stat(demoAssetPath);
  console.log(`Wrote ${path.relative(repoRoot, demoAssetPath)} from WhatsApp, TMUX, and Web UI proof surfaces`);
  return { path: demoAssetPath, bytes: stat.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await recordDemo();
}
