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

function webRows() {
  return messages
    .map((message) => `
      <article class="ork-message ${message.side}">
        <header>
          <strong>${escapeHtml(message.from)}</strong>
          <span>${escapeHtml(message.time)}</span>
        </header>
        <p>${escapeHtml(message.text)}</p>
      </article>
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
  ];
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
        radial-gradient(circle at 14% 18%, rgba(90, 220, 112, 0.14), transparent 27rem),
        radial-gradient(circle at 88% 4%, rgba(88, 156, 255, 0.11), transparent 25rem),
        linear-gradient(135deg, #080c08 0%, #101a12 58%, #1f2a21 100%);
      color: #d7e7ce;
      font-family: "IBM Plex Mono", "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
    }
    .stage { padding: 30px 34px; }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 24px;
      margin-bottom: 18px;
    }
    .headline { margin: 0 0 7px; color: #f0ffea; font-size: 30px; letter-spacing: -0.04em; }
    .subhead { margin: 0; color: #9fb69e; font-size: 14px; }
    .safety {
      border: 1px solid rgba(126, 247, 142, 0.22);
      border-radius: 999px;
      background: rgba(6, 18, 8, 0.72);
      color: #bde8b9;
      padding: 9px 13px;
      font-size: 12px;
      white-space: nowrap;
    }
    .desktop {
      display: grid;
      grid-template-columns: 370px 1fr 410px;
      height: 788px;
      overflow: hidden;
      border: 1px solid rgba(124, 194, 128, 0.24);
      border-radius: 24px;
      background: #071007;
      box-shadow: 0 26px 70px rgba(6, 18, 13, 0.24);
    }
    .surface { min-width: 0; min-height: 0; border-right: 1px solid rgba(140, 255, 155, 0.16); }
    .surface:last-child { border-right: 0; }
    .surface-label {
      position: absolute;
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      top: 13px;
      right: 14px;
    }
    .wa {
      position: relative;
      display: grid;
      grid-template-columns: 116px 1fr;
      background: #111b21;
      color: #e9edef;
    }
    .wa .surface-label { background: #e9edef; color: #111b21; }
    .wa-sidebar {
      border-right: 1px solid #222e35;
      background: #111b21;
      padding: 12px 10px;
    }
    .wa-toolbar, .wa-chat-head {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 46px;
      border-bottom: 1px solid #222e35;
      background: #202c33;
    }
    .wa-toolbar { border-radius: 12px 12px 0 0; justify-content: space-between; padding: 0 8px; }
    .wa-icon, .wa-avatar, .mini-avatar {
      display: inline-grid;
      place-items: center;
      border-radius: 50%;
      font-weight: 900;
    }
    .wa-icon { width: 27px; height: 27px; background: #2a3942; color: #aebac1; font-size: 12px; }
    .wa-search { margin: 12px 0; border-radius: 9px; background: #202c33; color: #87969f; padding: 9px; font-size: 11px; }
    .wa-thread {
      display: grid;
      grid-template-columns: 30px 1fr;
      gap: 8px;
      align-items: center;
      border-radius: 10px;
      padding: 8px 6px;
    }
    .wa-thread.active { background: #2a3942; }
    .mini-avatar { width: 30px; height: 30px; background: #00a884; color: #06231b; font-size: 12px; }
    .wa-thread strong, .wa-thread small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wa-thread strong { font-size: 11px; color: #e9edef; }
    .wa-thread small { font-size: 9px; color: #8696a0; }
    .wa-main { position: relative; display: grid; grid-template-rows: 56px 1fr 58px; min-width: 0; }
    .wa-chat-head { padding: 0 14px; }
    .wa-avatar { width: 37px; height: 37px; background: #00a884; color: #05231a; }
    .wa-chat-title strong { display: block; font-size: 13px; }
    .wa-chat-title span { display: block; color: #8696a0; font-size: 10px; margin-top: 2px; }
    .wa-wall {
      padding: 22px 16px 12px;
      background-color: #0b141a;
      background-image:
        linear-gradient(rgba(11, 20, 26, 0.82), rgba(11, 20, 26, 0.82)),
        radial-gradient(#26333a 1px, transparent 1px);
      background-size: auto, 18px 18px;
    }
    .bubble {
      max-width: 215px;
      border-radius: 8px;
      padding: 8px 9px 6px;
      margin-bottom: 9px;
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.22);
      font-family: Arial, sans-serif;
    }
    .bubble.right { margin-left: auto; background: #005c4b; color: #e9edef; }
    .bubble.left { background: #202c33; color: #e9edef; }
    .bubble-from { color: #6adf97; font-size: 10px; font-weight: 700; margin-bottom: 4px; }
    .bubble-text { font-size: 12px; line-height: 1.32; }
    .bubble-time { text-align: right; color: #aebac1; font-size: 9px; margin-top: 4px; }
    .wa-compose { display: flex; align-items: center; gap: 9px; padding: 10px 12px; background: #202c33; }
    .wa-input { flex: 1; border-radius: 10px; background: #2a3942; color: #8696a0; padding: 11px 13px; font-size: 11px; }
    .wa-send { width: 34px; height: 34px; border-radius: 50%; background: #00a884; color: #04231b; display: grid; place-items: center; font-weight: 900; }
    .ork {
      display: grid;
      grid-template-columns: 230px 1fr;
      position: relative;
      background:
        radial-gradient(circle at top left, rgba(88, 165, 92, 0.18), transparent 25rem),
        linear-gradient(135deg, #050805 0%, #0b130b 58%, #101a12 100%);
    }
    .ork .surface-label { background: rgba(126, 247, 142, 0.18); color: #bfffbd; border: 1px solid rgba(126, 247, 142, 0.22); }
    .ork-sidebar {
      border-right: 1px solid rgba(119, 205, 126, 0.18);
      background: rgba(5, 11, 5, 0.88);
      padding: 18px 14px;
    }
    .eyebrow { color: #8cff9b; font-size: 10px; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase; }
    .ork-brand { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
    .ork-brand h2 { margin: 4px 0 0; font-size: 24px; letter-spacing: -0.05em; color: #f0ffea; }
    .health { border-radius: 999px; background: rgba(94, 212, 113, 0.18); color: #93ff9f; font-size: 10px; font-weight: 900; padding: 6px 8px; }
    .search { border-radius: 10px; border: 1px solid rgba(106, 180, 112, 0.28); background: rgba(3, 8, 3, 0.82); color: #657640; padding: 11px; font-size: 11px; margin-bottom: 12px; }
    .new-thread { border-radius: 10px; background: #63d471; color: #061006; font-weight: 900; font-size: 11px; padding: 10px; text-align: center; margin-bottom: 15px; }
    .thread-item {
      display: grid;
      grid-template-columns: 34px 1fr;
      gap: 10px;
      border-radius: 12px;
      padding: 10px 8px;
      margin-bottom: 8px;
      color: #d8f9cd;
    }
    .thread-item.active { background: rgba(50, 91, 49, 0.42); outline: 1px solid rgba(122, 246, 137, 0.28); }
    .status-dot { width: 9px; height: 9px; border-radius: 50%; background: #ffd166; box-shadow: 0 0 0 4px rgba(255, 209, 102, 0.12); }
    .thread-avatar { width: 34px; height: 34px; border-radius: 50%; background: #10251e; border: 1px solid rgba(113, 218, 126, 0.22); display: grid; place-items: center; color: #8cff9b; font-weight: 900; }
    .thread-copy strong, .thread-copy small { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .thread-copy strong { font-size: 12px; }
    .thread-copy small { color: #91a48b; font-size: 10px; margin-top: 3px; }
    .ork-main { display: grid; grid-template-rows: 92px 49px 1fr 72px; min-width: 0; }
    .ork-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      border-bottom: 1px solid rgba(119, 205, 126, 0.16);
      padding: 18px 22px;
      background: rgba(4, 10, 4, 0.48);
    }
    .ork-head h2 { margin: 3px 0 5px; font-size: 24px; letter-spacing: -0.05em; color: #f5fff0; }
    .status-pill, .branch-pill {
      border-radius: 999px;
      background: rgba(91, 115, 79, 0.36);
      color: #d8f9cd;
      font-size: 10px;
      font-weight: 900;
      padding: 6px 8px;
      text-transform: uppercase;
    }
    .status-pill { background: rgba(255, 209, 102, 0.18); color: #ffe39a; }
    .head-actions { display: flex; gap: 8px; align-items: center; }
    .metric, .mode {
      border: 1px solid rgba(113, 218, 126, 0.28);
      border-radius: 10px;
      background: rgba(10, 24, 11, 0.82);
      color: #c9f6ca;
      padding: 8px 10px;
      font-size: 10px;
      font-weight: 900;
    }
    .mode { color: #061006; background: #63d471; }
    .tabs { display: flex; gap: 8px; align-items: center; padding: 8px 20px; border-bottom: 1px solid rgba(119, 205, 126, 0.14); }
    .tab { border-radius: 9px; background: rgba(10, 24, 11, 0.82); color: #c9f6ca; padding: 8px 11px; font-size: 11px; font-weight: 900; }
    .tab.active { background: rgba(52, 128, 58, 0.46); color: #edffef; outline: 1px solid rgba(126, 247, 142, 0.35); }
    .ork-messages { padding: 18px 22px; overflow: hidden; }
    .ork-message {
      max-width: 86%;
      border: 1px solid rgba(113, 218, 126, 0.18);
      border-radius: 15px;
      background: rgba(8, 18, 8, 0.78);
      padding: 12px 14px;
      margin-bottom: 11px;
    }
    .ork-message.right { margin-left: auto; border-color: rgba(133, 190, 255, 0.2); background: rgba(10, 20, 34, 0.74); }
    .ork-message header { display: flex; justify-content: space-between; color: #8cff9b; font-size: 11px; margin-bottom: 7px; }
    .ork-message p { margin: 0; color: #e6f7dc; font-size: 13px; line-height: 1.45; }
    .composer {
      display: grid;
      grid-template-columns: 1fr 70px;
      gap: 10px;
      padding: 13px 20px;
      border-top: 1px solid rgba(119, 205, 126, 0.16);
      background: rgba(4, 10, 4, 0.6);
    }
    .composer-input { border-radius: 10px; border: 1px solid rgba(106, 180, 112, 0.28); background: rgba(3, 8, 3, 0.82); color: #9eb199; padding: 12px; font-size: 12px; }
    .composer-send { border-radius: 10px; background: #63d471; color: #061006; display: grid; place-items: center; font-weight: 900; font-size: 12px; }
    .terminal {
      position: relative;
      display: grid;
      grid-template-rows: 48px 1fr 92px;
      background: #050806;
      color: #d7f7df;
    }
    .terminal .surface-label { background: rgba(255, 255, 255, 0.08); color: #d7f7df; border: 1px solid rgba(255,255,255,0.12); }
    .terminal-top {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #111812;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding: 0 16px;
    }
    .dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 8px;
    }
    .red { background: #f36f5d; } .yellow { background: #f2c14e; } .green { background: #55c984; }
    .terminal-title { color: #f3fff6; font-size: 13px; font-weight: 800; }
    .terminal-body { padding: 22px; font: 15px/1.6 "SFMono-Regular", Consolas, monospace; white-space: pre-wrap; }
    .prompt { color: #7ee0a3; font-weight: 800; }
    .terminal-note {
      margin: 0 18px 18px;
      border-radius: 14px;
      padding: 14px;
      background: rgba(16, 37, 30, 0.8);
      border: 1px solid rgba(113, 218, 126, 0.2);
      color: #a8c3b1;
      font-size: 12px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <main class="stage">
    <header class="hero">
      <div>
        <h1 class="headline">One chat. One Orkestr thread. One Codex runtime.</h1>
        <p class="subhead">A screenshot-like fake-data demo of the same routed task across all three surfaces.</p>
      </div>
      <div class="safety">Fake data only: no real phone, host, chat ID, repo path, or secret.</div>
    </header>
    <section class="desktop">
      <section class="surface wa">
        <div class="surface-label">WhatsApp</div>
        <aside class="wa-sidebar">
          <div class="wa-toolbar"><span class="wa-icon">D</span><span class="wa-icon">+</span></div>
          <div class="wa-search">Search or start new chat</div>
          <div class="wa-thread active">
            <span class="mini-avatar">D</span>
            <span><strong>${escapeHtml(chatName)}</strong><small>${escapeHtml(task)}</small></span>
          </div>
          <div class="wa-thread">
            <span class="mini-avatar">Q</span>
            <span><strong>QA Launch</strong><small>Ready for review</small></span>
          </div>
          <div class="wa-thread">
            <span class="mini-avatar">R</span>
            <span><strong>Roadmap</strong><small>Timer runs tomorrow</small></span>
          </div>
        </aside>
        <section class="wa-main">
          <header class="wa-chat-head">
            <span class="wa-avatar">D</span>
            <span class="wa-chat-title"><strong>${escapeHtml(chatName)}</strong><span>fake WhatsApp chat</span></span>
          </header>
          <div class="wa-wall">${messageBubbles()}</div>
          <div class="wa-compose"><span class="wa-input">Message ${escapeHtml(chatName)}</span><span class="wa-send">›</span></div>
        </section>
      </section>
      <section class="surface ork">
        <div class="surface-label">Web UI</div>
        <aside class="ork-sidebar">
          <div class="ork-brand"><div><div class="eyebrow">Orkestr</div><h2>Threads</h2></div><span class="health">online</span></div>
          <div class="search">agent, project, thread</div>
          <div class="new-thread">New Coding Agent</div>
          <div class="thread-item active"><span class="thread-avatar">D</span><span class="thread-copy"><strong>${escapeHtml(chatName)}</strong><small>Working · 09:41 · ${escapeHtml(threadName)}</small></span></div>
          <div class="thread-item"><span class="thread-avatar">Q</span><span class="thread-copy"><strong>QA Launch</strong><small>Ready · 09:35</small></span></div>
          <div class="thread-item"><span class="thread-avatar">R</span><span class="thread-copy"><strong>Roadmap</strong><small>Sleeping · Yesterday</small></span></div>
        </aside>
        <section class="ork-main">
          <header class="ork-head">
            <div>
              <div class="eyebrow">Orkestr-bound chat</div>
              <h2>${escapeHtml(chatName)}</h2>
              <span class="status-pill">working -> ready</span>
              <span class="branch-pill">main</span>
            </div>
            <div class="head-actions"><span class="metric">CPU 18%</span><span class="metric">gpt-5.5 xhigh</span><span class="mode">Code</span></div>
          </header>
          <nav class="tabs"><span class="tab active">Chat</span><span class="tab">Raw</span><span class="tab">Timers</span><span class="tab">Settings</span></nav>
          <section class="ork-messages">${webRows()}</section>
          <div class="composer"><span class="composer-input">Send a message to ${escapeHtml(threadName)}</span><span class="composer-send">Send</span></div>
        </section>
      </section>
      <section class="surface terminal">
        <div class="surface-label">Codex</div>
        <div class="terminal-top"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span><span class="terminal-title">Codex Thread</span></div>
        <div class="terminal-body">${terminalTranscript()}</div>
        <div class="terminal-note">Same fake chat, same task, same final result. The terminal is execution detail; Orkestr owns the thread view and mirrors the final answer.</div>
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
