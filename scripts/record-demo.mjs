import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const demoAssetPath = path.join(repoRoot, "docs", "assets", "orkestr-three-screen-demo.png");

const chatName = "Demo Team Chat";
const threadName = "demo-launch";
const task = "Review the launch checklist and tell me the top blockers.";
const answer = "Top blockers: setup copy, stale README asset, missing smoke-test note.";

const messages = [
  { from: "User", side: "right", time: "09:41", text: task },
  { from: "Orkestr", side: "left", time: "09:41", text: `Thread ${threadName} is awake. Status: working.` },
  { from: "Codex", side: "left", time: "09:42", text: answer },
  { from: "Orkestr", side: "left", time: "09:42", text: "Status: ready. Reply mirrored to this chat." },
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function messageBubbles() {
  return messages
    .map((message) => `
      <div class="bubble ${message.side}">
        <div class="bubble-from">${escapeHtml(message.from)}</div>
        <div class="bubble-text">${escapeHtml(message.text)}</div>
        <div class="bubble-time">${escapeHtml(message.time)}</div>
      </div>
    `)
    .join("");
}

function terminalTranscript() {
  const lines = [
    ["$", `orkestr attach ${threadName}`],
    ["thread", `${chatName} / ${threadName}`],
    ["incoming", task],
    ["status", "working"],
    ["codex", "inspecting launch checklist"],
    ["final", answer],
    ["status", "ready"],
    ["mirror", "sent to fake WhatsApp chat"],
  ]
  return lines
    .map(([label, value]) => `<div><span class="prompt">${escapeHtml(label)}</span> ${escapeHtml(value)}</div>`)
    .join("");
}

export function renderDemoHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Fake Orkestr three-screen demo</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      width: 1500px;
      height: 900px;
      overflow: hidden;
      background:
        radial-gradient(circle at 8% 94%, rgba(171, 214, 145, 0.42), transparent 28%),
        radial-gradient(circle at 92% 8%, rgba(69, 143, 104, 0.28), transparent 24%),
        linear-gradient(135deg, #f3f1e7 0%, #d9e9d6 44%, #101c17 100%);
      color: #12231d;
      font-family: Verdana, Geneva, sans-serif;
    }
    .stage { padding: 48px 54px; }
    .headline {
      font-family: Georgia, serif;
      font-size: 38px;
      font-weight: 700;
      margin: 0 0 8px;
      color: #102f26;
    }
    .subhead {
      font-size: 15px;
      color: #586f63;
      margin-bottom: 32px;
    }
    .screens {
      display: grid;
      grid-template-columns: 370px 520px 430px;
      gap: 28px;
      align-items: stretch;
    }
    .screen {
      border-radius: 30px;
      box-shadow: 0 26px 70px rgba(6, 18, 13, 0.24);
      overflow: hidden;
      min-height: 682px;
      position: relative;
    }
    .label {
      position: absolute;
      top: 18px;
      right: 18px;
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: rgba(255, 255, 255, 0.72);
      color: #204338;
      z-index: 2;
    }
    .phone {
      background: #f7faf3;
      border: 10px solid #10231d;
    }
    .phone-top {
      height: 82px;
      padding: 22px 22px 0;
      background: #f9fbf4;
      border-bottom: 1px solid #e3e8df;
    }
    .avatar {
      display: inline-grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      margin-right: 11px;
      background: #1f7d5a;
      color: white;
      font-size: 20px;
      font-weight: 800;
      vertical-align: middle;
    }
    .chat-title { display: inline-block; vertical-align: middle; }
    .chat-title strong { display: block; font-size: 17px; }
    .chat-title span { color: #667a70; font-size: 11px; }
    .chat-wall {
      min-height: 502px;
      padding: 24px 16px;
      background-color: #eef2e9;
      background-image: radial-gradient(#c8d5c6 1px, transparent 1px);
      background-size: 22px 22px;
    }
    .bubble {
      width: 285px;
      border-radius: 18px;
      padding: 11px 14px 9px;
      margin-bottom: 14px;
      box-shadow: 0 2px 0 rgba(25, 52, 41, 0.07);
    }
    .bubble.right { margin-left: auto; background: #dff8ca; border: 1px solid #badfa9; }
    .bubble.left { background: white; border: 1px solid #dce4dc; }
    .bubble-from { font-size: 12px; font-weight: 800; color: #315a4a; margin-bottom: 5px; }
    .bubble-text { font-size: 13px; line-height: 1.35; }
    .bubble-time { text-align: right; color: #7d8b83; font-size: 10px; margin-top: 4px; }
    .composer {
      position: absolute;
      left: 18px;
      right: 18px;
      bottom: 18px;
      height: 34px;
      border-radius: 17px;
      background: white;
      color: #7d8b83;
      padding: 9px 18px;
      font-size: 12px;
    }
    .web {
      background: linear-gradient(135deg, #172720, #07100d);
      color: #eef8f1;
    }
    .web-top, .terminal-top {
      height: 58px;
      background: #10221b;
      padding: 19px 22px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 8px;
    }
    .red { background: #f36f5d; } .yellow { background: #f2c14e; } .green { background: #55c984; }
    .web-body { padding: 28px; }
    .web-title { font-size: 24px; font-weight: 800; margin-bottom: 6px; }
    .web-subtitle { color: #91a79a; font-size: 13px; margin-bottom: 22px; }
    .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 20px; }
    .card {
      min-height: 86px;
      border-radius: 18px;
      padding: 18px;
      background: #10251e;
      border: 1px solid #29473b;
    }
    .card small { display: block; color: #94a99c; margin-bottom: 10px; }
    .card strong { font-size: 19px; }
    .status-card { background: #332b15; border-color: #66531e; }
    .conversation {
      border-radius: 22px;
      background: #091511;
      border: 1px solid #243c32;
      padding: 20px;
      margin-bottom: 18px;
    }
    .row {
      display: grid;
      grid-template-columns: 76px 1fr 88px;
      gap: 12px;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      font-size: 13px;
    }
    .row:last-child { border-bottom: 0; }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 7px 10px;
      background: #20362d;
      color: #d6e6dc;
      text-align: center;
      font-size: 11px;
      font-weight: 800;
    }
    .badge.ready { background: #48c78e; color: #062116; }
    .progress { height: 20px; border-radius: 10px; background: #20362d; overflow: hidden; }
    .progress span { display: block; width: 91%; height: 100%; background: #48c78e; }
    .terminal {
      background: #08100d;
      color: #d7f7df;
      border: 1px solid rgba(255,255,255,0.12);
    }
    .terminal-title {
      color: #f3fff6;
      font-size: 15px;
      font-weight: 800;
      margin-left: 10px;
    }
    .terminal-body {
      padding: 24px;
      font: 18px/1.62 "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
    }
    .prompt { color: #7ee0a3; font-weight: 800; }
    .terminal-note {
      position: absolute;
      left: 24px;
      right: 24px;
      bottom: 24px;
      border-radius: 18px;
      padding: 18px;
      background: #10251e;
      border: 1px solid #29473b;
      color: #a8c3b1;
      font-size: 13px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <main class="stage">
    <h1 class="headline">One chat, three synchronized surfaces.</h1>
    <div class="subhead">Fake data only. No real phone number, hostname, chat ID, repository, local path, or secret.</div>
    <section class="screens">
      <section class="screen phone">
        <div class="label">WhatsApp</div>
        <div class="phone-top">
          <span class="avatar">O</span>
          <span class="chat-title"><strong>${escapeHtml(chatName)}</strong><span>fake WhatsApp chat</span></span>
        </div>
        <div class="chat-wall">${messageBubbles()}</div>
        <div class="composer">Reply to ${escapeHtml(threadName)}...</div>
      </section>
      <section class="screen web">
        <div class="label">Web UI</div>
        <div class="web-top"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span></div>
        <div class="web-body">
          <div class="web-title">${escapeHtml(chatName)}</div>
          <div class="web-subtitle">Orkestr thread ${escapeHtml(threadName)} mirrors the same conversation.</div>
          <div class="cards">
            <div class="card"><small>Thread</small><strong>${escapeHtml(threadName)}</strong></div>
            <div class="card status-card"><small>Status</small><strong>working -> ready</strong></div>
            <div class="card"><small>Connector</small><strong>fake WhatsApp</strong></div>
            <div class="card"><small>Executor</small><strong>Codex thread</strong></div>
          </div>
          <div class="conversation">
            <div class="row"><span class="badge">09:41</span><span>${escapeHtml(task)}</span><span class="badge">received</span></div>
            <div class="row"><span class="badge">09:41</span><span>Routed into Codex and marked working.</span><span class="badge">working</span></div>
            <div class="row"><span class="badge">09:42</span><span>${escapeHtml(answer)}</span><span class="badge ready">ready</span></div>
          </div>
          <div class="progress"><span></span></div>
        </div>
      </section>
      <section class="screen terminal">
        <div class="label">Codex</div>
        <div class="terminal-top"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span><span class="terminal-title">Codex Thread</span></div>
        <div class="terminal-body">${terminalTranscript()}</div>
        <div class="terminal-note">Same fake chat, same task, same final result. The terminal is execution detail; Orkestr owns the thread view.</div>
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

export async function recordDemo() {
  await fs.mkdir(path.dirname(demoAssetPath), { recursive: true });
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: await findChrome(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
    await page.setContent(renderDemoHtml(), { waitUntil: "networkidle0" });
    await page.screenshot({ path: demoAssetPath, type: "png" });
  } finally {
    await browser.close();
  }
  const stat = await fs.stat(demoAssetPath);
  console.log(`Wrote ${path.relative(repoRoot, demoAssetPath)} from deterministic fake three-screen data`);
  return { path: demoAssetPath, bytes: stat.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await recordDemo();
}
