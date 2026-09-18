import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import * as age from "age-encryption";
import { activeAttachmentEncryptionRecipients } from "./attachment-encryption-registry.js";
import { classifyThreadAttachmentPath } from "./thread-attachments.js";
import { resourceOwnerUserId } from "./policy.js";
import { incrementCounter } from "./observability.js";

let active = 0;
const maximum = 25 * 1024 * 1024;
function fail(code, statusCode = 409) { return Object.assign(new Error(code), { statusCode }); }

// Only called with a server-resolved attachment, never a request path. Preview
// uses the same age payload as downloads, even for ordinary stored plaintext.
export async function encryptedAttachmentPreview({ thread, attachment, env = process.env }) {
  if (active >= 2) { incrementCounter("orkestr_attachment_preview_total", { outcome: "busy" }); throw fail("attachment_preview_busy", 429); }
  active++;
  let released = false;
  const release = () => { if (!released) { released = true; active--; } };
  let handle;
  try {
    const recipients = await activeAttachmentEncryptionRecipients(resourceOwnerUserId(thread, env), env);
    if (!recipients.length) throw fail("attachment_preview_browser_key_required");
    const source = String(attachment.path || attachment.saved_path || "");
    if (!classifyThreadAttachmentPath(source, { thread, env }).ok || await fs.realpath(source) !== source) throw fail("attachment_preview_forbidden", 403);
    handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw fail("attachment_preview_too_large", 413);
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size) throw fail("attachment_preview_source_changed");
    await handle.close(); handle = null;
    const content = bytes.subarray(0, size);
    const metadata = Buffer.from(JSON.stringify({ version: 1, filename: attachment.filename || attachment.name || "attachment",
      mimetype: attachment.mimetype || "application/octet-stream", plaintextSize: size,
      plaintextChecksum: createHash("sha256").update(content).digest("hex") }));
    const encrypter = new age.Encrypter();
    for (const recipient of recipients) encrypter.addRecipient(recipient.recipient);
    const encrypted = await encrypter.encrypt(Readable.toWeb(Readable.from([
      Buffer.from(`ORKESTR-ATTACHMENT-PAYLOAD/1\n${metadata.length}\n`), metadata, content,
    ])));
    const stream = Readable.fromWeb(encrypted);
    stream.once("close", release);
    stream.once("error", release);
    stream.once("end", () => { incrementCounter("orkestr_attachment_preview_total", { outcome: "completed" }); release(); });
    const timer = setTimeout(() => stream.destroy(fail("attachment_preview_timeout", 408)), 30_000);
    timer.unref?.(); stream.once("close", () => clearTimeout(timer));
    return stream;
  } catch (error) {
    incrementCounter("orkestr_attachment_preview_total", { outcome: "rejected" });
    await handle?.close().catch(() => {}); release(); throw error;
  }
}
