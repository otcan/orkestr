import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";

const execFileAsync = promisify(execFile);

export async function setGeneratedLocalWhatsAppGroupPicture({
  client,
  MessageMedia,
  chatId = "",
  title = "",
  accountId = "",
  env = process.env,
} = {}) {
  const normalizedChatId = String(chatId || "").trim();
  if (!client || !MessageMedia) throw new Error("whatsapp_picture_client_required");
  if (!/@g\.us$/i.test(normalizedChatId)) throw new Error("chat picture can only be set for groups");
  const picturePath = await generateChatPictureFile(normalizedChatId, title || normalizedChatId, env);
  const updated = await setLocalWhatsAppGroupPictureFromFile({
    client,
    MessageMedia,
    chatId: normalizedChatId,
    picturePath,
    accountId,
    env,
  });
  await appendEvent({
    type: "whatsapp_chat_picture_generated",
    chatId: normalizedChatId,
    accountId,
    title,
    picturePath,
    updated,
  }, env);
  return { updated, picturePath };
}

async function setLocalWhatsAppGroupPictureFromFile({
  client,
  MessageMedia,
  chatId = "",
  picturePath = "",
  accountId = "",
  env = process.env,
} = {}) {
  await fs.access(picturePath);
  const chat = await client.getChatById(chatId);
  if (!chat?.isGroup || typeof chat.setPicture !== "function") {
    throw new Error("chat picture can only be set for groups");
  }
  const media = MessageMedia.fromFilePath(picturePath);
  const updated = await chat.setPicture(media);
  await appendEvent({
    type: "whatsapp_chat_picture_set",
    chatId,
    accountId,
    picturePath,
    updated,
  }, env);
  return Boolean(updated);
}

async function generateChatPictureFile(chatId, title, env = process.env) {
  const outDir = path.join(dataPaths(env).home, "whatsapp-bridge", "outbound-media", "chat-icons");
  await fs.mkdir(outDir, { recursive: true });
  const filename = `${safeFilenamePart(title || chatId)}-${crypto
    .createHash("sha1")
    .update(`${chatId}:${title || ""}`)
    .digest("hex")
    .slice(0, 10)}`;
  const svgPath = path.join(outDir, `${filename}.svg`);
  const jpgPath = path.join(outDir, `${filename}.jpg`);
  await fs.writeFile(svgPath, chatIconSvg(title || chatId), "utf8");
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", svgPath, "-frames:v", "1", "-q:v", "3", jpgPath]);
  return jpgPath;
}

function safeFilenamePart(value) {
  return String(value || "chat")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "chat";
}

function chatIconSvg(title) {
  const lines = chatIconLines(title);
  const fontSize = chatIconFontSize(lines);
  const gap = Math.max(22, Math.round(fontSize * 0.16));
  const lineHeight = Math.round(fontSize * 0.82);
  const totalHeight = lines.length * lineHeight + (lines.length - 1) * gap;
  const firstBaseline = Math.round((640 - totalHeight) / 2 + lineHeight - 4);
  const text = lines.map((line, index) => {
    const y = firstBaseline + index * (lineHeight + gap);
    const value = escapeSvgText(line);
    return `
      <text x="320" y="${y}" class="outer">${value}</text>
      <text x="320" y="${y}" class="inner">${value}</text>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <rect width="640" height="640" fill="#061006"/>
  <circle cx="320" cy="320" r="282" fill="#0a1d10" stroke="#25d366" stroke-width="12"/>
  <circle cx="320" cy="320" r="238" fill="none" stroke="#123b20" stroke-width="8"/>
  <style>
    text {
      font-family: "Nimbus Sans Narrow", "Arial Narrow", Arial, sans-serif;
      font-weight: 900;
      font-size: ${fontSize}px;
      text-anchor: middle;
      dominant-baseline: alphabetic;
    }
    .outer {
      fill: #25d366;
      stroke: #25d366;
      stroke-width: 14px;
      stroke-linejoin: round;
    }
    .inner {
      fill: #f6fff8;
      stroke: #000000;
      stroke-width: 6px;
      stroke-linejoin: round;
      paint-order: stroke fill;
    }
  </style>
  ${text}
</svg>
`;
}

function chatIconLines(title) {
  const words = splitChatIconWords(title);
  if (words.length === 1 && /^main$/i.test(words[0])) return ["ORKESTR", "MAIN"];
  if (words.length === 1) return ["ORKESTR", words[0].toUpperCase().slice(0, 12)];
  return ["ORKESTR", words[0].toUpperCase().slice(0, 11), words.slice(1).join(" ").toUpperCase().slice(0, 11)];
}

function splitChatIconWords(title) {
  const cleaned = String(title || "")
    .replace(/^otcanclaw[-_\s]*/i, "")
    .replace(/personalized/gi, "personal")
    .replace(/metabolimics/gi, "metabolomics")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim();
  return cleaned ? cleaned.split(/\s+/).filter(Boolean) : ["main"];
}

function chatIconFontSize(lines) {
  const maxLength = Math.max(1, ...lines.map((line) => line.length));
  const widthLimited = Math.floor(580 / (maxLength * 0.5));
  const heightLimited = lines.length >= 3 ? 150 : 190;
  return Math.max(78, Math.min(heightLimited, widthLimited));
}

function escapeSvgText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
