import { createHash } from "node:crypto";
import PostalMime from "postal-mime";

function clean(value = "") {
  return String(value || "").trim();
}

function sha256Buffer(buffer = Buffer.alloc(0)) {
  return createHash("sha256").update(buffer).digest("hex");
}

function rawBuffer(value = "") {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value || ""), "utf8");
}

function contentBuffer(attachment = {}) {
  const content = attachment.content;
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  if (ArrayBuffer.isView(content)) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  if (typeof content === "string" && attachment.encoding === "base64") return Buffer.from(content, "base64");
  if (typeof content === "string") return Buffer.from(content, "utf8");
  return Buffer.alloc(0);
}

function addressToString(address = null) {
  if (!address) return "";
  if (Array.isArray(address)) return address.map(addressToString).filter(Boolean).join(", ");
  if (Array.isArray(address.group)) return address.group.map(addressToString).filter(Boolean).join(", ");
  const email = clean(address.address);
  const name = clean(address.name);
  if (name && email) return `${name} <${email}>`;
  return email || name;
}

export async function parseRawMime(rawMime = "") {
  const source = rawBuffer(rawMime);
  const parsed = await PostalMime.parse(source, {
    attachmentEncoding: "arraybuffer",
    maxNestingDepth: 64,
  });
  return {
    headers: {
      messageId: clean(parsed.messageId),
      subject: clean(parsed.subject),
      from: addressToString(parsed.from),
      date: clean(parsed.date),
    },
    body: {
      text: clean(parsed.text),
      html: clean(parsed.html),
    },
    attachments: (Array.isArray(parsed.attachments) ? parsed.attachments : []).slice(0, 100).map((attachment) => {
      const buffer = contentBuffer(attachment);
      return {
        filename: clean(attachment.filename).slice(0, 240),
        contentType: clean(attachment.mimeType || "application/octet-stream").slice(0, 120),
        sizeBytes: buffer.length,
        contentHash: sha256Buffer(buffer),
        quarantined: true,
      };
    }),
    sizeBytes: source.length,
    parseError: "",
  };
}
