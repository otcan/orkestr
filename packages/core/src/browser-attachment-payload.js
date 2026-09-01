const payloadMagic = "ORKESTR-ATTACHMENT-PAYLOAD/1";
const maximumHeaderBytes = 64 * 1024;

function safeFilename(value) {
  const filename = String(value || "attachment")
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return filename.slice(0, 240) || "attachment";
}

function safeMimetype(value) {
  const mimetype = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimetype)
    ? mimetype
    : "application/octet-stream";
}

function equalHex(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function sha256Hex(bytes) {
  const input = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function decodeOrkestrAttachmentPayload(value) {
  const bytes = new Uint8Array(value);
  const newline = 0x0a;
  const firstNewline = bytes.indexOf(newline);
  const secondNewline = firstNewline >= 0 ? bytes.indexOf(newline, firstNewline + 1) : -1;
  if (firstNewline < 0 || secondNewline < 0) throw new Error("attachment_payload_invalid");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (decoder.decode(bytes.subarray(0, firstNewline)) !== payloadMagic) {
    throw new Error("attachment_payload_format_unsupported");
  }
  const headerLengthText = decoder.decode(bytes.subarray(firstNewline + 1, secondNewline));
  if (!/^[1-9][0-9]*$/.test(headerLengthText)) throw new Error("attachment_payload_header_invalid");
  const headerLength = Number(headerLengthText);
  const headerStart = secondNewline + 1;
  const contentStart = headerStart + headerLength;
  if (!Number.isSafeInteger(headerLength) || headerLength > maximumHeaderBytes || contentStart > bytes.length) {
    throw new Error("attachment_payload_header_invalid");
  }

  let metadata;
  try {
    metadata = JSON.parse(decoder.decode(bytes.subarray(headerStart, contentStart)));
  } catch {
    throw new Error("attachment_payload_metadata_invalid");
  }
  if (!metadata || typeof metadata !== "object" || metadata.version !== 1) {
    throw new Error("attachment_payload_metadata_invalid");
  }
  const content = bytes.slice(contentStart);
  const expectedSize = Number(metadata.plaintextSize);
  const expectedChecksum = String(metadata.plaintextChecksum || "").toLowerCase();
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize !== content.byteLength) {
    throw new Error("attachment_payload_size_mismatch");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedChecksum) || !equalHex(await sha256Hex(content), expectedChecksum)) {
    throw new Error("attachment_payload_checksum_mismatch");
  }
  return {
    filename: safeFilename(metadata.filename),
    mimetype: safeMimetype(metadata.mimetype),
    bytes: content,
  };
}
