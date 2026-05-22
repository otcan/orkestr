import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const demoAssetPath = path.join(repoRoot, "docs", "assets", "orkestr-whatsapp-demo.svg");

const demoMessages = [
  {
    side: "right",
    sender: "User",
    time: "09:41",
    text: "Review the launch checklist and tell me the top blockers.",
  },
  {
    side: "left",
    sender: "Orkestr",
    time: "09:41",
    text: "Thread demo-launch is awake. Status: working. Routed to Codex.",
  },
  {
    side: "left",
    sender: "Codex",
    time: "09:42",
    text: "Done. Top blockers: setup copy is vague, the README asset is stale, and the smoke-test note is missing.",
  },
  {
    side: "left",
    sender: "Orkestr",
    time: "09:42",
    text: "Status: ready. Reply mirrored to this chat.",
  },
];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrapText(text, maxChars = 46) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function bubble(message, index) {
  const right = message.side === "right";
  const width = right ? 390 : 430;
  const x = right ? 440 : 54;
  const lines = wrapText(message.text, right ? 40 : 46);
  const height = 62 + lines.length * 22;
  const y = 160 + index * 118;
  const fill = right ? "#dff8ca" : "#ffffff";
  const stroke = right ? "#b5dfa0" : "#d7ded7";
  const labelColor = right ? "#426a33" : "#315a4a";

  const textLines = lines
    .map((line, lineIndex) => (
      `<tspan x="${x + 22}" dy="${lineIndex === 0 ? 0 : 22}">${escapeXml(line)}</tspan>`
    ))
    .join("");

  return `
    <g>
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="22" fill="${fill}" stroke="${stroke}" />
      <text x="${x + 22}" y="${y + 30}" class="sender" fill="${labelColor}">${escapeXml(message.sender)}</text>
      <text x="${x + 22}" y="${y + 58}" class="message">${textLines}</text>
      <text x="${x + width - 52}" y="${y + height - 18}" class="time">${escapeXml(message.time)}</text>
    </g>`;
}

export function renderDemoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="720" viewBox="0 0 920 720" role="img" aria-labelledby="title desc">
  <title id="title">Fake WhatsApp conversation routed through Orkestr</title>
  <desc id="desc">A fake-data Orkestr demo showing a user task, thread acknowledgement, Codex result, and ready status.</desc>
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#f2efe6" />
      <stop offset="100%" stop-color="#d9e6d8" />
    </linearGradient>
    <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse">
      <circle cx="4" cy="4" r="1.2" fill="#bcc9bc" opacity="0.45" />
    </pattern>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#0f241c" flood-opacity="0.18" />
    </filter>
  </defs>
  <style>
    .title { font: 700 26px Georgia, serif; fill: #12352b; }
    .subtle { font: 500 13px Verdana, sans-serif; fill: #5f756a; }
    .sender { font: 700 13px Verdana, sans-serif; }
    .message { font: 500 16px Verdana, sans-serif; fill: #1d2c27; }
    .time { font: 500 11px Verdana, sans-serif; fill: #75827a; }
    .pill { font: 700 12px Verdana, sans-serif; letter-spacing: 0.4px; }
  </style>
  <rect width="920" height="720" fill="#f7f4ed" />
  <g filter="url(#shadow)">
    <rect x="32" y="28" width="856" height="664" rx="34" fill="url(#bg)" />
    <rect x="32" y="104" width="856" height="588" rx="0" fill="url(#dots)" opacity="0.9" />
  </g>
  <rect x="32" y="28" width="856" height="88" rx="34" fill="#f8faf4" />
  <circle cx="82" cy="72" r="26" fill="#1f7d5a" />
  <text x="82" y="79" text-anchor="middle" font-family="Verdana, sans-serif" font-size="20" font-weight="700" fill="#fff">O</text>
  <text x="124" y="67" class="title">Demo Team Chat</text>
  <text x="124" y="91" class="subtle">Fake data only - no real phone, host, chat ID, repo, or secret</text>
  <g transform="translate(616 53)">
    <rect x="0" y="0" width="104" height="34" rx="17" fill="#f1c96b" />
    <text x="52" y="22" text-anchor="middle" class="pill" fill="#4b3510">WORKING</text>
  </g>
  <path d="M736 70h34" stroke="#8ca498" stroke-width="3" stroke-linecap="round" />
  <path d="M764 61l11 9-11 9" fill="none" stroke="#8ca498" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
  <g transform="translate(786 53)">
    <rect x="0" y="0" width="84" height="34" rx="17" fill="#54b582" />
    <text x="42" y="22" text-anchor="middle" class="pill" fill="#ffffff">READY</text>
  </g>
  ${demoMessages.map(bubble).join("")}
  <rect x="54" y="626" width="812" height="42" rx="21" fill="#ffffff" opacity="0.84" />
  <text x="82" y="652" class="subtle">Orkestr-bound chat: user task -> Codex work -> concise result -> ready status</text>
</svg>
`;
}

export async function recordDemo() {
  await fs.mkdir(path.dirname(demoAssetPath), { recursive: true });
  const svg = renderDemoSvg();
  await fs.writeFile(demoAssetPath, svg, "utf8");
  console.log(`Wrote ${path.relative(repoRoot, demoAssetPath)} from deterministic fake WhatsApp data`);
  return { path: demoAssetPath, bytes: Buffer.byteLength(svg) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await recordDemo();
}
