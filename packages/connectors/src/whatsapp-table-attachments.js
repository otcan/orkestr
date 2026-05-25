import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";

const tableSeparatorCellPattern = /^:?-{3,}:?$/;

export function whatsappTableAttachmentsEnabled(env = process.env) {
  const raw = String(env.ORKESTR_WHATSAPP_TABLE_ATTACHMENTS ?? "1").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export function attachmentDeliveryKey(attachment = {}) {
  return [
    String(attachment.path || "").trim(),
    String(attachment.sha256 || "").trim(),
    String(attachment.mimetype || "").trim(),
  ].filter(Boolean).join(":");
}

export async function prepareWhatsAppTableAttachments(text = "", options = {}) {
  const env = options.env || process.env;
  const source = String(text || "");
  if (!source.trim() || !whatsappTableAttachmentsEnabled(env)) {
    return { text: source, attachments: [] };
  }
  const extracted = extractMarkdownTables(source);
  if (!extracted.tables.length) return { text: source, attachments: [] };

  const attachments = [];
  for (const table of extracted.tables) {
    const csv = tableToCsv(table);
    const sha256 = crypto.createHash("sha256").update(csv).digest("hex");
    const filePath = await writeTableCsv(csv, {
      env,
      messageId: options.messageId || "",
      index: table.index,
      sha256,
    });
    attachments.push({
      kind: "table",
      path: filePath,
      filename: path.basename(filePath),
      mimetype: "text/csv",
      sha256,
      rows: table.rows.length,
      columns: table.headers.length,
    });
  }

  return {
    text: replaceMarkdownTablesWithAttachmentNotes(source, extracted.tables, attachments),
    attachments,
  };
}

export function extractMarkdownTables(source = "") {
  const lines = String(source || "").split(/\r?\n/);
  const tables = [];
  let inFence = false;
  let fenceMarker = "";
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marker = fence[1].slice(0, 3);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      index += 1;
      continue;
    }

    if (!inFence && index + 1 < lines.length) {
      const header = parseMarkdownTableRow(lines[index]);
      const separator = parseMarkdownTableRow(lines[index + 1]);
      if (header.length >= 2 && isMarkdownTableSeparator(separator, header.length)) {
        const rows = [];
        let end = index + 2;
        while (end < lines.length) {
          const row = parseMarkdownTableRow(lines[end]);
          if (row.length < 2) break;
          rows.push(normalizeRow(row, header.length));
          end += 1;
        }
        tables.push({
          index: tables.length,
          start: index,
          end,
          headers: normalizeRow(header, header.length),
          rows,
        });
        index = end;
        continue;
      }
    }

    index += 1;
  }

  return { tables };
}

function parseMarkdownTableRow(line = "") {
  const source = String(line || "").trim();
  if (!source.includes("|")) return [];
  const cells = [];
  let current = "";
  let escaped = false;
  for (const char of source) {
    if (char === "\\" && !escaped) {
      escaped = true;
      current += char;
      continue;
    }
    if (char === "|" && !escaped) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
    escaped = false;
  }
  cells.push(current);
  if (cells[0]?.trim() === "") cells.shift();
  if (cells[cells.length - 1]?.trim() === "") cells.pop();
  return cells.map((cell) => cell.trim());
}

function isMarkdownTableSeparator(cells, expectedColumns) {
  return cells.length >= 2 &&
    Math.abs(cells.length - expectedColumns) <= 1 &&
    cells.every((cell) => tableSeparatorCellPattern.test(String(cell || "").replace(/\s+/g, "")));
}

function normalizeRow(row, columnCount) {
  const normalized = row.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push("");
  return normalized;
}

function replaceMarkdownTablesWithAttachmentNotes(source, tables, attachments) {
  const lines = String(source || "").split(/\r?\n/);
  const output = [];
  let tableIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const table = tables[tableIndex];
    if (table && index === table.start) {
      const attachment = attachments[tableIndex];
      output.push(`${tables.length > 1 ? `Table ${tableIndex + 1}` : "Table"} attached: ${attachment.filename}`);
      index = table.end - 1;
      tableIndex += 1;
      continue;
    }
    output.push(lines[index]);
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function tableToCsv(table) {
  return [table.headers, ...table.rows]
    .map((row) => row.map((cell) => csvEscape(cleanCell(cell))).join(","))
    .join("\n") + "\n";
}

function cleanCell(cell) {
  return String(cell || "")
    .replace(/\\\|/g, "|")
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
}

function csvEscape(value) {
  const text = String(value || "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeTableCsv(csv, { env, messageId, index, sha256 }) {
  const outDir = path.join(dataPaths(env).home, "whatsapp-bridge", "outbound-media", "tables");
  await fs.mkdir(outDir, { recursive: true });
  const safeMessage = safeFilenamePart(messageId || sha256.slice(0, 12));
  const filePath = path.join(outDir, `orkestr-table-${safeMessage}-${index + 1}-${sha256.slice(0, 10)}.csv`);
  await fs.writeFile(filePath, csv, "utf8");
  return filePath;
}

function safeFilenamePart(value) {
  return String(value || "message")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "message";
}
