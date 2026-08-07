import { ingestMailboxMessage } from "./mailbox-inbox.js";
import { listMailboxes } from "../../core/src/mailboxes.js";
import { acceptingMailboxStatuses, extractAddress } from "../../core/src/mailbox-normalization.js";

const socketMapName = "mailboxes";

export function encodeSocketMapFrame(value = "") {
  const payload = Buffer.from(String(value || ""), "utf8");
  return Buffer.concat([Buffer.from(`${payload.length}:`, "ascii"), payload, Buffer.from(",", "ascii")]);
}

export function decodeSocketMapFrames(input = Buffer.alloc(0)) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const frames = [];
  let offset = 0;
  while (offset < source.length) {
    const colon = source.indexOf(0x3a, offset);
    if (colon < 0) break;
    const lengthText = source.subarray(offset, colon).toString("ascii");
    if (!/^\d{1,10}$/.test(lengthText)) throw new Error("mailbox_socketmap_frame_invalid");
    const length = Number(lengthText);
    if (length > 16_384) throw new Error("mailbox_socketmap_frame_too_large");
    const start = colon + 1;
    const end = start + length;
    if (end >= source.length) break;
    if (source[end] !== 0x2c) throw new Error("mailbox_socketmap_frame_invalid");
    frames.push(source.subarray(start, end).toString("utf8"));
    offset = end + 1;
  }
  return { frames, remainder: source.subarray(offset) };
}

export async function postfixSocketMapLookup(request = "", env = process.env) {
  const separator = String(request || "").indexOf(" ");
  const map = separator < 0 ? "" : String(request).slice(0, separator).trim().toLowerCase();
  const address = extractAddress(separator < 0 ? "" : String(request).slice(separator + 1));
  if (map !== socketMapName || !address) return "PERM invalid_request";
  const mailbox = (await listMailboxes(env)).find((item) =>
    item.address === address && acceptingMailboxStatuses.has(item.status)
  );
  return mailbox ? `OK ${mailbox.id}` : "NOTFOUND";
}

export async function ingestPostfixMailboxMessage({
  rawMime = Buffer.alloc(0),
  recipient = "",
  sender = "",
  originalRecipient = "",
} = {}, env = process.env) {
  const rcptTo = extractAddress(recipient || originalRecipient);
  if (!rcptTo) {
    const error = new Error("mailbox_recipient_required");
    error.statusCode = 400;
    throw error;
  }
  const source = Buffer.isBuffer(rawMime) ? rawMime : Buffer.from(rawMime || "");
  return ingestMailboxMessage({
    recipient: rcptTo,
    rawMime: source,
    sizeBytes: source.length,
    envelope: {
      rcptTo,
      mailFrom: extractAddress(sender) || String(sender || "").trim(),
      originalRecipient: extractAddress(originalRecipient),
    },
    ingestAdapter: "postfix-socketmap",
  }, env);
}
