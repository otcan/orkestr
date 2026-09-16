import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import {
  maximumHeaderBytes,
  payloadMagic,
  safeInboundAttachmentFilename,
  safeInboundAttachmentMimetype,
} from "./browser-inbound-attachment-payload.js";

function clean(value = "") {
  return String(value || "").trim();
}

async function writeChunk(stream, bytes) {
  if (!bytes?.byteLength) return;
  if (!stream.write(Buffer.from(bytes))) await once(stream, "drain");
}

async function endStream(stream) {
  stream.end();
  await once(stream, "finish");
}

function parseHeader(value, expected = {}) {
  let metadata;
  try {
    metadata = JSON.parse(Buffer.from(value).toString("utf8"));
  } catch {
    throw new Error("inbound_upload_metadata_invalid");
  }
  if (!metadata || typeof metadata !== "object" || metadata.version !== 1) throw new Error("inbound_upload_metadata_invalid");
  if (clean(metadata.sessionId) !== clean(expected.sessionId) || clean(metadata.keyId) !== clean(expected.keyId)) {
    throw new Error("inbound_upload_binding_invalid");
  }
  const size = Number(metadata.plaintextSize);
  if (!Number.isSafeInteger(size) || size < 0 || size !== Number(expected.plaintextSize)) {
    throw new Error("inbound_upload_plaintext_size_invalid");
  }
  return {
    filename: safeInboundAttachmentFilename(metadata.filename),
    mimetype: safeInboundAttachmentMimetype(metadata.mimetype),
    plaintextSize: size,
    descriptor: metadata.descriptor && typeof metadata.descriptor === "object" ? metadata.descriptor : null,
  };
}

async function readUntilNewline(reader, state, limit) {
  while (true) {
    const newline = state.buffer.indexOf(0x0a);
    if (newline >= 0) {
      const value = state.buffer.subarray(0, newline);
      state.buffer = state.buffer.subarray(newline + 1);
      return value;
    }
    if (state.buffer.byteLength > limit) throw new Error("inbound_upload_header_invalid");
    const next = await reader.read();
    if (next.done) throw new Error("inbound_upload_payload_truncated");
    state.buffer = Buffer.concat([state.buffer, Buffer.from(next.value)]);
    // A decrypt stream can yield the rest of the file with a short header.
    // Reject only an unterminated line, not valid bytes after its newline.
    const receivedNewline = state.buffer.indexOf(0x0a);
    if (receivedNewline < 0 && state.buffer.byteLength > limit) throw new Error("inbound_upload_header_invalid");
  }
}

async function readExact(reader, state, count) {
  while (state.buffer.byteLength < count) {
    const next = await reader.read();
    if (next.done) throw new Error("inbound_upload_payload_truncated");
    state.buffer = Buffer.concat([state.buffer, Buffer.from(next.value)]);
    if (state.buffer.byteLength > maximumHeaderBytes + count) throw new Error("inbound_upload_header_invalid");
  }
  const output = state.buffer.subarray(0, count);
  state.buffer = state.buffer.subarray(count);
  return output;
}

export async function writeInboundAttachmentPayload(stream, {
  destinationPath,
  sessionId,
  keyId,
  plaintextSize,
  maxPlaintextBytes,
} = {}) {
  if (!stream || !destinationPath) throw new Error("inbound_upload_payload_required");
  const reader = stream.getReader();
  const state = { buffer: Buffer.alloc(0) };
  let output;
  try {
    const magic = (await readUntilNewline(reader, state, 256)).toString("utf8");
    if (magic !== payloadMagic) throw new Error("inbound_upload_payload_format_unsupported");
    const rawLength = (await readUntilNewline(reader, state, 32)).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(rawLength)) throw new Error("inbound_upload_header_invalid");
    const headerLength = Number(rawLength);
    if (!Number.isSafeInteger(headerLength) || headerLength > maximumHeaderBytes) throw new Error("inbound_upload_header_invalid");
    const metadata = parseHeader(await readExact(reader, state, headerLength), { sessionId, keyId, plaintextSize });
    output = createWriteStream(destinationPath, { flags: "wx", mode: 0o600 });
    const digest = createHash("sha256");
    let size = 0;
    const consume = async (chunk) => {
      const bytes = Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxPlaintextBytes || size > metadata.plaintextSize) throw new Error("inbound_upload_plaintext_too_large");
      digest.update(bytes);
      await writeChunk(output, bytes);
    };
    if (state.buffer.byteLength) {
      await consume(state.buffer);
      state.buffer = Buffer.alloc(0);
    }
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      await consume(next.value);
    }
    if (size !== metadata.plaintextSize) throw new Error("inbound_upload_plaintext_size_mismatch");
    await endStream(output);
    output = null;
    return { ...metadata, size, checksum: digest.digest("hex") };
  } finally {
    reader.releaseLock();
    if (output) output.destroy();
  }
}
